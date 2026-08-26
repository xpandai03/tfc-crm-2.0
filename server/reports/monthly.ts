/**
 * Monthly report data layer — TWO populations, and they are not the same query.
 *
 * A — CURRENT SNAPSHOT. Who is active right now. Comes straight from
 *     getDashboardSummary("active"), so the email can never disagree with the
 *     dashboard: there is one aggregation, not two.
 *
 * B — PERIOD RETROSPECTIVE. Every referral RECEIVED in the period, whatever
 *     became of it. This is a COHORT, not a snapshot, and the difference is the
 *     whole point of the section: contacts who have since been scheduled,
 *     declined, or gone unresponsive stay in, because what happened to them is
 *     what the CEO is asking about.
 *
 *     Concretely, for August 2026: 99 referrals received, of which 19 are
 *     already inactive. Running the snapshot query over the period would drop
 *     those 19 with no visible cue — a ~19% undercount that reads as fact.
 *
 * DATE BASIS: sync_contacts.date_added. See DATE_BASIS_NOTE below for why, and
 * for the coverage caveats that ride along with it.
 *
 * READ-ONLY. Every query here is a SELECT.
 */

import { getPool } from "../db/pool";
import { getDashboardSummary, type DashboardSummary } from "../dashboard/db";
import { REFERRAL_REPORT_STATUS_LABELS } from "../sync/db";
import { getStatusBucket, STATUS_BUCKET_LABELS, type StatusBucket } from "@shared/status-buckets";
import { DASHBOARD_LOCATIONS, locationIdForContact } from "@shared/dashboard-locations";
import { SERVICE_TYPE_LABELS, SERVICE_TYPE_COLUMNS, ORIGIN_COLUMNS, ORIGIN_LABELS, type OriginColumn } from "../dashboard/db";

/**
 * WHY sync_contacts.date_added AND NOT form_submissions.created_at
 * ----------------------------------------------------------------
 * Both were checked against production before choosing.
 *
 *   date_added:  1,217 / 1,222 populated (99.6%). The 5 gaps are ALL legacy
 *                sheet-sourced records (legacy 571/576; CRM-era 646/646).
 *                100% ISO YYYY-MM-DD — zero rows fail a strict format check.
 *   agreement:   monthly cohorts agree with the form_submissions basis used by
 *                the existing "Referrals in [month]" card — Jul 114 vs 114,
 *                Aug 99 vs 99, May 128 vs 128. Only Jun differs (149 vs 147).
 *
 * date_added wins on two grounds that matter for a cohort:
 *   1. CONTACT GRAIN. The retrospective needs each referral's current status,
 *      location and insurance, all of which live on sync_contacts.
 *      form_submissions is submission-grain (a re-submitter would double-count;
 *      today 654 submissions map to 654 distinct contacts, so the risk is
 *      latent rather than live).
 *   2. COVERAGE. form_submissions only exists for CRM-era records. Legacy
 *      sheet contacts have no submission row at all, so any period reaching
 *      back before the CRM would silently lose them.
 *
 * CAVEAT, and it is a real one: date_added is RECONSTRUCTED from
 * days_on_waitlist when the source row lacked a date (server/sync/db.ts:97,
 * deriveDateFromDays). Such a value is derived, not recorded, and is not
 * distinguishable after the fact. It affects historical rows far more than
 * recent months. The 5 rows with no date at all are reported as `undated` and
 * are excluded from every period — never silently folded into one.
 */
export const DATE_BASIS_NOTE = "Referrals are counted by their Date Added to Waitlist.";

export interface CohortBreakdown {
  /** label → count. Always includes every column, zero-filled. */
  counts: Record<string, number>;
  other: number;
  unknown: number;
  total: number;
}

export interface MonthlyReport {
  period: string;            // "2026-08"
  periodLabel: string;       // "August 2026"
  periodStart: string;       // "2026-08-01"
  periodEndExclusive: string; // "2026-09-01"
  generatedAt: string;
  /** Population A. */
  snapshot: DashboardSummary;
  /** Population B. */
  cohort: {
    size: number;
    /** Cohort members who are inactive TODAY — invisible to the snapshot query. */
    nowInactive: number;
    nowActive: number;
    /** Currently sitting on status 202. */
    currentlyScheduled: number;
    /** Reached 202 at some point: currently scheduled + initial appt completed. */
    reachedScheduling: number;
    initialApptCompleted: number;
    byStatusBucket: CohortBreakdown;
    byStatusCode: { code: number; label: string; n: number }[];
    byOrigin: CohortBreakdown;
    byServiceType: CohortBreakdown;
    byLocation: CohortBreakdown;
  };
  dataQuality: {
    undatedContacts: number;
    dateBasis: string;
    note: string;
  };
}

const LEGACY_ID_CEILING = 900000;
const INACTIVE_SENTINEL = null; // getStatusBucket returns null for inactive codes

export interface CohortRow {
  modality_p1: string | null;
  modality: string | null;
  status_code: number | null;
  requesting_for: string | null;
  intake_source: string | null;
  legacy_sheet: boolean;
  n: number;
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** "2026-08" → { start: "2026-08-01", endExclusive: "2026-09-01", label: "August 2026" }. */
export function resolvePeriod(period: string): {
  start: string; endExclusive: string; label: string;
} {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) throw new Error(`period must be YYYY-MM, got "${period}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: `${period}-01`,
    endExclusive: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
    label: `${MONTHS[month - 1]} ${year}`,
  };
}

/**
 * The month a report fired on `now` should cover: the PREVIOUS calendar month
 * in America/Denver. A Sept 1 send reports on August.
 *
 * Mountain Time, not UTC — a cron firing at 00:30 MT on the 1st is already the
 * 2nd in UTC, and naive UTC month math would report the wrong month.
 */
export function previousPeriod(now: Date = new Date()): string {
  const mt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver", year: "numeric", month: "2-digit",
  }).format(now); // "YYYY-MM"
  const [y, m] = mt.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

const emptyBreakdown = (columns: readonly string[]): CohortBreakdown => ({
  counts: Object.fromEntries(columns.map((c) => [c, 0])),
  other: 0, unknown: 0, total: 0,
});

function originFor(intakeSource: string | null, legacySheet: boolean): OriginColumn {
  if (intakeSource === "uploaded_referral") return "fax_referral";
  return legacySheet ? "legacy_sheet" : "rfs_form";
}

/** The cohort query. Exported so the pivot can be verified against real rows. */
export const COHORT_SQL = `SELECT
       modality_p1, modality, status_code, requesting_for, intake_source,
       (contact_id < $3) AS legacy_sheet,
       count(*)::int AS n
     FROM sync_contacts
     WHERE date_added >= $1 AND date_added < $2
     GROUP BY 1,2,3,4,5,6`;

export async function buildMonthlyReport(period: string): Promise<MonthlyReport> {
  const { start, endExclusive } = resolvePeriod(period);

  // --- Population A: reuse the dashboard aggregation verbatim ---------------
  const snapshot = await getDashboardSummary("active");

  // --- Population B: the cohort --------------------------------------------
  // Grouped, not row-by-row: this returns aggregate tuples, never a contact.
  const pool = getPool();
  const { rows } = await pool.query<CohortRow>(
    COHORT_SQL, [start, endExclusive, LEGACY_ID_CEILING],
  );

  const undated = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sync_contacts
      WHERE date_added IS NULL OR TRIM(date_added) = ''`,
  );

  return assembleMonthlyReport(period, snapshot, rows, undated.rows[0]?.n ?? 0);
}

/**
 * PURE assembly: grouped cohort rows + a dashboard summary in, report out.
 * No I/O, so the reconciliation self-checks can run this exact code against a
 * real production snapshot instead of a reimplementation.
 */
export function assembleMonthlyReport(
  period: string,
  snapshot: DashboardSummary,
  rows: CohortRow[],
  undatedContacts: number,
): MonthlyReport {
  const { start, endExclusive, label } = resolvePeriod(period);

  const bucketColumns = Object.keys(STATUS_BUCKET_LABELS).concat("inactive");
  const byStatusBucket = emptyBreakdown(bucketColumns);
  const byOrigin = emptyBreakdown(ORIGIN_COLUMNS);
  const byServiceType = emptyBreakdown(SERVICE_TYPE_COLUMNS);
  const byLocation = emptyBreakdown(DASHBOARD_LOCATIONS.map((l) => l.id));
  const statusCodes = new Map<number, number>();

  let size = 0, nowInactive = 0, currentlyScheduled = 0, initialApptCompleted = 0;

  for (const row of rows) {
    const n = row.n;
    size += n;

    // --- status -------------------------------------------------------------
    const bucket: StatusBucket | null = getStatusBucket(row.status_code);
    if (bucket === INACTIVE_SENTINEL) {
      nowInactive += n;
      byStatusBucket.counts.inactive += n;
    } else {
      byStatusBucket.counts[bucket] += n;
    }
    byStatusBucket.total += n;
    if (row.status_code === 202) currentlyScheduled += n;
    if (row.status_code === 205) initialApptCompleted += n;
    if (row.status_code !== null) {
      statusCodes.set(row.status_code, (statusCodes.get(row.status_code) ?? 0) + n);
    }

    // --- origin -------------------------------------------------------------
    byOrigin.counts[originFor(row.intake_source, row.legacy_sheet)] += n;
    byOrigin.total += n;

    // --- service type -------------------------------------------------------
    const svc = (row.requesting_for ?? "").trim();
    if (!svc) byServiceType.unknown += n;
    else if (svc in SERVICE_TYPE_LABELS) byServiceType.counts[svc] += n;
    else byServiceType.other += n;
    byServiceType.total += n;

    // --- location -----------------------------------------------------------
    // Cohort members with an unresolved location belong in the cohort and are
    // bucketed as No Location. They are NOT dropped: unlike the dashboard's
    // active population, a retrospective can legitimately contain Hybrid,
    // generic In-Person and null-P1 records.
    byLocation.counts[locationIdForContact({
      modalityP1: row.modality_p1, modality: row.modality,
    })] += n;
    byLocation.total += n;
  }

  return {
    period, periodLabel: label, periodStart: start, periodEndExclusive: endExclusive,
    generatedAt: new Date().toISOString(),
    snapshot,
    cohort: {
      size,
      nowInactive,
      nowActive: size - nowInactive,
      currentlyScheduled,
      initialApptCompleted,
      reachedScheduling: currentlyScheduled + initialApptCompleted,
      byStatusBucket,
      byStatusCode: Array.from(statusCodes.entries())
        .map(([code, n]) => ({
          code, label: REFERRAL_REPORT_STATUS_LABELS[code] ?? `Status ${code}`, n,
        }))
        .sort((a, b) => b.n - a.n || a.code - b.code),
      byOrigin,
      byServiceType,
      byLocation,
    },
    dataQuality: {
      undatedContacts,
      dateBasis: "sync_contacts.date_added",
      note: DATE_BASIS_NOTE,
    },
  };
}

/** Column label helpers, so the renderers never re-derive them. */
export const COHORT_LABELS = {
  statusBucket: { ...STATUS_BUCKET_LABELS, inactive: "Closed / Inactive" } as Record<string, string>,
  origin: ORIGIN_LABELS as Record<string, string>,
  serviceType: SERVICE_TYPE_LABELS,
  location: Object.fromEntries(DASHBOARD_LOCATIONS.map((l) => [l.id, l.label])),
};
