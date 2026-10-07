/**
 * TherapyNotes patients, grouped into PEOPLE.
 * ============================================================================
 *
 * WHY. The nightly pull reads one page per clinician, and every row carries a
 * chart id. The pull folded rows by that id, assuming it named the record. It
 * does not: the id changes between page loads (agent recon, 2026-10-01), so a
 * patient seen by two clinicians arrives as two rows with two ids — and on
 * 2026-10-07 not one of 1,016 rows carried more than one clinician. The matcher
 * then saw two people agreeing on name and date of birth, sent their surveys to
 * review as ambiguous, and staff were asked to merge charts that are one chart.
 *
 * THE KEY IS THE PERSON: legal name + date of birth. Grouped at READ time
 * (getTnPatientGroups), not at pull time: the table keeps exactly what the pull
 * saw, the rule can change without a re-pull, and grouping ~1,000 rows is a
 * single pass measured in single-digit milliseconds (scripts/test-tn-patient-
 * groups.ts times it). Chart ids are kept per group as ADVISORY only.
 *
 * A TRUE DUPLICATE is two rows with the same key under the SAME clinician:
 * TherapyNotes really holds two records for that person in one caseload.
 * Same key under different clinicians is one patient in shared care.
 *
 * Pure: no database, no logging. Nothing here is ever logged — it is identity.
 */
import { patientKey } from "../survey/matching";

export { legalNameKey, patientKey } from "../survey/matching";

export interface TnPatientRowInput {
  chartId: string;
  name: string;
  dob: string;
  phone: string;
  clinicians: string[];
}

export interface TnPatientGroup {
  /** legal name + DOB; `chart:<id>` for a row whose name or DOB cannot key. */
  patientKey: string;
  /** The first row's rendering. Rows of one person render the same. */
  name: string;
  dob: string;
  /** Every distinct phone across the rows, first-seen order. */
  phones: string[];
  /** Union of the rows' clinicians, first-seen order. */
  clinicians: string[];
  /** Every row's chart id. ADVISORY: ids are not stable between page loads. */
  chartIds: string[];
  /** Clinicians this person appears under on more than one row: a true duplicate. */
  duplicateClinicians: string[];
  rowCount: number;
}

export function groupTnPatients(rows: TnPatientRowInput[]): TnPatientGroup[] {
  const groups = new Map<string, TnPatientGroup>();
  for (const r of rows) {
    const key = patientKey(r.name, r.dob) ?? `chart:${r.chartId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        patientKey: key, name: r.name, dob: r.dob, phones: [], clinicians: [],
        chartIds: [], duplicateClinicians: [], rowCount: 0,
      };
      groups.set(key, g);
    }
    g.rowCount += 1;
    if (r.chartId && !g.chartIds.includes(r.chartId)) g.chartIds.push(r.chartId);
    const phone = (r.phone ?? "").trim();
    if (phone && !g.phones.includes(phone)) g.phones.push(phone);
    for (const c of r.clinicians ?? []) {
      if (!c) continue;
      if (g.clinicians.includes(c)) {
        if (!g.duplicateClinicians.includes(c)) g.duplicateClinicians.push(c);
      } else {
        g.clinicians.push(c);
      }
    }
  }
  return Array.from(groups.values());
}
