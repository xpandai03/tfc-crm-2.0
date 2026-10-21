/**
 * Angelica Villicana off the client survey (client, 2026-10-21).
 * ============================================================================
 *
 * ONE-TIME, at boot, never fatal: her "Show on survey" flag becomes false.
 * Guarded by a marker activity row (type provider_survey_visibility_set,
 * reason villicana-hidden-2026-10-21), so when someone ticks the box again on
 * her edit dialog a reboot never unticks it. She stays an active provider:
 * scheduling, matching, the provider list and TherapyNotes ignore the flag.
 *
 * migrations/add-provider-show-on-survey.sql records the same change.
 */

import { getPool } from "../db/pool";

export const VILLICANA_NAME = "Angelica Villicana";
export const VILLICANA_REASON = "villicana-hidden-2026-10-21";

/**
 * "set" (changed now), "already" (the marker exists — never touched again),
 * "absent" (not exactly one provider of that name; nothing written, tried next boot).
 */
export async function applyVillicanaHidden(): Promise<"set" | "already" | "absent"> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const marker = await client.query(
      `SELECT 1 FROM activity_log
        WHERE type = 'provider_survey_visibility_set' AND metadata::jsonb->>'reason' = $1 LIMIT 1`,
      [VILLICANA_REASON],
    );
    if (marker.rowCount) {
      await client.query("COMMIT");
      return "already";
    }
    const found = await client.query(
      `SELECT id, name, show_on_survey FROM crm_providers
        WHERE lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = 'angelica villicana'
        FOR UPDATE`,
    );
    if (found.rowCount !== 1) {
      await client.query("ROLLBACK");
      console.warn(`[survey-visibility] skipped: ${found.rowCount} provider rows named ${VILLICANA_NAME}`);
      return "absent";
    }
    const p = found.rows[0] as { id: number; name: string; show_on_survey: boolean | null };
    const before = p.show_on_survey !== false;
    await client.query(
      `UPDATE crm_providers SET show_on_survey = false, updated_at = NOW() WHERE id = $1`,
      [p.id],
    );
    await client.query(
      `INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
       VALUES ('provider_survey_visibility_set', 'system', 'provider', $1, $2, $3)`,
      [String(p.id), p.name, JSON.stringify({ from: before, to: false, reason: VILLICANA_REASON })],
    );
    await client.query("COMMIT");
    console.log(`[survey-visibility] provider ${p.id} show_on_survey ${before} -> false (one time)`);
    return "set";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[survey-visibility] FAILED: ${e instanceof Error ? e.message : "unknown"}`);
    return "absent";
  } finally {
    client.release();
  }
}
