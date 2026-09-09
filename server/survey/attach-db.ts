/**
 * Storage for survey-PDF-to-chart attach attempts.
 * ============================================================================
 *
 * SCHEMA ADDITION — REPORTED BEFORE IT WAS MADE. This introduces one new table.
 * It alters nothing that exists, and it follows the pattern this codebase
 * already uses three times for exactly this kind of state: survey_match_reviews
 * (./match-db.ts), therapy_notes_records (../therapy-notes/db.ts) and the
 * reminders tables — CREATE TABLE IF NOT EXISTS at boot, no migration file, no
 * drizzle-kit push, no ALTER. Dropping the table reverses it completely.
 *
 * WHY A TABLE AND NOT activity_log. An attach is not idempotent: running it
 * twice puts two copies of the same survey on a patient's chart. Preventing
 * that needs an ATOMIC claim — one row per submission, taken with INSERT ...
 * ON CONFLICT DO NOTHING, so two staff pressing the button at the same instant
 * cannot both win. activity_log has no such key and would let both through.
 * Activity entries are still written for the audit trail; this table is what
 * makes the guarantee.
 *
 * WHY NOT COLUMNS ON form_submissions. The same reasoning that put
 * survey_match_reviews beside it rather than inside it: form_submissions is
 * written by the PUBLIC survey endpoint, and this build has no business
 * altering the table that write path depends on.
 *
 * NO PHI. This table stores a submission id, a status, a reason CODE, a run
 * duration and who pressed the button. No name, no date of birth, no phone, no
 * answer, and not the chart URL — the URL identifies a patient, and nothing
 * here needs it.
 */

import { getPool } from "../db/pool";

/**
 * running   — claimed, dispatched, no verdict yet. Blocks a second attempt.
 * attached  — the agent confirmed the document is on the chart. Terminal.
 * failed    — refused or errored. A human may deliberately try again.
 */
export type AttachStatus = "running" | "attached" | "failed";

export interface AttachRow {
  submissionId: number;
  contactId: number | null;
  status: AttachStatus;
  /** Agent refusal code, or one of ATTACH_LOCAL_REASONS. Null while running. */
  reason: string | null;
  /** "manual" or "scheduled". */
  trigger: string;
  actorEmail: string;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

export async function initSurveyAttachTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_attach_attempts (
      submission_id INTEGER     PRIMARY KEY,
      contact_id    INTEGER,
      status        TEXT        NOT NULL,
      reason        TEXT,
      trigger       TEXT        NOT NULL DEFAULT 'manual',
      actor_email   TEXT        NOT NULL DEFAULT 'system',
      duration_ms   INTEGER,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at   TIMESTAMPTZ,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_survey_attach_status ON survey_attach_attempts(status)`,
  );
  console.log("[survey-attach] Table initialized");
}

const mapRow = (r: Record<string, unknown>): AttachRow => ({
  submissionId: r.submission_id as number,
  contactId: (r.contact_id as number | null) ?? null,
  status: r.status as AttachStatus,
  reason: (r.reason as string | null) ?? null,
  trigger: String(r.trigger ?? "manual"),
  actorEmail: String(r.actor_email ?? "system"),
  durationMs: (r.duration_ms as number | null) ?? null,
  startedAt: String(r.started_at),
  finishedAt: r.finished_at ? String(r.finished_at) : null,
  updatedAt: String(r.updated_at),
});

/**
 * Take the exclusive right to attach this submission.
 *
 * THE ONE THING THAT MAKES DOUBLE-ATTACH IMPOSSIBLE. Returns true only for the
 * caller that actually created or re-took the row. The WHERE clause on the
 * conflict branch is what does it: an existing row is re-taken ONLY when it is
 * a previous failure. A row already `attached` never yields, and a row already
 * `running` never yields — so a second press, a second tab, or the scheduled
 * run colliding with a staff member all lose the race and are told why.
 *
 * A stale `running` row (the process died mid-attach) is re-takable after
 * STALE_RUNNING_MS, or the submission would be locked out forever by a crash.
 * That window is deliberately longer than the agent's own ceiling.
 */
const STALE_RUNNING_MS = 10 * 60 * 1000;

export async function claimAttach(params: {
  submissionId: number;
  contactId: number | null;
  trigger: "manual" | "scheduled";
  actorEmail: string;
}): Promise<boolean> {
  const res = await getPool().query(
    `INSERT INTO survey_attach_attempts
       (submission_id, contact_id, status, reason, trigger, actor_email,
        duration_ms, started_at, finished_at, updated_at)
     VALUES ($1, $2, 'running', NULL, $3, $4, NULL, NOW(), NULL, NOW())
     ON CONFLICT (submission_id) DO UPDATE SET
       contact_id  = EXCLUDED.contact_id,
       status      = 'running',
       reason      = NULL,
       trigger     = EXCLUDED.trigger,
       actor_email = EXCLUDED.actor_email,
       duration_ms = NULL,
       started_at  = NOW(),
       finished_at = NULL,
       updated_at  = NOW()
     WHERE survey_attach_attempts.status = 'failed'
        OR (survey_attach_attempts.status = 'running'
            AND survey_attach_attempts.started_at < NOW() - ($5::int * interval '1 millisecond'))
     RETURNING submission_id`,
    [params.submissionId, params.contactId, params.trigger, params.actorEmail, STALE_RUNNING_MS],
  );
  return res.rowCount === 1;
}

/** Write the verdict for a claimed attempt. */
export async function recordAttachOutcome(params: {
  submissionId: number;
  status: "attached" | "failed";
  reason: string | null;
  durationMs: number;
}): Promise<void> {
  await getPool().query(
    `UPDATE survey_attach_attempts
        SET status = $2, reason = $3, duration_ms = $4,
            finished_at = NOW(), updated_at = NOW()
      WHERE submission_id = $1`,
    [params.submissionId, params.status, params.reason, params.durationMs],
  );
}

export async function getAttachRow(submissionId: number): Promise<AttachRow | null> {
  const res = await getPool().query(
    `SELECT * FROM survey_attach_attempts WHERE submission_id = $1`,
    [submissionId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

/** Every attempt, keyed by submission id, for decorating the Submissions list. */
export async function getAttachRows(): Promise<Map<number, AttachRow>> {
  const res = await getPool().query(`SELECT * FROM survey_attach_attempts`);
  const map = new Map<number, AttachRow>();
  for (const r of res.rows) map.set(r.submission_id as number, mapRow(r));
  return map;
}

/** Submission ids that must never be attached again by an automatic pass. */
export async function getAttachedOrRunningIds(): Promise<Set<number>> {
  const res = await getPool().query(
    `SELECT submission_id FROM survey_attach_attempts WHERE status IN ('attached', 'running')`,
  );
  return new Set(res.rows.map((r: { submission_id: number }) => r.submission_id));
}
