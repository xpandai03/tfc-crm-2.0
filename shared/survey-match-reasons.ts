/**
 * Survey → contact match outcomes, defined once.
 * ============================================================================
 *
 * WHY THIS IS SHARED RATHER THAN LIVING IN THE MATCHER
 * ----------------------------------------------------
 * The matcher (server/survey/matching.ts) produces these codes; the review
 * queue and the submissions list both display them, and neither can import from
 * server/. Before this file there were two hand-maintained copies of the label
 * map in client/src — already drifting in wording — and adding six codes would
 * have made three. One definition, imported by all three.
 *
 * NOT shared/survey-questions.ts: that module is compiled into the PUBLIC
 * survey bundle. Nothing about how staff match a submission to a chart belongs
 * in a file a client can download.
 *
 * A STRUCTURED CODE, NOT A SENTENCE. The client asked that a failure say which
 * criterion failed. The stored value is the CODE — a stable enum in
 * survey_match_reviews.reason — and the sentence is looked up from it at
 * display time. That way an export can group by failure without parsing prose,
 * the wording can be changed without rewriting stored rows, and
 * failedFieldFor() gives a consumer the field itself rather than a string to
 * pattern-match.
 *
 * IMPORTS: none, deliberately. This is read by server code, by the CRM client,
 * and potentially by an export; a dependency here would follow it into all of
 * them.
 */

/** Outcomes that resolve to exactly one contact. */
export const MATCHED_REASONS = [
  /** Name + date of birth agree and nothing contradicts. */
  "name_dob",
  /** ...and the email belongs to that contact. */
  "name_dob_email",
  /** ...and the phone belongs to that contact. */
  "name_dob_phone",
  /** ...and both do. */
  "name_dob_phone_email",
  /**
   * Several contacts agreed on everything else, and the therapist named on the
   * survey is assigned to exactly one of them. This is the couples case: a
   * partner seen individually and a partner seen as a couple share every
   * identity field TherapyNotes holds, and only the provider separates them.
   */
  "name_dob_provider",
] as const;

/** Outcomes that go to a human. */
export const REVIEW_REASONS = [
  /** The typed date of birth is not a date we can read. */
  "unparseable_dob",
  /** The typed name normalised to nothing. */
  "no_name",
  /** No contact carries this name at all. */
  "no_candidates",
  /** The name exists on record, but not with this date of birth. */
  "dob_mismatch",
  /** The phone is on record and belongs to nobody the name + dob point at. */
  "phone_contradiction",
  /** The email is on record and belongs to nobody the name + dob point at. */
  "email_contradiction",
  /** Several contacts matched and the survey named no therapist to separate them. */
  "multiple_candidates",
  /** Several matched; none of them is assigned to the therapist named. */
  "provider_no_match",
  /** Several matched; more than one is assigned to the therapist named. */
  "provider_ambiguous",

  // --- Sent back by FILING, not by matching (2026-09-25) --------------------
  //
  // The matcher resolved these, and then the agent opened the chart and refused
  // on a fact the chart holds. Retrying nightly cannot change that fact — #983
  // was refused on clinician_mismatch five nights running — so one refusal
  // routes the row here, with the field that failed, until a person looks.
  //
  // PREFIXED attach_, AND THE PREFIX IS LOAD-BEARING: markAutoMatchResult
  // leaves a row carrying one alone, so the 03:00 re-match cannot flip it back
  // to "matched" for the 03:30 batch to retry. isAttachRefusal() is the test.
  /** The therapist on the survey is not among the chart's assigned clinicians. */
  "attach_clinician_mismatch",
  /** The chart has no clinician assigned, so the therapist cannot be confirmed. */
  "attach_clinician_unassigned",
  /** The survey's phone matches neither number on the chart. */
  "attach_phone_mismatch",
  /** The chart's date of birth differs from the survey's. */
  "attach_dob_mismatch",
  /** The chart's name differs from the survey's. */
  "attach_name_mismatch",
  /** The chart the survey matched was not among the TherapyNotes search results. */
  "attach_chart_not_in_search",
  /** More than one chart carries this name and date of birth. */
  "attach_multiple_charts",
] as const;

export type MatchedReason = typeof MATCHED_REASONS[number];
export type ReviewReason = typeof REVIEW_REASONS[number];
export type MatchReason = MatchedReason | ReviewReason;

const ALL: readonly string[] = [...MATCHED_REASONS, ...REVIEW_REASONS];

/**
 * Which attach refusals are DATA MISMATCHES, and the review reason each becomes.
 *
 * A refusal listed here is a fact about the chart that no retry will change;
 * one refusal sends the row to review. Every other refusal — login, the search
 * page not rendering, a field that could not be read, the PDF, the agent
 * unreachable or slow — is treated as TRANSIENT: the row stays matched and the
 * next batch tries again.
 *
 * Deliberately NOT here, so they stay transient (ambiguous, and the rule is
 * "ambiguous is transient"):
 *   patient_not_found               a real absence, or a search miss (the
 *                                   half-table bug of 21 September refused
 *                                   with exactly this)
 *   result_set_possibly_truncated   a common surname today; the agent's cap
 *                                   can move
 *   field_unreadable                a render race as often as a blank field
 *   agent_rejected_request          our payload, not the chart
 *
 * Keyed by the agent's code as a plain string: this module imports nothing, and
 * the agent's vocabulary lives in @shared/survey-attach-reasons.
 */
export const ATTACH_REFUSAL_REVIEW_REASON: Readonly<Record<string, ReviewReason>> = {
  clinician_mismatch: "attach_clinician_mismatch",
  clinician_unassigned: "attach_clinician_unassigned",
  phone_mismatch: "attach_phone_mismatch",
  dob_mismatch: "attach_dob_mismatch",
  name_mismatch: "attach_name_mismatch",
  expected_chart_not_in_results: "attach_chart_not_in_search",
  multiple_candidates: "attach_multiple_charts",
};

/** The review reason for an attach refusal, or null when it is transient. */
export function reviewReasonForAttachRefusal(code: string | null | undefined): ReviewReason | null {
  return (code && Object.prototype.hasOwnProperty.call(ATTACH_REFUSAL_REVIEW_REASON, code))
    ? ATTACH_REFUSAL_REVIEW_REASON[code]
    : null;
}

/** Was this row sent to review by a filing refusal rather than by the matcher? */
export function isAttachRefusal(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.startsWith("attach_");
}

/** True for a code this module defines. A human resolution stores a sentence
 *  instead, so display code uses this to decide whether to look a label up. */
export function isMatchReason(value: unknown): value is MatchReason {
  return typeof value === "string" && ALL.includes(value);
}

/**
 * The criterion that decided the outcome — the machine-readable half of "say
 * which field failed". Null where no single field is responsible.
 */
export type MatchField = "name" | "dateOfBirth" | "phone" | "email" | "provider";

export const REASON_FIELD: Record<MatchReason, MatchField | null> = {
  name_dob: null,
  name_dob_email: null,
  name_dob_phone: null,
  name_dob_phone_email: null,
  name_dob_provider: "provider",

  unparseable_dob: "dateOfBirth",
  no_name: "name",
  no_candidates: "name",
  dob_mismatch: "dateOfBirth",
  phone_contradiction: "phone",
  email_contradiction: "email",
  // Multiplicity is not a failure OF a field — every field agreed, on more than
  // one person. The field that could have resolved it is the provider, and that
  // is what a staff member needs told.
  multiple_candidates: "provider",
  provider_no_match: "provider",
  provider_ambiguous: "provider",

  attach_clinician_mismatch: "provider",
  attach_clinician_unassigned: "provider",
  attach_phone_mismatch: "phone",
  attach_dob_mismatch: "dateOfBirth",
  attach_name_mismatch: "name",
  // WHICH CHART rather than a field that disagreed — but the chart search runs
  // on the surname, and the charts in question agree on name and date of birth,
  // so the name is where a reviewer starts.
  attach_chart_not_in_search: "name",
  attach_multiple_charts: "name",
};

export function failedFieldFor(reason: string): MatchField | null {
  return isMatchReason(reason) ? REASON_FIELD[reason] : null;
}

/**
 * What a staff member reads. Written to answer "why is this in front of me",
 * naming the field that decided it, and carrying no identity of any kind — the
 * label is rendered in a list beside other people's rows.
 */
export const REASON_LABEL: Record<MatchReason, string> = {
  name_dob: "Matched on name and date of birth",
  name_dob_email: "Matched on name, date of birth and email",
  name_dob_phone: "Matched on name, date of birth and phone",
  name_dob_phone_email: "Matched on name, date of birth, phone and email",
  name_dob_provider: "Matched on name and date of birth; the therapist named separated two identical records",

  unparseable_dob: "Date of birth — could not be read",
  no_name: "Name — nothing was entered",
  no_candidates: "Name — no contact on record carries this name",
  dob_mismatch: "Date of birth — the name is on record, but not with this date of birth",
  phone_contradiction: "Phone — this number belongs to a different contact",
  email_contradiction: "Email — this address belongs to a different contact",
  multiple_candidates: "Several contacts match, and the survey named no therapist to tell them apart",
  provider_no_match: "Several contacts match, and none is assigned to the therapist named",
  provider_ambiguous: "Several contacts match, and more than one is assigned to the therapist named",

  attach_clinician_mismatch: "Clinician on survey does not match the chart's assigned clinician",
  attach_clinician_unassigned: "The chart has no assigned clinician, so the therapist on the survey could not be confirmed",
  attach_phone_mismatch: "Phone on survey matches neither number on the chart",
  attach_dob_mismatch: "Date of birth on survey does not match the chart",
  attach_name_mismatch: "Name on survey does not match the name on the chart",
  attach_chart_not_in_search: "The chart this survey matched did not appear in the TherapyNotes search — there may be a duplicate or renamed chart",
  attach_multiple_charts: "More than one TherapyNotes chart has this name and date of birth",
};

/** Short chip text for a dense list row. Full sentence lives in REASON_LABEL. */
export const REASON_SHORT: Record<MatchReason, string> = {
  name_dob: "Name + DOB",
  name_dob_email: "Name + DOB + email",
  name_dob_phone: "Name + DOB + phone",
  name_dob_phone_email: "Name + DOB + phone + email",
  name_dob_provider: "Separated by therapist",

  unparseable_dob: "Date of birth unreadable",
  no_name: "No name given",
  no_candidates: "No contact with this name",
  dob_mismatch: "Date of birth did not match",
  phone_contradiction: "Phone points elsewhere",
  email_contradiction: "Email points elsewhere",
  multiple_candidates: "Several matches, no therapist given",
  provider_no_match: "Several matches, therapist matched none",
  provider_ambiguous: "Several matches, therapist matched more than one",

  attach_clinician_mismatch: "Chart clinician differs",
  attach_clinician_unassigned: "Chart has no clinician",
  attach_phone_mismatch: "Chart phone differs",
  attach_dob_mismatch: "Chart date of birth differs",
  attach_name_mismatch: "Chart name differs",
  attach_chart_not_in_search: "Matched chart not found in search",
  attach_multiple_charts: "Several charts share name + DOB",
};

/** Label for any stored reason, including a human resolution's own sentence. */
export function reasonText(reason: string): string {
  return isMatchReason(reason) ? REASON_LABEL[reason] : reason;
}
