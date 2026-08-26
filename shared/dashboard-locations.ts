/**
 * Clinic location, derived from modality priority-1.
 *
 * THERE IS NO LOCATION COLUMN. The full sync_contacts schema carries the
 * CLIENT's address (city/state/zip/county) and nothing about which office they
 * would attend. Location is therefore derived, and modality P1 is the only
 * field that carries it.
 *
 * WHY A LOOKUP TABLE AND NOT A PARSE
 * ----------------------------------
 * Location is not deterministically parseable out of a modality string:
 * "Hybrid" and "Flex" name no office at all, and the canonical buckets are
 * abbreviations ("In Person ABQ") rather than city names. But P1 values are
 * ALREADY normalized by modality-utils into a closed 7-value set, so the table
 * below is small, total, and stable — it maps a fixed enum, not free text.
 *
 * P1-ONLY, ALWAYS
 * ---------------
 * Callers must resolve a contact's bucket through getPrimaryModality() and pass
 * the result here. Never read modality_p1 off the row directly: it is NULL on
 * 72 historical records, and getPrimaryModality falls back to parsing the legacy
 * `modality` string for exactly those. Matching ANY of p1..p4 would return a
 * contact under every office they would attend, which is the double-counting the
 * July modality work removed (see shared/modality-utils.ts).
 *
 * ADDING A FOURTH CLINIC is an edit to DASHBOARD_LOCATIONS alone. The endpoint
 * returns this array as data and every client component renders whatever it
 * receives, so no component hardcodes a location and no layout assumes a count.
 */

import { getPrimaryModality, type ModalityPriorityFields } from "./modality-utils";

export interface DashboardLocation {
  /** Stable key used in API payloads and as a React key. Never displayed. */
  id: string;
  /** Column/row header text. */
  label: string;
  /** The canonical modality P1 bucket that maps here, or null for the residual. */
  modalityP1: string | null;
  /**
   * Telehealth: a real, counted population that is not a physical office.
   * Flagged so the UI can annotate it rather than imply a building exists.
   */
  locationAgnostic?: boolean;
  /**
   * The catch-all row. Holds Hybrid, generic "In Person", and unresolved P1.
   * Zero ACTIVE contacts today (all 261 such records are inactive) but it is
   * always present in the payload and becomes non-zero at population=all.
   */
  residual?: boolean;
}

/** Display order. The residual row sorts last on purpose. */
export const DASHBOARD_LOCATIONS: readonly DashboardLocation[] = [
  { id: "abq", label: "Albuquerque", modalityP1: "In Person ABQ" },
  { id: "rr", label: "Rio Rancho", modalityP1: "In Person RR" },
  { id: "ll", label: "Los Lunas", modalityP1: "In Person LL" },
  { id: "th", label: "Telehealth", modalityP1: "Telehealth", locationAgnostic: true },
  { id: "none", label: "No Location", modalityP1: null, residual: true },
];

/** The residual bucket id. Anything unmapped lands here rather than vanishing. */
export const RESIDUAL_LOCATION_ID = "none";

/** modality P1 bucket → location id. Built from the table above, not repeated. */
const P1_TO_LOCATION: Record<string, string> = Object.fromEntries(
  DASHBOARD_LOCATIONS.filter((l) => l.modalityP1 !== null).map((l) => [l.modalityP1 as string, l.id]),
);

/**
 * Location id for an already-resolved modality bucket.
 * Unmapped buckets ("Hybrid", "In Person", "Flex", "Unknown") → residual.
 */
export function locationIdForModality(bucket: string | null | undefined): string {
  if (!bucket) return RESIDUAL_LOCATION_ID;
  return P1_TO_LOCATION[bucket] ?? RESIDUAL_LOCATION_ID;
}

/**
 * THE accessor: a contact's location id, resolved P1-only with the legacy
 * fallback that getPrimaryModality provides. Use this, not the raw column.
 */
export function locationIdForContact(c: ModalityPriorityFields): string {
  return locationIdForModality(getPrimaryModality(c));
}

/** Lookup by id, for rendering a row whose label the client didn't ship. */
export function getLocationById(id: string): DashboardLocation | undefined {
  return DASHBOARD_LOCATIONS.find((l) => l.id === id);
}
