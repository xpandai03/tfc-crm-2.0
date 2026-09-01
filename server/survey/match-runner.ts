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

/** Pull the typed identity out of a stored survey payload. */
function identityOf(payload: unknown): SubmittedIdentity | null {
  const p = payload as { client?: { name?: unknown; dateOfBirth?: unknown; email?: unknown } } | null;
  const c = p?.client;
  if (!c || typeof c.name !== "string" || typeof c.dateOfBirth !== "string") return null;
  return {
    name: c.name,
    dateOfBirth: c.dateOfBirth,
    email: typeof c.email === "string" ? c.email : null,
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
        submissionId: sub.id, status: "review", reason: "no_candidates",
        contactId: null, candidateIds: [],
      });
      summary.considered += 1;
      summary.review += 1;
      summary.byReason.no_candidates = (summary.byReason.no_candidates ?? 0) + 1;
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
