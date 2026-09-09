/**
 * Survey-attach outcomes, in the words a scheduler reads.
 * ============================================================================
 *
 * The agent refuses with a field-specific code — name_mismatch, dob_mismatch,
 * phone_mismatch, clinician_mismatch, patient_not_found, multiple_candidates
 * and the rest (shared/schemas/survey_attach.py in the agent repository). Those
 * codes are the right thing to STORE: they are stable, groupable, and they
 * survive a rewording. They are the wrong thing to SHOW.
 *
 * So the code is what gets stored and the sentence is looked up from it — the
 * same split the match-review queue uses (@shared/survey-match-reasons).
 * Shared, because the server records the code and the Submissions page renders
 * the sentence, and a second copy would drift.
 *
 * TWO REFUSALS ARE EXPECTED AND ARE NOT BREAKAGE. Both are known, both are
 * being fixed agent-side, and neither is the client's fault:
 *
 *   - A survey giving a HOME phone. The chart is checked against the mobile
 *     number only, so the agent refuses on phone_mismatch.
 *   - A name entered WITHOUT a middle name where the chart holds one. The
 *     search misses and the agent refuses on patient_not_found.
 *
 * A staff member reading either of those needs to know the next step is the
 * download button, not a bug report. Every message below therefore ends by
 * pointing at the manual path — which works for every patient, and which the
 * client already accepted as the primary route.
 *
 * IMPORTS: none. Read by the server and by the CRM client.
 */

/** Every refusal code the agent can return. Mirrors SurveyAttachFailureReason. */
export const ATTACH_FAILURE_REASONS = [
  "login_failed",
  "practice_code_rejected",
  "search_ui_not_found",
  "patient_not_found",
  "multiple_candidates",
  "result_set_possibly_truncated",
  "chart_not_opened",
  "field_unreadable",
  "name_mismatch",
  "dob_mismatch",
  "phone_mismatch",
  "clinician_mismatch",
  "clinician_unassigned",
  "pdf_download_failed",
  "pdf_unsupported_format",
  "attach_failed",
  "unknown_error",
] as const;

export type AttachFailureReason = typeof ATTACH_FAILURE_REASONS[number];

/** Codes this module owns. Anything else is passed through as written. */
export function isAttachFailureReason(v: unknown): v is AttachFailureReason {
  return typeof v === "string" && (ATTACH_FAILURE_REASONS as readonly string[]).includes(v);
}

/** The one sentence every failure ends with. */
const FALL_BACK = "Download the PDF and attach it in TherapyNotes by hand.";

/**
 * What a scheduler reads. Each says what the agent found, in the terms of the
 * thing on their screen, and what to do next.
 *
 * No message says "verification", "payload", "selector" or "phase", and none
 * names a code. If a sentence here needs a glossary it is the wrong sentence.
 */
export const ATTACH_FAILURE_TEXT: Record<AttachFailureReason, string> = {
  // --- Things about the patient, which is what staff can actually act on ----
  patient_not_found:
    `No patient with this name and date of birth was found in TherapyNotes. ` +
    `This often happens when the chart holds a middle name the client did not ` +
    `type. Nothing is wrong with the survey. ${FALL_BACK}`,
  multiple_candidates:
    `More than one patient in TherapyNotes matches this name and date of birth, ` +
    `so the survey was not filed to any of them. ${FALL_BACK}`,
  result_set_possibly_truncated:
    `The TherapyNotes search returned too many results to be sure the right ` +
    `patient was among them, so nothing was filed. ${FALL_BACK}`,
  name_mismatch:
    `The name on the chart is not the name on the survey, so nothing was filed. ` +
    `Check you have the right client. ${FALL_BACK}`,
  dob_mismatch:
    `The date of birth on the survey does not match the chart, so nothing was ` +
    `filed. ${FALL_BACK}`,
  phone_mismatch:
    `The phone number on the survey does not match the mobile number on the ` +
    `chart. If the client gave a home number this is expected and nothing is ` +
    `wrong. ${FALL_BACK}`,
  clinician_mismatch:
    `The therapist named on the survey is not one of the therapists assigned to ` +
    `this patient in TherapyNotes, so nothing was filed. ${FALL_BACK}`,
  clinician_unassigned:
    `This patient has no therapist assigned in TherapyNotes, so the survey could ` +
    `not be checked against one. ${FALL_BACK}`,

  // --- Things about the run, which staff cannot act on except by falling back -
  login_failed:
    `Could not sign in to TherapyNotes, so nothing was filed. Try again later, ` +
    `or ${FALL_BACK.charAt(0).toLowerCase() + FALL_BACK.slice(1)}`,
  practice_code_rejected:
    `TherapyNotes did not accept the practice code, so nothing was filed. ` +
    `Someone will need to check the sign-in details. ${FALL_BACK}`,
  search_ui_not_found:
    `TherapyNotes did not look the way the automation expected, so nothing was ` +
    `filed. ${FALL_BACK}`,
  chart_not_opened:
    `The patient's chart did not open, so nothing was filed. ${FALL_BACK}`,
  field_unreadable:
    `One of the details on the chart could not be read, so the survey was not ` +
    `filed rather than filed unchecked. ${FALL_BACK}`,
  pdf_download_failed:
    `The survey PDF could not be fetched, so nothing was filed. ${FALL_BACK}`,
  pdf_unsupported_format:
    `The survey PDF was not in a form TherapyNotes accepts, so nothing was ` +
    `filed. ${FALL_BACK}`,
  attach_failed:
    `The patient was found and checked, but the upload itself did not complete. ` +
    `Check the chart before filing again, then ${FALL_BACK.charAt(0).toLowerCase() + FALL_BACK.slice(1)}`,
  unknown_error:
    `The automation stopped for a reason it could not name, so nothing was ` +
    `filed. ${FALL_BACK}`,
};

/** The CRM's own refusals, before the agent is ever called. */
export const ATTACH_LOCAL_REASONS = {
  agent_unreachable:
    `Could not reach the TherapyNotes automation, so nothing was filed. It may ` +
    `be restarting. ${FALL_BACK}`,
  agent_timeout:
    `The TherapyNotes automation did not finish in time. It may still have filed ` +
    `the survey — check the chart before filing again. ${FALL_BACK}`,
  agent_rejected_request:
    `The TherapyNotes automation would not accept this survey's details. ` +
    `${FALL_BACK}`,
} as const;

export type AttachLocalReason = keyof typeof ATTACH_LOCAL_REASONS;

/**
 * The sentence for any stored reason code, whatever produced it. An unknown
 * code is shown as-is rather than swallowed — a code nobody has worded yet is
 * still more useful on screen than silence.
 */
export function attachFailureText(reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  if (!r) return `The survey was not filed. ${FALL_BACK}`;
  if (isAttachFailureReason(r)) return ATTACH_FAILURE_TEXT[r];
  if (r in ATTACH_LOCAL_REASONS) return ATTACH_LOCAL_REASONS[r as AttachLocalReason];
  return `${r}. ${FALL_BACK}`;
}

/**
 * Why a submission cannot be attached at all. These gate the BUTTON, so each
 * has to say what is missing in a way that implies who fixes it.
 */
export const ATTACH_INELIGIBLE_TEXT = {
  not_a_survey: "Only client surveys can be filed to a chart.",
  awaiting_review:
    "This survey is not matched to a contact yet. Review the identity first, " +
    "then it can be filed.",
  no_match:
    "This survey has no matching contact, so there is no chart to file it to.",
  no_phone:
    "This survey was submitted before the form asked for a phone number, and " +
    "TherapyNotes cannot be checked without one. Download the PDF and attach it " +
    "by hand.",
  no_therapist: "This survey does not name a therapist, so the chart cannot be checked.",
  no_dob: "This survey has no usable date of birth, so the chart cannot be checked.",
  no_name: "This survey has no usable name, so the chart cannot be checked.",
  already_attached: "Already filed to the chart in TherapyNotes.",
  in_progress: "Filing to TherapyNotes now…",
} as const;

export type AttachIneligibleCode = keyof typeof ATTACH_INELIGIBLE_TEXT;

export function attachIneligibleText(code: string | null | undefined): string {
  const c = (code ?? "").trim();
  return c in ATTACH_INELIGIBLE_TEXT
    ? ATTACH_INELIGIBLE_TEXT[c as AttachIneligibleCode]
    : "This survey cannot be filed to a chart.";
}
