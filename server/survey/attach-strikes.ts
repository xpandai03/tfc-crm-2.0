/**
 * Three strikes: an ambiguous nightly refusal stops being retried forever.
 * ============================================================================
 *
 * Some refusals are AMBIGUOUS — a real absence or a search miss, a render race
 * or a blank field — so one of them is treated as transient and the row stays
 * matched for the next night (see ATTACH_REFUSAL_REVIEW_REASON). Transient with
 * no end is its own failure: 1081, 1099 and 1101 were refused patient_not_found
 * on five consecutive nights to 2026-10-06, each a TherapyNotes login and
 * search, and nobody was told.
 *
 * THE RULE. The third CONSECUTIVE nightly refusal with the SAME strike code
 * moves the survey to review as attach_repeated_<code>: "… (3 nights in a
 * row); file by hand or check the record".
 *   - Nightly only: a staff member's press is not a night.
 *   - Outage codes (login_failed, agent_unreachable, agent_timeout,
 *     unknown_error — which is also how "agent busy" arrives) say nothing
 *     about the survey. They are skipped: they neither count nor break a run.
 *   - Any other result breaks the run: a success, or a different code.
 *
 * THE HISTORY IS THE ACTIVITY LOG. Every attempt already writes one row there
 * (survey_attach_completed / survey_attach_failed, with trigger and code), so
 * the count needs no new column and applies at once to rows that already have
 * five strikes.
 *
 * Counts and codes only in logs.
 */
import { getPool } from "../db/pool";
import { getMatchState, markAttachRefusalForReview } from "./match-db";
import type { ReviewReason } from "@shared/survey-match-reasons";

export const STRIKE_LIMIT = 3;

/** Refusal codes that count. Each has an attach_repeated_<code> review reason. */
export const STRIKE_CODES = [
  "patient_not_found",
  "result_set_possibly_truncated",
  "field_unreadable",
  "agent_rejected_request",
] as const;
export type StrikeCode = (typeof STRIKE_CODES)[number];

/** Codes that mean the agent or TherapyNotes was down or busy. Never count, never reset. */
export const OUTAGE_CODES = ["login_failed", "agent_unreachable", "agent_timeout", "unknown_error"] as const;

export function isStrikeCode(code: string | null | undefined): code is StrikeCode {
  return (STRIKE_CODES as readonly string[]).includes(code ?? "");
}

export function strikeReviewReason(code: StrikeCode): ReviewReason {
  return `attach_repeated_${code}` as ReviewReason;
}

export interface AttachEvent {
  /** null = attached. */
  code: string | null;
  trigger: string;
}

/**
 * The run of identical strike codes at the head of a submission's NIGHTLY
 * history (newest first), outages skipped. null when the newest counted night
 * is not a strike code.
 */
export function strikeRun(history: AttachEvent[]): { code: StrikeCode; nights: number } | null {
  let code: StrikeCode | null = null;
  let nights = 0;
  for (const e of history) {
    if (e.trigger !== "scheduled") continue;
    if (e.code !== null && (OUTAGE_CODES as readonly string[]).includes(e.code)) continue;
    if (e.code === null || !isStrikeCode(e.code)) break;
    if (code === null) code = e.code;
    else if (e.code !== code) break;
    nights += 1;
  }
  return code ? { code, nights } : null;
}

/** Newest first, from the activity log. */
export async function getAttachHistory(submissionId: number, limit = 30): Promise<AttachEvent[]> {
  const { rows } = await getPool().query(
    `SELECT type, metadata FROM activity_log
      WHERE entity_type = 'submission' AND entity_id = $1
        AND type IN ('survey_attach_completed', 'survey_attach_failed')
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [String(submissionId), limit],
  );
  return rows.map((r: { type: string; metadata: unknown }) => {
    let meta: { trigger?: string; failureReason?: string } = {};
    try { meta = typeof r.metadata === "string" ? JSON.parse(r.metadata) : (r.metadata as typeof meta) ?? {}; } catch { /* unreadable: unknown */ }
    return {
      code: r.type === "survey_attach_completed" ? null : (meta.failureReason ?? "unknown_error"),
      trigger: meta.trigger ?? "manual",
    };
  });
}

/**
 * Apply the rule to one submission. Moves it to review and returns the reason
 * when it has reached STRIKE_LIMIT; otherwise null. Only a row still waiting
 * to be filed (match status "matched") is moved — a row already in review, or
 * resolved as "no contact", is left exactly as it is.
 */
export async function applyStrikeRule(
  submissionId: number,
  history?: AttachEvent[],
): Promise<{ reason: ReviewReason; nights: number } | null> {
  const run = strikeRun(history ?? await getAttachHistory(submissionId));
  if (!run || run.nights < STRIKE_LIMIT) return null;
  const state = await getMatchState(submissionId);
  if (!state || state.status !== "matched") return null;
  const reason = strikeReviewReason(run.code);
  await markAttachRefusalForReview({ submissionId, reason });
  console.log(`[survey-attach] TO REVIEW id=${submissionId} reason=${reason} nights=${run.nights}`);
  return { reason, nights: run.nights };
}

/**
 * Every survey whose latest attempt failed on a strike code, checked once.
 * Run at boot and before each nightly batch, so a rule change — or this rule
 * arriving — applies to rows that already qualify without waiting a night.
 */
export async function sweepStrikes(): Promise<{ checked: number; moved: number[] }> {
  const { rows } = await getPool().query(
    `SELECT submission_id FROM survey_attach_attempts
      WHERE status = 'failed' AND reason = ANY($1::text[])
      ORDER BY submission_id`,
    [STRIKE_CODES as readonly string[]],
  );
  const moved: number[] = [];
  for (const r of rows as Array<{ submission_id: number }>) {
    try {
      if (await applyStrikeRule(r.submission_id)) moved.push(r.submission_id);
    } catch (e) {
      console.error(`[survey-attach] strike check failed id=${r.submission_id}: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  console.log(`[survey-attach] strike sweep: checked=${rows.length} moved=${moved.length}${moved.length ? ` ids=${moved.join(",")}` : ""}`);
  return { checked: rows.length, moved };
}
