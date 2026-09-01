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
 * So this selects three columns and nothing else, with its own SQL rather than
 * a projection over the staff query — a later column added to CrmProvider then
 * cannot leak here by inheritance.
 */

import { getPool } from "../db/pool";

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
 */
export async function getPublicProviderRoster(): Promise<PublicProviderEntry[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT name, credentials, location
    FROM crm_providers
    WHERE is_active = true
    ORDER BY name ASC
  `);

  return result.rows.map((row: { name: string; credentials: string | null; location: string | null }) => {
    const name = (row.name ?? "").trim();
    const credentials = (row.credentials ?? "").trim();
    const location = (row.location ?? "").trim();
    return {
      label: location ? `${name} (${location})` : name,
      name,
      credentials,
      location,
    };
  }).filter((p: PublicProviderEntry) => p.name.length > 0);
}
