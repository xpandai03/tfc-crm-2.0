/**
 * Public provider roster for the survey's therapist question.
 * ============================================================================
 *
 * A DELIBERATELY SEPARATE QUERY. GET /api/providers (server/routes.ts:3073)
 * returns full provider records — specialties, insurances, age-group skill
 * matrices, internal notes and the email axis used for CC resolution — and
 * getAllCrmProviders() (server/reminders/db.ts:541) selects all of it. That is
 * a staff-facing shape. This endpoint is reachable by anyone with the link, and
 * CORS on this app is wildcard-open (server/index.ts:45-54), so it is readable
 * from any origin.
 *
 * So this selects four columns (survey_locations only to expand the list) and
 * nothing else, with its own SQL rather than
 * a projection over the staff query — a later column added to CrmProvider then
 * cannot leak here by inheritance.
 */

import { getPool } from "../db/pool";
import { surveyOfficeRank, surveyOfficesFor, surveyProviderLabel } from "@shared/survey-locations";

export interface PublicProviderEntry {
  /** Rendered to the client exactly as the source form does: "Name (LOCATION)". */
  label: string;
  name: string;
  credentials: string;
  location: string;
}

/**
 * Active providers, name-ordered — the same ordering the TherapyNotes form
 * used, so the list a client sees is in the order the practice expects.
 *
 * ONE ENTRY PER SURVEY OFFICE (shared/survey-locations.ts). A therapist seen at
 * two offices is offered twice, "Name (ABQ)" and "Name (LL)", so the stored
 * answer says which office the client saw them at. Everyone else is offered
 * once, under survey_locations if set, else under location — unchanged.
 */
export async function getPublicProviderRoster(): Promise<PublicProviderEntry[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT name, credentials, location, survey_locations
    FROM crm_providers
    WHERE is_active = true
    ORDER BY name ASC
  `);

  return rosterEntriesFromRows(result.rows);
}

export interface ProviderRosterRow {
  name: string;
  credentials: string | null;
  location: string | null;
  survey_locations: string[] | null;
}

/** The pure half: provider rows → dropdown entries, one per survey office. */
export function rosterEntriesFromRows(rows: ProviderRosterRow[]): PublicProviderEntry[] {
  const out: PublicProviderEntry[] = [];
  for (const row of rows) {
    const name = (row.name ?? "").trim();
    if (name.length === 0) continue;
    const credentials = (row.credentials ?? "").trim();
    const offices = surveyOfficesFor(row.location, row.survey_locations);
    const ordered = offices.slice().sort((a, b) => surveyOfficeRank(a) - surveyOfficeRank(b));
    if (ordered.length === 0) ordered.push("");
    for (const location of ordered) {
      out.push({ label: surveyProviderLabel(name, location), name, credentials, location });
    }
  }
  return out;
}
