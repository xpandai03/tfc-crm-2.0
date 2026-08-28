/**
 * Management dashboard API client + payload types.
 *
 * The types mirror server/dashboard/db.ts. They are declared here rather than
 * imported from the server module because the server module imports `pg`, which
 * must never reach the browser bundle.
 */

export type Population = "active" | "all";
/** Per-card scope from the Aug 26 review. Card 1 is excluded from this toggle. */
export type CardScope = "pipeline" | "waitlist";

export interface DashboardLocation {
  id: string;
  label: string;
  modalityP1: string | null;
  locationAgnostic?: boolean;
  residual?: boolean;
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

/** A cross-tab row keyed by something other than location (Card 5). */
export interface KeyedCrossTabRow {
  key: string;
  label: string;
  counts: Record<string, number>;
  other: number;
  unknown: number;
  total: number;
}

export interface CrossTabSet {
  counted: number;
  byServiceType: { columns: string[]; labels: Record<string, string>; rows: CrossTabRow[]; totals: CrossTabRow };
  byInsurance: { columns: string[]; rows: CrossTabRow[]; totals: CrossTabRow; otherSummary: { distinctValues: number } };
  byOrigin: { columns: string[]; labels: Record<string, string>; rows: OriginRow[]; totals: OriginRow };
  byServiceTypeInsurance: {
    columns: string[];
    rows: KeyedCrossTabRow[];
    totals: KeyedCrossTabRow;
    otherSummary: { distinctValues: number };
  };
}

/** One row of the Other / Unmapped modal. RAW insurance value — modal only. */
export interface UnmappedInsuranceContact {
  contactId: number;
  name: string;
  insurancePayer: string;
  locationId: string;
  serviceType: string | null;
  statusBucket: string | null;
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
  locations: DashboardLocation[];
  byStatus: {
    buckets: string[];
    labels: Record<string, string>;
    rows: StatusRow[];
    totals: StatusRow;
  };
  byServiceType: {
    columns: string[];
    labels: Record<string, string>;
    rows: CrossTabRow[];
    totals: CrossTabRow;
  };
  byInsurance: {
    columns: string[];
    rows: CrossTabRow[];
    totals: CrossTabRow;
    otherSummary: { distinctValues: number };
  };
  byOrigin: {
    columns: string[];
    labels: Record<string, string>;
    rows: OriginRow[];
    totals: OriginRow;
  };
  scopes: Record<CardScope, CrossTabSet>;
  dataQuality: {
    nonCanonicalInsurance: number;
    nonCanonicalServiceType: number;
    nullModalityP1: number;
    unreconciledRows: string[];
    note: string;
  };
}

export async function getDashboardSummary(population: Population): Promise<DashboardSummary> {
  const res = await fetch(`/api/dashboard/summary?population=${population}`, {
    credentials: "include",
  });
  if (res.status === 403) throw new Error("You don’t have access to the management dashboard.");
  if (!res.ok) throw new Error("Failed to load dashboard");
  return res.json();
}

/**
 * Contacts behind an "Other / Unmapped" insurance segment.
 * Returns raw stored values — render in the modal only, never a chart surface.
 */
export async function getUnmappedInsuranceContacts(
  scope: CardScope,
): Promise<UnmappedInsuranceContact[]> {
  const res = await fetch(`/api/dashboard/unmapped-insurance?scope=${scope}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to load unmapped insurance contacts");
  const data = await res.json();
  return data.contacts ?? [];
}
