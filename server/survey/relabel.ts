/**
 * Change the therapist on a stored client survey (2026-10-22).
 * ============================================================================
 *
 * A client picks the wrong therapist, or one who should not have been on the
 * form. Staff fix it from the survey row on Submissions ("Change therapist").
 * The statement is the one used by hand on 2026-10-22 for surveys 1110 and
 * 1408, and the same shape as the Plotner and Corp relabels: rewrite
 * answers.therapist to the new provider's survey label and write one
 * survey_relabelled activity row (ids, provider and labels, never the client)
 * in the same transaction.
 *
 * The office travels in the label ("Name (ABQ)"), so the survey moves office
 * in the snapshot and the export with it. Nothing else is stored per survey.
 *
 * ONLY OFFERED PROVIDERS. The new therapist must be active and shown on the
 * survey, and the label must be one the survey itself would offer today
 * (rosterEntriesFromRows: one per survey office). A survey already filed to a
 * TherapyNotes chart is relabelled in the CRM only; the PDF on the chart keeps
 * the old name, and the caller is told so.
 */

import { getPool } from "../db/pool";
import { rosterEntriesFromRows, type ProviderRosterRow } from "./roster";

export interface TherapistOption {
  providerId: number;
  /** "Name (OFFICE)", exactly as the survey form offers it. */
  label: string;
}

/** Pure: provider rows (with ids) → the labels a survey may be moved to. */
export function therapistOptionsFromRows(rows: Array<ProviderRosterRow & { id: number }>): TherapistOption[] {
  const out: TherapistOption[] = [];
  for (const row of rows) {
    for (const e of rosterEntriesFromRows([row])) out.push({ providerId: row.id, label: e.label });
  }
  return out;
}

/** Active providers shown on the survey, one option per survey office, name-ordered. */
export async function getTherapistOptions(): Promise<TherapistOption[]> {
  const { rows } = await getPool().query(`
    SELECT id, name, credentials, location, survey_locations, show_on_survey
      FROM crm_providers
     WHERE is_active = true AND show_on_survey IS NOT FALSE
     ORDER BY name ASC
  `);
  return therapistOptionsFromRows(rows);
}

export type RelabelResult =
  | { ok: true; submissionId: number; from: string; to: string; providerId: number; activityId: number; filedToChart: boolean }
  | { ok: false; code: "not_found" | "label_changed" | "not_offered" | "unchanged"; message: string };

export const RELABEL_SQL = `WITH target AS (
  SELECT id, payload::jsonb AS doc, payload::jsonb->'answers'->>'therapist' AS old_label
    FROM form_submissions
   WHERE id = $1 AND form_type = 'survey' AND deleted_at IS NULL
     AND payload::jsonb->'answers'->>'therapist' IS NOT DISTINCT FROM $2
   FOR UPDATE
),
changed AS (
  UPDATE form_submissions f
     SET payload = jsonb_set(t.doc, '{answers,therapist}', to_jsonb($3::text))::text
    FROM target t
   WHERE f.id = t.id
  RETURNING f.id, t.old_label
)
INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
SELECT 'survey_relabelled', $4, 'submission', id::text, 'Client survey',
       json_build_object('submissionId', id, 'provider', $5::text, 'from', old_label, 'to', $3::text,
                         'toProviderId', $6::int, 'reason', $7::text)::text
  FROM changed
RETURNING id`;

/**
 * Move one survey to `toLabel`. `expectedFrom` is the label the caller saw;
 * if the row has changed since, nothing is written ("label_changed").
 */
export async function relabelSurveyTherapist(params: {
  submissionId: number;
  toLabel: string;
  expectedFrom: string | null;
  actor: string;
  reason?: string;
}): Promise<RelabelResult> {
  const { submissionId, toLabel, expectedFrom, actor } = params;
  const option = (await getTherapistOptions()).find((o) => o.label === toLabel);
  if (!option) {
    return { ok: false, code: "not_offered", message: "That therapist is not offered on the survey. Pick one from the list." };
  }
  if (expectedFrom === toLabel) {
    return { ok: false, code: "unchanged", message: "The survey already has that therapist." };
  }

  const pool = getPool();
  const current = await pool.query(
    `SELECT payload::jsonb->'answers'->>'therapist' AS label FROM form_submissions
      WHERE id = $1 AND form_type = 'survey' AND deleted_at IS NULL`,
    [submissionId],
  );
  if (current.rowCount === 0) {
    return { ok: false, code: "not_found", message: "No survey with that id, or it was deleted." };
  }

  const providerName = toLabel.replace(/\s*\([^()]*\)\s*$/, "").trim();
  const { rows } = await pool.query(RELABEL_SQL, [
    submissionId, expectedFrom, toLabel, actor, providerName, option.providerId, params.reason ?? "staff-change-therapist",
  ]);
  if (rows.length !== 1) {
    return { ok: false, code: "label_changed", message: "This survey changed since you opened it. Refresh and try again." };
  }

  const attach = await pool.query(
    `SELECT 1 FROM survey_attach_attempts WHERE submission_id = $1 AND status = 'attached'`,
    [submissionId],
  ).catch(() => ({ rowCount: 0 }));

  return {
    ok: true,
    submissionId,
    from: expectedFrom ?? "",
    to: toLabel,
    providerId: option.providerId,
    activityId: rows[0].id as number,
    filedToChart: (attach.rowCount ?? 0) > 0,
  };
}
