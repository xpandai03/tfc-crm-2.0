/**
 * Surveys whose year of birth cannot be the client's, sent to review.
 *
 * On 2026-10-01 a client reported that the survey's date-of-birth year went
 * back to 2026 when they changed it (the iPhone date picker). A survey carrying
 * that year can never match a chart, so it goes to a person, who confirms the
 * date with the client. The value itself is never edited here.
 *
 * IMPLAUSIBLE means: the year is within the last DOB_RECENT_YEARS years (or in
 * the future), or more than DOB_MAX_AGE_YEARS years back. A child client is
 * plausible (a parent may answer for them), so anything older than
 * DOB_RECENT_YEARS is left alone. An unreadable date is not handled here,
 * because the matcher already sends those to review as unparseable_dob.
 *
 * Routing goes through markAttachRefusalForReview, the path attach refusals
 * use, so the 03:00 re-match leaves the row in review. A row that is already
 * matched, filed, or decided by a person is NOT changed. It is reported, and a
 * person decides.
 *
 * Logs carry submission ids and years only.
 */

import { getPool } from "../db/pool";
import { DOB_MAX_AGE_YEARS } from "@shared/survey-questions";
import { markAttachRefusalForReview } from "./match-db";

/** A year of birth this recent cannot be a survey respondent's. */
export const DOB_RECENT_YEARS = 2;

export const DOB_IMPLAUSIBLE_REASON = "attach_dob_implausible" as const;

/** The year when it is implausible, else null. Unreadable dates give null. */
export function implausibleDobYear(dateOfBirth: string | null | undefined, today: Date): number | null {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec((dateOfBirth ?? "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const thisYear = today.getUTCFullYear();
  if (year >= thisYear - DOB_RECENT_YEARS) return year;
  if (year < thisYear - DOB_MAX_AGE_YEARS) return year;
  return null;
}

export interface DobReviewCandidate {
  submissionId: number;
  dobYear: number;
  matchStatus: string | null;
  matchReason: string | null;
  humanResolved: boolean;
  attachStatus: string | null;
}

export type DobReviewDecision =
  | { action: "route"; candidate: DobReviewCandidate }
  | { action: "already-routed"; candidate: DobReviewCandidate }
  | { action: "report-only"; candidate: DobReviewCandidate; why: string };

/**
 * What to do with one implausible row. Pure, so the rule is tested without a
 * database. Only an unmatched, unfiled, undecided row is routed.
 */
export function decideDobReview(c: DobReviewCandidate): DobReviewDecision {
  if (c.matchReason === DOB_IMPLAUSIBLE_REASON && c.matchStatus === "review") {
    return { action: "already-routed", candidate: c };
  }
  if (c.attachStatus === "attached") return { action: "report-only", candidate: c, why: "already filed to a chart" };
  if (c.humanResolved) return { action: "report-only", candidate: c, why: "already decided by staff" };
  if (c.matchStatus === "matched") return { action: "report-only", candidate: c, why: "already matched to a contact" };
  return { action: "route", candidate: c };
}

/** Every survey with an implausible year of birth, with its match and filing state. */
export async function findImplausibleDobSurveys(today: Date): Promise<DobReviewCandidate[]> {
  const { rows } = await getPool().query(`
    SELECT f.id AS submission_id,
           f.payload::jsonb -> 'client' ->> 'dateOfBirth' AS dob,
           r.status AS match_status, r.reason AS match_reason,
           (r.resolved_by IS NOT NULL) AS human_resolved,
           a.status AS attach_status
      FROM form_submissions f
      LEFT JOIN survey_match_reviews r ON r.submission_id = f.id
      LEFT JOIN survey_attach_attempts a ON a.submission_id = f.id
     WHERE f.form_type = 'survey'
     ORDER BY f.id`);
  const out: DobReviewCandidate[] = [];
  for (const r of rows) {
    const year = implausibleDobYear(r.dob, today);
    if (year === null) continue;
    out.push({
      submissionId: Number(r.submission_id),
      dobYear: year,
      matchStatus: r.match_status ?? null,
      matchReason: r.match_reason ?? null,
      humanResolved: r.human_resolved === true,
      attachStatus: r.attach_status ?? null,
    });
  }
  return out;
}

/** Find, decide, and (unless dryRun) route. Returns every decision. */
export async function routeImplausibleDobsToReview(opts: { today?: Date; dryRun: boolean }): Promise<DobReviewDecision[]> {
  const decisions = (await findImplausibleDobSurveys(opts.today ?? new Date())).map(decideDobReview);
  for (const d of decisions) {
    const c = d.candidate;
    if (d.action === "route" && !opts.dryRun) {
      await markAttachRefusalForReview({ submissionId: c.submissionId, reason: DOB_IMPLAUSIBLE_REASON });
    }
    const what = d.action === "report-only" ? `report-only (${d.why})` : opts.dryRun && d.action === "route" ? "would route" : d.action;
    console.log(`[survey-dob] submission=${c.submissionId} year=${c.dobYear} ${what}`);
  }
  return decisions;
}
