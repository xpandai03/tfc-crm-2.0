/**
 * Corp-only providers: every survey for them counts under CORP.
 * ============================================================================
 *
 * A survey's office is its stored therapist label, "Name (CODE)"
 * (shared/survey-locations.ts). For a provider whose survey offices are exactly
 * {CORP} the practice wants no exception to that: not a survey from before the
 * move, not one posted by a form still showing an old "(ABQ)" entry. So:
 *
 *   1. AT WRITE TIME, corpOnlyLabel() rewrites the label of a survey for a
 *      CORP-only provider to "Name (CORP)" whatever office it arrived with.
 *      insertSubmission() applies it to every survey row, from any route.
 *      A provider at more than one office (Amanda Plotner, LL and ABQ) is left
 *      alone: the label is the only record of which office the client saw.
 *   2. ONCE, AT BOOT, applyCorpSurveyLabelBackfill() relabels the existing
 *      surveys of Sandra Rivera and Amanda Davison, the two providers the
 *      practice moved. migrations/backfill-corp-survey-labels.sql is the same
 *      statement; *.sql is kept out of the image (.dockerignore), so boot
 *      carries it here, as for the other migrations.
 *
 * No log line or activity entry here carries a client's name: submission ids,
 * provider names and office codes only.
 */

import { getPool } from "../db/pool";
import { surveyOfficesFor, surveyProviderLabel } from "@shared/survey-locations";
import { providerNameFromLabel } from "./aggregate";

// ============================================================================
// 1. The write-time rule
// ============================================================================

export interface CorpRuleProviderRow {
  name: string;
  location: string | null;
  survey_locations: string[] | null;
  is_active: boolean;
}

const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** True when the provider's survey office set is exactly {CORP}. */
export function isCorpOnly(location: string | null | undefined, surveyLocations: readonly string[] | null | undefined): boolean {
  const offices = surveyOfficesFor(location, surveyLocations);
  return offices.length === 1 && offices[0] === "CORP";
}

/**
 * The label to store for a survey's therapist answer. "Name (CORP)" when the
 * name resolves to exactly one CORP-only provider (active rows preferred, as a
 * departed duplicate must not make a current provider ambiguous); otherwise the
 * label exactly as submitted.
 */
export function corpOnlyLabel(label: string, providers: readonly CorpRuleProviderRow[]): string {
  const bare = providerNameFromLabel(label);
  if (bare === "") return label;
  const named = providers.filter((p) => normalizeName(p.name ?? "") === normalizeName(bare));
  const active = named.filter((p) => p.is_active);
  const candidates = active.length > 0 ? active : named;
  if (candidates.length !== 1) return label;
  const p = candidates[0];
  if (!isCorpOnly(p.location, p.survey_locations)) return label;
  return surveyProviderLabel(p.name.trim(), "CORP");
}

/**
 * corpOnlyLabel() against crm_providers. FAILS OPEN: a lookup that cannot run
 * stores the label as submitted rather than losing the client's survey.
 */
export async function surveyLabelForWrite(label: string): Promise<string> {
  const bare = providerNameFromLabel(label);
  if (bare === "") return label;
  try {
    const { rows } = await getPool().query(
      `SELECT name, location, survey_locations, is_active
         FROM crm_providers
        WHERE lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) = $1`,
      [normalizeName(bare)],
    );
    const next = corpOnlyLabel(label, rows as CorpRuleProviderRow[]);
    if (next !== label) console.log("[survey] therapist label set to CORP (provider is Corp-only)");
    return next;
  } catch (e) {
    console.error(`[survey] Corp-only label check failed, label kept: ${e instanceof Error ? e.message : "unknown"}`);
    return label;
  }
}

/**
 * A survey payload with the rule applied to answers.therapist. Returns the
 * same object when nothing changes, a copy when the label does.
 */
export async function applyCorpOnlyRule(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answers = payload.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return payload;
  const therapist = (answers as Record<string, unknown>).therapist;
  if (typeof therapist !== "string") return payload;
  const next = await surveyLabelForWrite(therapist);
  if (next === therapist) return payload;
  return { ...payload, answers: { ...(answers as Record<string, unknown>), therapist: next } };
}

// ============================================================================
// 2. The backfill
// ============================================================================

/**
 * Survey rows naming either provider, with the office their label carries
 * (NULL when it carries none). Shared by the backfill and its counts.
 */
const TARGETS_CTE = `WITH corp(name) AS (
  VALUES ('Sandra Rivera'), ('Amanda Davison')
),
surveys AS MATERIALIZED (
  SELECT id, payload::jsonb AS doc
  FROM form_submissions
  WHERE form_type = 'survey'
),
targets AS (
  SELECT s.id, s.doc, c.name,
         upper(trim(substring(s.doc->'answers'->>'therapist' from '\\(([^()]*)\\)\\s*$'))) AS old_office
  FROM surveys s
  JOIN corp c
    ON lower(regexp_replace(trim(regexp_replace(s.doc->'answers'->>'therapist', '\\s*\\([^()]*\\)\\s*$', '')), '\\s+', ' ', 'g'))
     = lower(c.name)
  WHERE jsonb_typeof(s.doc->'answers'->'therapist') = 'string'
)`;

/** Verbatim the body of migrations/backfill-corp-survey-labels.sql. */
export const CORP_BACKFILL_SQL = `${TARGETS_CTE},
changed AS (
  UPDATE form_submissions f
     SET payload = jsonb_set(t.doc, '{answers,therapist}', to_jsonb(t.name || ' (CORP)'))::text
    FROM targets t
   WHERE f.id = t.id
     AND t.old_office IS DISTINCT FROM 'CORP'
  RETURNING f.id, t.name, t.old_office
)
INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
SELECT 'survey_relabelled', 'system', 'submission', id::text, 'Client survey',
       json_build_object(
         'submissionId', id,
         'provider', name,
         'from', COALESCE(old_office, ''),
         'to', 'CORP',
         'reason', 'corp-only-backfill-2026-10-07'
       )::text
FROM changed
RETURNING entity_id;`;

const COUNT_SQL = `${TARGETS_CTE}
SELECT name, COALESCE(old_office, '') AS office, COUNT(*)::int AS n
FROM targets
GROUP BY 1, 2
ORDER BY 1, 2`;

export interface CorpLabelCount { name: string; office: string; n: number }

/** Every survey for the two providers, by the office its label carries. */
export async function countCorpProviderLabels(): Promise<CorpLabelCount[]> {
  const { rows } = await getPool().query(COUNT_SQL);
  return rows as CorpLabelCount[];
}

const notCorp = (counts: CorpLabelCount[]) =>
  counts.filter((c) => c.office !== "CORP").reduce((sum, c) => sum + c.n, 0);
const describe = (counts: CorpLabelCount[]) =>
  counts.map((c) => `${c.name} ${c.office || "(none)"}=${c.n}`).join(", ") || "none";

/**
 * Runs the backfill, logging counts before and after and the ids changed.
 * Idempotent; never fatal to boot. Returns the changed submission ids.
 */
export async function applyCorpSurveyLabelBackfill(): Promise<number[]> {
  try {
    const before = await countCorpProviderLabels();
    const { rows } = await getPool().query(CORP_BACKFILL_SQL);
    const ids = (rows as Array<{ entity_id: string }>).map((r) => Number(r.entity_id)).sort((a, b) => a - b);
    const after = await countCorpProviderLabels();
    console.log(
      `[survey-corp-backfill] before: ${notCorp(before)} not CORP (${describe(before)}); ` +
        `changed ${ids.length}${ids.length ? ` ids=[${ids.join(",")}]` : ""}; ` +
        `after: ${notCorp(after)} not CORP (${describe(after)})`,
    );
    return ids;
  } catch (e) {
    console.error(`[survey-corp-backfill] FAILED: ${e instanceof Error ? e.message : "unknown"}`);
    return [];
  }
}
