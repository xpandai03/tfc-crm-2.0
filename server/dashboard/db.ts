/**
 * Management dashboard aggregation.
 *
 * ONE QUERY, ONE SNAPSHOT
 * -----------------------
 * Every card is pivoted from a single GROUP BY rather than one query per card.
 * That is not a micro-optimisation: separate queries are separate snapshots, so
 * a status change landing between them would let the status card and the
 * insurance card disagree about how many active contacts exist. The whole point
 * of this page is that its numbers reconcile, so they are all derived from one
 * read.
 *
 * The grouped tuple collapses 1,222 rows to a few hundred, and the pivot is
 * plain arithmetic in Node. Measured against production: ~60-70 ms.
 *
 * NOT reusing computeInsightsMetrics() (server/pdf/insights-template.ts) — it
 * buckets the RAW `modality` and `insurance_payer` strings instead of going
 * through getPrimaryModality()/canonical matching, so its breakdowns already
 * disagree with the Insights page. It is a known-wrong module; building on it
 * would inherit the defect.
 *
 * READ-ONLY. This module issues exactly one SELECT and never writes.
 */

import { getPool } from "../db/pool";
import {
  STATUS_BUCKETS,
  STATUS_BUCKET_LABELS,
  PIPELINE_BUCKETS,
  getStatusBucket,
  assertBucketCoverage,
  type StatusBucket,
} from "@shared/status-buckets";
import {
  DASHBOARD_LOCATIONS,
  locationIdForContact,
  type DashboardLocation,
} from "@shared/dashboard-locations";
import { CANONICAL_INSURANCES, isCanonicalInsurance } from "@shared/insurance";
import { SERVICE_TYPES } from "@shared/service-types";

export type Population = "active" | "all";

/**
 * Friendly service-type labels. DISPLAY ONLY — the stored values are never
 * rewritten (shared/service-types.ts: "Values are stored VERBATIM").
 *
 * The canonical value "Other" is deliberately absent: it holds zero records and
 * a column headed "Other" sitting beside the "Other / Unmapped" column would be
 * unreadable. It falls into `other` instead, which is semantically correct.
 */
export const SERVICE_TYPE_LABELS: Record<string, string> = {
  "Myself": "Individual",
  "My Child": "Child",
  "My Partner & Myself": "Couple",
  "My Family": "Family",
};

/** Service-type values that get their own column, in display order. */
export const SERVICE_TYPE_COLUMNS: readonly string[] = SERVICE_TYPES.filter(
  (s) => s in SERVICE_TYPE_LABELS,
);

/** Origin categories. The partition is total — every row lands in exactly one. */
export const ORIGIN_COLUMNS = ["rfs_form", "fax_referral", "legacy_sheet"] as const;
export type OriginColumn = (typeof ORIGIN_COLUMNS)[number];

export const ORIGIN_LABELS: Record<OriginColumn, string> = {
  rfs_form: "Online RFS Form",
  fax_referral: "Fax Referral",
  legacy_sheet: "Pre-CRM Record",
};

/**
 * Contact ids below this came from the legacy spreadsheet sync; CRM-era records
 * are allocated from 900000 up. Corroborated independently by
 * source_submission_id, which is NULL for exactly the same 576 rows.
 */
const LEGACY_ID_CEILING = 900000;

interface GroupRow {
  modality_p1: string | null;
  modality: string | null;
  status_code: number | null;
  requesting_for: string | null;
  insurance_payer: string | null;
  intake_source: string | null;
  legacy_sheet: boolean;
  n: number;
}

export interface StatusRow {
  location: string;
  waitlist: number;
  pending: number;
  scheduled: number;
  otherActive: number;
  pipeline: number;
  active: number;
  inactive: number;
  total: number;
}

export interface CrossTabRow {
  location: string;
  counts: Record<string, number>;
  other: number;
  unknown: number;
  total: number;
}

export interface OriginRow {
  location: string;
  rfs_form: number;
  fax_referral: number;
  legacy_sheet: number;
  total: number;
}

export interface DashboardSummary {
  generatedAt: string;
  population: Population;
  queryMs: number;
  totals: {
    all: number;
    active: number;
    pipeline: number;
    otherActive: number;
    counted: number;
  };
  locations: readonly DashboardLocation[];
  byStatus: {
    buckets: readonly StatusBucket[];
    labels: Record<string, string>;
    rows: StatusRow[];
    totals: StatusRow;
  };
  byServiceType: {
    columns: readonly string[];
    labels: Record<string, string>;
    rows: CrossTabRow[];
    totals: CrossTabRow;
  };
  byInsurance: {
    columns: readonly string[];
    rows: CrossTabRow[];
    totals: CrossTabRow;
    /**
     * COUNT ONLY — never the raw values. insurance_payer is free text and
     * production contains at least one entry with a patient name and DOB typed
     * into it, so rendering the distinct values would put PHI on the page.
     */
    otherSummary: { distinctValues: number };
  };
  byOrigin: {
    columns: readonly OriginColumn[];
    labels: Record<string, string>;
    rows: OriginRow[];
    totals: OriginRow;
  };
  dataQuality: {
    nonCanonicalInsurance: number;
    nonCanonicalServiceType: number;
    nullModalityP1: number;
    unreconciledRows: string[];
    note: string;
  };
}

const emptyStatusRow = (location: string): StatusRow => ({
  location, waitlist: 0, pending: 0, scheduled: 0, otherActive: 0,
  pipeline: 0, active: 0, inactive: 0, total: 0,
});

const emptyCrossTabRow = (location: string, columns: readonly string[]): CrossTabRow => ({
  location,
  counts: Object.fromEntries(columns.map((c) => [c, 0])),
  other: 0, unknown: 0, total: 0,
});

const emptyOriginRow = (location: string): OriginRow => ({
  location, rfs_form: 0, fax_referral: 0, legacy_sheet: 0, total: 0,
});

/** Which origin category a row belongs to. Total partition — never null. */
function originFor(intakeSource: string | null, legacySheet: boolean): OriginColumn {
  if (intakeSource === "uploaded_referral") return "fax_referral";
  return legacySheet ? "legacy_sheet" : "rfs_form";
}

/** The one SELECT. Exported so the pivot can be verified against real rows. */
export const DASHBOARD_GROUP_SQL = `SELECT
       modality_p1,
       modality,
       status_code,
       requesting_for,
       insurance_payer,
       intake_source,
       (contact_id < $1) AS legacy_sheet,
       count(*)::int AS n
     FROM sync_contacts
     GROUP BY 1,2,3,4,5,6,7`;

/**
 * Build the whole dashboard payload.
 *
 * `population` selects which contacts are COUNTED. "active" (the default) is
 * every contact in a status bucket — matching the waitlist's hideInactive
 * default so the two surfaces agree. "all" counts every contact, at which point
 * the residual "No Location" row becomes non-zero.
 */
export async function getDashboardSummary(population: Population): Promise<DashboardSummary> {
  const t0 = Date.now();
  const { rows } = await getPool().query<GroupRow>(DASHBOARD_GROUP_SQL, [LEGACY_ID_CEILING]);
  return pivotDashboard(rows, population, Date.now() - t0);
}

/**
 * PURE pivot: grouped rows in, payload out. No I/O.
 *
 * Split from the query so the reconciliation self-checks can run the REAL
 * production code against a real snapshot of production rows, rather than a
 * reimplementation that could agree with itself while both are wrong.
 */
export function pivotDashboard(
  rows: GroupRow[],
  population: Population,
  queryMs = 0,
): DashboardSummary {
  assertBucketCoverage();

  const locationIds = DASHBOARD_LOCATIONS.map((l) => l.id);
  const insuranceColumns = [...CANONICAL_INSURANCES];

  const statusRows = new Map(locationIds.map((id) => [id, emptyStatusRow(id)]));
  const serviceRows = new Map(locationIds.map((id) => [id, emptyCrossTabRow(id, SERVICE_TYPE_COLUMNS)]));
  const insuranceRows = new Map(locationIds.map((id) => [id, emptyCrossTabRow(id, insuranceColumns)]));
  const originRows = new Map(locationIds.map((id) => [id, emptyOriginRow(id)]));

  const legacyInsurance = new Map<string, number>();
  let totalAll = 0, totalActive = 0, nullP1 = 0;
  let nonCanonicalInsurance = 0, nonCanonicalServiceType = 0;

  for (const row of rows) {
    const n = row.n;
    totalAll += n;
    if (row.modality_p1 === null) nullP1 += n;

    const bucket = getStatusBucket(row.status_code);
    const isActive = bucket !== null;
    if (isActive) totalActive += n;

    // P1-only, with getPrimaryModality's legacy fallback for the 72 null rows.
    const locationId = locationIdForContact({
      modalityP1: row.modality_p1,
      modality: row.modality,
    });

    // The status card always reports the full picture for its row so that
    // active + inactive = total holds in both population modes.
    const sRow = statusRows.get(locationId)!;
    sRow.total += n;
    if (bucket) {
      sRow[bucket] += n;
      sRow.active += n;
      if ((PIPELINE_BUCKETS as readonly string[]).includes(bucket)) sRow.pipeline += n;
    } else {
      sRow.inactive += n;
    }

    // Cards 2-4 count only the selected population.
    if (population === "active" && !isActive) continue;

    // --- Service type -------------------------------------------------------
    const svcRow = serviceRows.get(locationId)!;
    const svc = (row.requesting_for ?? "").trim();
    if (!svc) {
      svcRow.unknown += n;
    } else if (svc in SERVICE_TYPE_LABELS) {
      svcRow.counts[svc] += n;
    } else {
      svcRow.other += n;
      nonCanonicalServiceType += n;
    }
    svcRow.total += n;

    // --- Insurance ----------------------------------------------------------
    const insRow = insuranceRows.get(locationId)!;
    const ins = (row.insurance_payer ?? "").trim();
    if (!ins) {
      insRow.unknown += n;
    } else if (isCanonicalInsurance(ins)) {
      insRow.counts[ins] += n;
    } else {
      // Legacy spelling: matches no canonical column. Counted honestly in
      // `other` rather than silently dropped. NOT remapped — shared/insurance.ts
      // is explicit that remapping legacy payers is the client's data decision.
      insRow.other += n;
      nonCanonicalInsurance += n;
      legacyInsurance.set(ins, (legacyInsurance.get(ins) ?? 0) + n);
    }
    insRow.total += n;

    // --- Origin -------------------------------------------------------------
    const oRow = originRows.get(locationId)!;
    oRow[originFor(row.intake_source, row.legacy_sheet)] += n;
    oRow.total += n;
  }

  // ---- Column totals -------------------------------------------------------
  const sumStatus = (): StatusRow => {
    const t = emptyStatusRow("__total__");
    for (const r of Array.from(statusRows.values())) {
      for (const b of STATUS_BUCKETS) t[b] += r[b];
      t.pipeline += r.pipeline; t.active += r.active;
      t.inactive += r.inactive; t.total += r.total;
    }
    return t;
  };
  const sumCrossTab = (m: Map<string, CrossTabRow>, columns: readonly string[]): CrossTabRow => {
    const t = emptyCrossTabRow("__total__", columns);
    for (const r of Array.from(m.values())) {
      for (const c of columns) t.counts[c] += r.counts[c];
      t.other += r.other; t.unknown += r.unknown; t.total += r.total;
    }
    return t;
  };
  const sumOrigin = (): OriginRow => {
    const t = emptyOriginRow("__total__");
    for (const r of Array.from(originRows.values())) {
      for (const c of ORIGIN_COLUMNS) t[c] += r[c];
      t.total += r.total;
    }
    return t;
  };

  const statusTotals = sumStatus();
  const serviceTotals = sumCrossTab(serviceRows, SERVICE_TYPE_COLUMNS);
  const insuranceTotals = sumCrossTab(insuranceRows, insuranceColumns);
  const originTotals = sumOrigin();

  // ---- Self-check: every row's parts must sum to its total ------------------
  // Surfaced in the payload rather than thrown: a reconciliation failure should
  // be VISIBLE on the page (that is the page's entire purpose), not a 500.
  const unreconciled: string[] = [];
  for (const [id, r] of Array.from(statusRows)) {
    if (r.waitlist + r.pending + r.scheduled + r.otherActive !== r.active) {
      unreconciled.push(`byStatus/${id}: buckets != active`);
    }
    if (r.active + r.inactive !== r.total) unreconciled.push(`byStatus/${id}: active+inactive != total`);
  }
  const checkCrossTab = (label: string, m: Map<string, CrossTabRow>, columns: readonly string[]) => {
    for (const [id, r] of Array.from(m)) {
      const sum = columns.reduce((a, c) => a + r.counts[c], 0) + r.other + r.unknown;
      if (sum !== r.total) unreconciled.push(`${label}/${id}: cells(${sum}) != total(${r.total})`);
    }
  };
  checkCrossTab("byServiceType", serviceRows, SERVICE_TYPE_COLUMNS);
  checkCrossTab("byInsurance", insuranceRows, insuranceColumns);
  for (const [id, r] of Array.from(originRows)) {
    const sum = ORIGIN_COLUMNS.reduce((a, c) => a + r[c], 0);
    if (sum !== r.total) unreconciled.push(`byOrigin/${id}: cells(${sum}) != total(${r.total})`);
  }

  const counted = population === "active" ? totalActive : totalAll;

  return {
    generatedAt: new Date().toISOString(),
    population,
    queryMs,
    totals: {
      all: totalAll,
      active: totalActive,
      pipeline: statusTotals.pipeline,
      otherActive: statusTotals.otherActive,
      counted,
    },
    locations: DASHBOARD_LOCATIONS,
    byStatus: {
      buckets: STATUS_BUCKETS,
      labels: STATUS_BUCKET_LABELS,
      rows: locationIds.map((id) => statusRows.get(id)!),
      totals: statusTotals,
    },
    byServiceType: {
      columns: SERVICE_TYPE_COLUMNS,
      labels: SERVICE_TYPE_LABELS,
      rows: locationIds.map((id) => serviceRows.get(id)!),
      totals: serviceTotals,
    },
    byInsurance: {
      columns: insuranceColumns,
      rows: locationIds.map((id) => insuranceRows.get(id)!),
      totals: insuranceTotals,
      otherSummary: { distinctValues: legacyInsurance.size },
    },
    byOrigin: {
      columns: ORIGIN_COLUMNS,
      labels: ORIGIN_LABELS,
      rows: locationIds.map((id) => originRows.get(id)!),
      totals: originTotals,
    },
    dataQuality: {
      nonCanonicalInsurance,
      nonCanonicalServiceType,
      nullModalityP1: nullP1,
      unreconciledRows: unreconciled,
      note: "Counts are per contact, by first-choice modality (P1) only.",
    },
  };
}
