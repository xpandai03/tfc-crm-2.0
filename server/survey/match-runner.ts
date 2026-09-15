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

import { getRecentSurveySubmissions, getSubmissionById } from "../sync/db";
import {
  getContactIdentityIndex,
  getHumanResolvedIds,
  markAutoMatchResult,
  setSubmissionContactId,
} from "./match-db";
import { collapseIdentities, matchSubmission, type ContactIdentity, type SubmittedIdentity } from "./matching";
import { getTnPatientIdentities, linkContactToChart } from "../therapy-notes/tn-patients-db";

export interface MatchRunSummary {
  considered: number;
  skippedHumanResolved: number;
  matched: number;
  review: number;
  byReason: Record<string, number>;
  /** How many identities each population contributed, after collapsing. */
  crmContacts: number;
  tnPatients: number;
  identities: number;
  /** Matches that resolved to a TherapyNotes chart. The point of the build. */
  matchedWithChart: number;
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
  return withMatchLock(() => runSurveyMatchingUnlocked());
}

async function runSurveyMatchingUnlocked(): Promise<MatchRunSummary> {
  const [submissions, humanResolved, loaded] = await Promise.all([
    getRecentSurveySubmissions(1000),
    getHumanResolvedIds(),
    loadIdentities(),
  ]);

  const summary = emptySummary();
  summary.crmContacts = loaded.crmCount;
  summary.tnPatients = loaded.tnCount;
  summary.identities = loaded.identities.length;

  // Counts only. The collapse total being lower than the sum is the shared
  // population; it is the one number that says the link is working.
  console.log(
    `[survey-match] ${loaded.crmCount} CRM contacts + ${loaded.tnCount} ` +
    `TherapyNotes patients -> ${loaded.identities.length} identities after collapsing`,
  );

  for (const sub of submissions) {
    await matchOne(sub, loaded.identities, humanResolved, summary);
  }

  return summary;
}

/**
 * One submission, against an already-loaded identity set.
 *
 * Extracted so the nightly run, the arrival hook and the button all go through
 * EXACTLY the same decision and the same writes. A second copy of this would be
 * a second matcher with a different name.
 */
async function matchOne(
  sub: { id: number; payload: Record<string, unknown> },
  identities: ContactIdentity[],
  humanResolved: Set<number>,
  summary: MatchRunSummary,
): Promise<void> {
  if (humanResolved.has(sub.id)) {
    summary.skippedHumanResolved += 1;
    return;
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
    return;
  }

  const outcome = matchSubmission(identity, identities);
  await markAutoMatchResult({
    submissionId: sub.id,
    status: outcome.status,
    reason: outcome.reason,
    contactId: outcome.contactId,
    chartId: outcome.status === "matched" ? outcome.chartId : null,
    candidateIds: outcome.candidateIds,
  });
  // Mirror the link onto the submission itself. On a review verdict this
  // CLEARS any previously written contact_id, so a row that stops matching
  // (a contact edited, a duplicate appearing) does not keep a stale link.
  await setSubmissionContactId(sub.id, outcome.status === "matched" ? outcome.contactId : null);

  // A match that resolved a CRM contact AND a chart records the link, so the
  // next pull's collapse has something to collapse on. Written only from
  // evidence — never guessed, never backfilled.
  if (outcome.status === "matched" && outcome.contactId !== null && outcome.chartId) {
    await linkContactToChart(outcome.contactId, outcome.chartId).catch(() => { /* best effort */ });
  }
  if (outcome.status === "matched" && outcome.chartId) summary.matchedWithChart += 1;

  summary.considered += 1;
  if (outcome.status === "matched") summary.matched += 1;
  else summary.review += 1;
  summary.byReason[outcome.reason] = (summary.byReason[outcome.reason] ?? 0) + 1;
}

/** An empty summary, so every caller counts the same things. */
function emptySummary(): MatchRunSummary {
  return {
    considered: 0, skippedHumanResolved: 0, matched: 0, review: 0,
    crmContacts: 0, tnPatients: 0, identities: 0, matchedWithChart: 0,
    byReason: {},
  };
}

/**
 * Load both populations and collapse them. Shared by every entry point so the
 * identity set is built one way.
 */
async function loadIdentities(): Promise<{
  identities: ContactIdentity[]; crmCount: number; tnCount: number;
}> {
  const [contacts, tnPatients] = await Promise.all([
    getContactIdentityIndex(),
    // The population the matcher could not see. An empty table — no pull has
    // run yet, or last night's failed — simply means matching behaves exactly
    // as it did before this build.
    getTnPatientIdentities().catch(() => []),
  ]);
  // ONE IDENTITY PER PERSON, ACROSS BOTH POPULATIONS. A CRM contact carrying a
  // chart id and the TherapyNotes patient with that chart are the same person
  // and must arrive as ONE candidate — two would agree on name and date of
  // birth and be correctly called ambiguous, turning a well-known patient into
  // a review item.
  const tnIdentities: ContactIdentity[] = tnPatients.map((p) => ({
    contactId: null, name: p.name, email: null, phone: p.phone || null,
    patientDob: p.dob, chartId: p.chartId, clinicians: p.clinicians,
    source: "therapynotes" as const,
  }));
  return {
    identities: collapseIdentities(contacts, tnIdentities),
    crmCount: contacts.length,
    tnCount: tnIdentities.length,
  };
}

/**
 * Match ONE submission, on arrival.
 *
 * NEVER CALLED FROM THE REQUEST PATH. The public survey endpoint hands this to
 * the event loop and answers the client immediately — a slow match must not sit
 * between someone pressing Submit and their confirmation screen. See
 * server/survey/routes.ts.
 *
 * Failing to match is not an error: the row goes to review, which is what the
 * review queue is for. Failing to RUN is an error and is logged as one.
 */
export async function matchOneSubmission(submissionId: number): Promise<MatchRunSummary> {
  return withMatchLock(async () => {
    const summary = emptySummary();
    // ONE ROW, BY ID. The nightly pass reads a thousand submissions because it
    // is re-deciding all of them; this one already knows which row arrived, and
    // reading the other 999 to find it would make the cheap path the expensive
    // one.
    const [sub, humanResolved, loaded] = await Promise.all([
      getSubmissionById(submissionId),
      getHumanResolvedIds(),
      loadIdentities(),
    ]);
    summary.crmContacts = loaded.crmCount;
    summary.tnPatients = loaded.tnCount;
    summary.identities = loaded.identities.length;

    if (!sub || sub.formType !== "survey") {
      // Not an error worth throwing: the row may have been removed, or this may
      // be a non-survey submission that never belonged in the matcher.
      console.warn(`[survey-match] arrival: no survey submission ${submissionId}`);
      return summary;
    }
    await matchOne(sub, loaded.identities, humanResolved, summary);
    console.log(
      `[survey-match] arrival id=${submissionId}: ` +
      `${summary.matched ? "matched" : "review"}` +
      `${summary.matchedWithChart ? " (with chart)" : ""}`,
    );
    return summary;
  });
}

/**
 * THE GUARD THAT MAKES OVERLAP HARMLESS.
 *
 * Three things can now start a match: an arriving submission, the 03:00 pull
 * finishing, and the button. They can coincide — a survey landing at 03:01 is
 * the obvious case. Serialising them in-process means the second waits rather
 * than interleaving, so two runs cannot read the same row and write two
 * verdicts for it.
 *
 * The table cannot hold duplicates in any case: survey_match_reviews is keyed
 * on submission_id and every write is an upsert guarded by
 * `resolved_by IS NULL`. This lock is the belt to that brace — it makes the
 * OUTCOME deterministic rather than merely the row count.
 *
 * EXPORTED FOR THE OVERLAP SELF-CHECK. scripts/test-survey-auto-matching.ts
 * drives it directly with instrumented functions, because the property worth
 * proving — that two runs cannot interleave — is a property of this helper and
 * not of any one caller.
 */
let matchInFlight: Promise<unknown> = Promise.resolve();
export function withMatchLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = matchInFlight.then(fn, fn);
  // Swallow on the CHAIN only, so one failure does not poison every later run;
  // the caller still sees its own rejection.
  matchInFlight = next.then(() => undefined, () => undefined);
  return next;
}
