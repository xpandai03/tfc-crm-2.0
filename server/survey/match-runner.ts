/**
 * Runs the matcher over survey submissions.
 *
 * IDEMPOTENT AND RE-RUNNABLE. It loads every survey submission, skips any a
 * human has resolved, recomputes the rest against the current contact set, and
 * writes the verdict. Running it twice with unchanged data produces the same
 * state; running it after new contacts sync can turn a previous "no candidates"
 * into a match, which is the point of it being re-runnable rather than
 * fire-once-on-arrival.
 *
 * NO NAME OR FIELD VALUE IS LOGGED. Counts and submission ids only, matching
 * the discipline in server/index.ts:77-107.
 */

import { getRecentSurveySubmissions } from "../sync/db";
import {
  getContactIdentityIndex,
  getHumanResolvedIds,
  markAutoMatchResult,
  setSubmissionContactId,
} from "./match-db";
import { matchSubmission, type SubmittedIdentity } from "./matching";

export interface MatchRunSummary {
  considered: number;
  skippedHumanResolved: number;
  matched: number;
  review: number;
  byReason: Record<string, number>;
}

/**
 * Pull the typed identity out of a stored survey payload.
 *
 * PRE-PHONE SUBMISSIONS DEGRADE, THEY DO NOT FAIL. Phone became a required
 * field on the form on 2026-09-03; all 32 submissions taken before that carry
 * none, and there is no way to obtain one retrospectively for a survey handed
 * in at a front desk weeks ago. An absent phone therefore reads as "no phone
 * evidence" — exactly what an absent email has always meant — and the row is
 * held to name + exact date of birth + no contradiction, which is the same bar
 * it was always held to.
 *
 * That does not soften the bar for anything new. A submission taken today
 * cannot lack a phone: the form requires it and the server's schema rejects a
 * submission without one, so the corroboration always runs on new rows. The
 * degradation is scoped to rows the old form produced, by construction rather
 * than by a flag.
 *
 * THE THERAPIST ANSWER is read for one purpose — breaking a tie between
 * otherwise-identical contacts. It is the only survey ANSWER this module
 * touches, it never reaches the review queue as content, and it can only ever
 * choose among candidates that already matched.
 */
function identityOf(payload: unknown): SubmittedIdentity | null {
  const p = payload as {
    client?: { name?: unknown; dateOfBirth?: unknown; email?: unknown; phone?: unknown };
    answers?: { therapist?: unknown };
  } | null;
  const c = p?.client;
  if (!c || typeof c.name !== "string" || typeof c.dateOfBirth !== "string") return null;
  return {
    name: c.name,
    dateOfBirth: c.dateOfBirth,
    phone: typeof c.phone === "string" ? c.phone : null,
    email: typeof c.email === "string" ? c.email : null,
    provider: typeof p?.answers?.therapist === "string" ? p.answers.therapist : null,
  };
}

export async function runSurveyMatching(): Promise<MatchRunSummary> {
  const [submissions, contacts, humanResolved] = await Promise.all([
    getRecentSurveySubmissions(1000),
    getContactIdentityIndex(),
    getHumanResolvedIds(),
  ]);

  const summary: MatchRunSummary = {
    considered: 0,
    skippedHumanResolved: 0,
    matched: 0,
    review: 0,
    byReason: {},
  };

  for (const sub of submissions) {
    if (humanResolved.has(sub.id)) {
      summary.skippedHumanResolved += 1;
      continue;
    }
    const identity = identityOf(sub.payload);
    if (!identity) {
      // A survey row whose payload has no client block cannot be matched. It is
      // not an error — it is a row for a person to look at.
      await markAutoMatchResult({
        submissionId: sub.id, status: "review", reason: "no_name",
        contactId: null, candidateIds: [],
      });
      summary.considered += 1;
      summary.review += 1;
      summary.byReason.no_name = (summary.byReason.no_name ?? 0) + 1;
      continue;
    }

    const outcome = matchSubmission(identity, contacts);
    await markAutoMatchResult({
      submissionId: sub.id,
      status: outcome.status,
      reason: outcome.reason,
      contactId: outcome.contactId,
      candidateIds: outcome.candidateIds,
    });
    // Mirror the link onto the submission itself. On a review verdict this
    // CLEARS any previously written contact_id, so a row that stops matching
    // (a contact edited, a duplicate appearing) does not keep a stale link.
    await setSubmissionContactId(sub.id, outcome.status === "matched" ? outcome.contactId : null);

    summary.considered += 1;
    if (outcome.status === "matched") summary.matched += 1;
    else summary.review += 1;
    summary.byReason[outcome.reason] = (summary.byReason[outcome.reason] ?? 0) + 1;
  }

  return summary;
}
