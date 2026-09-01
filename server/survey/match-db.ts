/**
 * Storage for survey → contact match state.
 * ============================================================================
 *
 * WHY A SIDE TABLE RATHER THAN COLUMNS ON form_submissions
 * --------------------------------------------------------
 * The same reasoning that put report_send_log beside report_sends instead of
 * inside it (server/reports/send-log.ts:4-25): form_submissions is written by
 * the PUBLIC survey endpoint. Adding match/review columns to it would mean
 * altering the table the live intake and survey write paths depend on, in order
 * to store something neither of them produces. A separate table keyed on
 * submission_id keeps the write path untouched by construction.
 *
 * The one thing this DOES write to form_submissions is `contact_id` — an
 * existing, already-nullable column that is exactly what it is for. That is a
 * data write, not a schema change.
 *
 * NOTHING HERE MODIFIES A CONTACT. sync_contacts is read-only to this module.
 *
 * IDEMPOTENCE: re-running matching recomputes only rows a human has NOT
 * resolved. A row with resolved_by set is a human identity decision and is
 * never overwritten by the automatic pass — see markAutoMatchResult().
 */

import { getPool } from "../db/pool";
import type { ContactIdentity, MatchReason } from "./matching";

export type MatchStatus = "matched" | "review" | "no_contact";

export interface SurveyMatchRow {
  submissionId: number;
  status: MatchStatus;
  reason: string;
  matchedContactId: number | null;
  candidateIds: number[];
  resolvedBy: string | null;
  resolvedAt: string | null;
  updatedAt: string;
}

export async function initSurveyMatchTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_match_reviews (
      submission_id      INTEGER     PRIMARY KEY,
      status             TEXT        NOT NULL,
      reason             TEXT        NOT NULL,
      matched_contact_id INTEGER,
      candidate_ids      TEXT        NOT NULL DEFAULT '[]',
      resolved_by        TEXT,
      resolved_at        TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_survey_match_status ON survey_match_reviews(status)`,
  );
  console.log("[survey-match] Table initialized");
}

/**
 * Every contact's identity fields, and nothing else.
 *
 * The whole set is loaded and matched in memory rather than filtered in SQL.
 * At 1,243 rows that is trivial, and it keeps the rules in one pure, testable
 * function instead of split between TypeScript and a SQL predicate that would
 * have to re-implement date canonicalisation — the formats are mixed, and a
 * to_date() over free text throws on the malformed rows.
 */
export async function getContactIdentityIndex(): Promise<ContactIdentity[]> {
  const res = await getPool().query(`
    SELECT contact_id AS "contactId", name, email, patient_dob AS "patientDob"
      FROM sync_contacts
  `);
  return res.rows as ContactIdentity[];
}

/** Identity fields for a named set of contacts, for the review UI. */
export async function getContactIdentities(ids: number[]): Promise<ContactIdentity[]> {
  if (ids.length === 0) return [];
  const res = await getPool().query(
    `SELECT contact_id AS "contactId", name, email, patient_dob AS "patientDob"
       FROM sync_contacts WHERE contact_id = ANY($1::int[])`,
    [ids],
  );
  return res.rows as ContactIdentity[];
}

const parseIds = (raw: unknown): number[] => {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
};

const mapRow = (r: Record<string, unknown>): SurveyMatchRow => ({
  submissionId: r.submission_id as number,
  status: r.status as MatchStatus,
  reason: r.reason as string,
  matchedContactId: (r.matched_contact_id as number | null) ?? null,
  candidateIds: parseIds(r.candidate_ids),
  resolvedBy: (r.resolved_by as string | null) ?? null,
  resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
  updatedAt: String(r.updated_at),
});

/** Submission ids a human has already resolved — never recomputed. */
export async function getHumanResolvedIds(): Promise<Set<number>> {
  const res = await getPool().query(
    `SELECT submission_id FROM survey_match_reviews WHERE resolved_by IS NOT NULL`,
  );
  return new Set(res.rows.map((r: { submission_id: number }) => r.submission_id));
}

/**
 * Record the automatic matcher's verdict for one submission.
 *
 * Guarded by `resolved_by IS NULL` in the UPDATE branch, so a re-run can never
 * silently undo a person's decision.
 */
export async function markAutoMatchResult(params: {
  submissionId: number;
  status: "matched" | "review";
  reason: MatchReason;
  contactId: number | null;
  candidateIds: number[];
}): Promise<void> {
  await getPool().query(
    `INSERT INTO survey_match_reviews
       (submission_id, status, reason, matched_contact_id, candidate_ids, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (submission_id) DO UPDATE SET
       status             = EXCLUDED.status,
       reason             = EXCLUDED.reason,
       matched_contact_id = EXCLUDED.matched_contact_id,
       candidate_ids      = EXCLUDED.candidate_ids,
       updated_at         = NOW()
     WHERE survey_match_reviews.resolved_by IS NULL`,
    [
      params.submissionId,
      params.status,
      params.reason,
      params.contactId,
      JSON.stringify(params.candidateIds),
    ],
  );
}

/**
 * Record a human's decision: either a named contact, or an explicit "no
 * contact". Both are decisions; neither is a default.
 */
export async function recordHumanResolution(params: {
  submissionId: number;
  contactId: number | null;
  actorEmail: string;
}): Promise<void> {
  const status: MatchStatus = params.contactId === null ? "no_contact" : "matched";
  const reason = params.contactId === null
    ? "Confirmed by staff: no matching contact"
    : "Confirmed by staff";
  await getPool().query(
    `INSERT INTO survey_match_reviews
       (submission_id, status, reason, matched_contact_id, candidate_ids,
        resolved_by, resolved_at, updated_at)
     VALUES ($1, $2, $3, $4, '[]', $5, NOW(), NOW())
     ON CONFLICT (submission_id) DO UPDATE SET
       status             = EXCLUDED.status,
       reason             = EXCLUDED.reason,
       matched_contact_id = EXCLUDED.matched_contact_id,
       resolved_by        = EXCLUDED.resolved_by,
       resolved_at        = NOW(),
       updated_at         = NOW()`,
    [params.submissionId, status, reason, params.contactId, params.actorEmail],
  );
}

/**
 * Write contact_id onto the submission itself, so every existing consumer of
 * form_submissions (the Submissions page's "View Contact" link, the eventual
 * reporting join) sees the link without knowing this table exists.
 *
 * Scoped to form_type='survey' so this can never touch an intake row.
 */
export async function setSubmissionContactId(
  submissionId: number,
  contactId: number | null,
): Promise<void> {
  await getPool().query(
    `UPDATE form_submissions SET contact_id = $2
      WHERE id = $1 AND form_type = 'survey'`,
    [submissionId, contactId],
  );
}

/** All match rows, keyed by submission id, for decorating the Submissions list. */
export async function getMatchStates(): Promise<Map<number, SurveyMatchRow>> {
  const res = await getPool().query(`SELECT * FROM survey_match_reviews`);
  const map = new Map<number, SurveyMatchRow>();
  for (const r of res.rows) map.set(r.submission_id as number, mapRow(r));
  return map;
}

export async function getMatchState(submissionId: number): Promise<SurveyMatchRow | null> {
  const res = await getPool().query(
    `SELECT * FROM survey_match_reviews WHERE submission_id = $1`,
    [submissionId],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export interface MatchCounts {
  matched: number;
  review: number;
  no_contact: number;
  unprocessed: number;
}

/** Counts for the Submissions page filter chips. */
export async function getMatchCounts(): Promise<MatchCounts> {
  const res = await getPool().query(`
    SELECT COALESCE(m.status, 'unprocessed') AS status, count(*)::int AS n
      FROM form_submissions s
      LEFT JOIN survey_match_reviews m ON m.submission_id = s.id
     WHERE s.form_type = 'survey'
     GROUP BY 1
  `);
  const out: MatchCounts = { matched: 0, review: 0, no_contact: 0, unprocessed: 0 };
  for (const r of res.rows) {
    const k = r.status as keyof MatchCounts;
    if (k in out) out[k] = r.n as number;
  }
  return out;
}
