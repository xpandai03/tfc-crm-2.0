/**
 * Amanda Plotner: every survey under Los Lunas "for now" (client, 2026-10-15).
 * ============================================================================
 *
 * The practice wants all of her surveys to count under LL, including the ones
 * labelled ABQ since she was given a second office on 2026-10-06. Two steps,
 * both at boot, both never fatal:
 *
 *   1. ONE-TIME: her survey office set becomes {LL}. Guarded by a marker
 *      activity row (type provider_survey_offices_set, reason
 *      plotner-ll-only-2026-10-15) so that when ABQ is added back later — "when
 *      she starts ABQ clients" — a reboot never undoes it. With her set at {LL}
 *      the general single-office rule (corp-labels.ts) stores every NEW survey
 *      "Amanda Plotner (LL)".
 *   2. BACKFILL, only WHILE her set is exactly {LL}: every survey of hers
 *      labelled ABQ is relabelled LL, one survey_relabelled activity row each
 *      (ids and offices, never the client). Idempotent: an LL row is never
 *      selected. Once ABQ is back in her set the statement selects nothing, so
 *      a genuine ABQ survey from then on keeps its label.
 *
 * migrations/backfill-plotner-ll.sql is step 2 verbatim; *.sql is kept out of
 * the image, so boot carries it here (as corp-labels.ts does).
 */

import { getPool } from "../db/pool";

export const PLOTNER_NAME = "Amanda Plotner";
export const PLOTNER_REASON = "plotner-ll-only-2026-10-15";

/** Her surveys with the office their label carries ("" when none). */
const TARGETS_CTE = `WITH plotner AS (
  SELECT 'Amanda Plotner'::text AS name
),
surveys AS MATERIALIZED (
  SELECT id, payload::jsonb AS doc
  FROM form_submissions
  WHERE form_type = 'survey'
),
targets AS (
  SELECT s.id, s.doc, p.name,
         upper(trim(substring(s.doc->'answers'->>'therapist' from '\\(([^()]*)\\)\\s*$'))) AS old_office
  FROM surveys s
  JOIN plotner p
    ON lower(regexp_replace(trim(regexp_replace(s.doc->'answers'->>'therapist', '\\s*\\([^()]*\\)\\s*$', '')), '\\s+', ' ', 'g'))
     = lower(p.name)
  WHERE jsonb_typeof(s.doc->'answers'->'therapist') = 'string'
)`;

/** Verbatim the body of migrations/backfill-plotner-ll.sql. */
export const PLOTNER_BACKFILL_SQL = `${TARGETS_CTE},
ll_only AS (
  SELECT 1 FROM crm_providers
   WHERE lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = 'amanda plotner'
     AND survey_locations = ARRAY['LL']::text[]
),
changed AS (
  UPDATE form_submissions f
     SET payload = jsonb_set(t.doc, '{answers,therapist}', to_jsonb(t.name || ' (LL)'))::text
    FROM targets t
   WHERE f.id = t.id
     AND t.old_office = 'ABQ'
     AND EXISTS (SELECT 1 FROM ll_only)
  RETURNING f.id, t.name, t.old_office
)
INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
SELECT 'survey_relabelled', 'system', 'submission', id::text, 'Client survey',
       json_build_object(
         'submissionId', id,
         'provider', name,
         'from', old_office,
         'to', 'LL',
         'reason', 'plotner-ll-only-2026-10-15'
       )::text
FROM changed
RETURNING entity_id;`;

const COUNT_SQL = `${TARGETS_CTE}
SELECT COALESCE(old_office, '') AS office, COUNT(*)::int AS n
FROM targets
GROUP BY 1
ORDER BY 1`;

export interface OfficeCount { office: string; n: number }

/** Her surveys by the office their label carries. */
export async function countPlotnerLabels(): Promise<OfficeCount[]> {
  const { rows } = await getPool().query(COUNT_SQL);
  return rows as OfficeCount[];
}

const describe = (counts: OfficeCount[]) =>
  counts.map((c) => `${c.office || "(none)"}=${c.n}`).join(", ") || "none";

/**
 * Step 1. Sets her survey offices to {LL} once. Returns what happened:
 * "set" (changed now), "already" (the marker exists — never touched again),
 * "absent" (no single provider of that name; nothing written, tried next boot).
 */
export async function applyPlotnerOfficeSet(): Promise<"set" | "already" | "absent"> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const marker = await client.query(
      `SELECT 1 FROM activity_log
        WHERE type = 'provider_survey_offices_set' AND metadata::jsonb->>'reason' = $1 LIMIT 1`,
      [PLOTNER_REASON],
    );
    if (marker.rowCount) {
      await client.query("COMMIT");
      return "already";
    }
    const found = await client.query(
      `SELECT id, name, survey_locations FROM crm_providers
        WHERE lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = 'amanda plotner'
        FOR UPDATE`,
    );
    if (found.rowCount !== 1) {
      await client.query("ROLLBACK");
      console.warn(`[survey-plotner] office set skipped: ${found.rowCount} provider rows named ${PLOTNER_NAME}`);
      return "absent";
    }
    const p = found.rows[0] as { id: number; name: string; survey_locations: string[] | null };
    await client.query(
      `UPDATE crm_providers SET survey_locations = ARRAY['LL']::text[], updated_at = NOW() WHERE id = $1`,
      [p.id],
    );
    await client.query(
      `INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
       VALUES ('provider_survey_offices_set', 'system', 'provider', $1, $2, $3)`,
      [String(p.id), p.name, JSON.stringify({ from: p.survey_locations ?? [], to: ["LL"], reason: PLOTNER_REASON })],
    );
    await client.query("COMMIT");
    console.log(`[survey-plotner] survey offices ${JSON.stringify(p.survey_locations ?? [])} -> ["LL"] (one time)`);
    return "set";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Boot entry: step 1, then step 2 with counts before and after and the ids
 * changed. Never fatal to boot. Returns the relabelled submission ids.
 */
export async function applyPlotnerLosLunas(): Promise<number[]> {
  try {
    const set = await applyPlotnerOfficeSet();
    const before = await countPlotnerLabels();
    const { rows } = await getPool().query(PLOTNER_BACKFILL_SQL);
    const ids = (rows as Array<{ entity_id: string }>).map((r) => Number(r.entity_id)).sort((a, b) => a - b);
    const after = await countPlotnerLabels();
    console.log(
      `[survey-plotner] office set: ${set}; before: ${describe(before)}; ` +
        `relabelled ABQ->LL ${ids.length}${ids.length ? ` ids=[${ids.join(",")}]` : ""}; after: ${describe(after)}`,
    );
    return ids;
  } catch (e) {
    console.error(`[survey-plotner] FAILED: ${e instanceof Error ? e.message : "unknown"}`);
    return [];
  }
}
