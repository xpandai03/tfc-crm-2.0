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
] as const;

export type MatchedReason = typeof MATCHED_REASONS[number];
export type ReviewReason = typeof REVIEW_REASONS[number];
export type MatchReason = MatchedReason | ReviewReason;

const ALL: readonly string[] = [...MATCHED_REASONS, ...REVIEW_REASONS];

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
};

/** Label for any stored reason, including a human resolution's own sentence. */
export function reasonText(reason: string): string {
  return isMatchReason(reason) ? REASON_LABEL[reason] : reason;
}
