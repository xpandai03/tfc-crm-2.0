/**
 * Client survey — the instrument, defined once.
 * ============================================================================
 *
 * Both the public survey bundle (client-survey/) and the server's closed
 * validation schema (server/survey/schema.ts) read this file. There is exactly
 * one definition of the questions so the two cannot drift: a key that exists
 * here is accepted by the schema, and a key that does not exist here is
 * stripped at parse and can never reach storage.
 *
 * WORDING IS VERBATIM FROM THE CLIENT'S THERAPYNOTES FORMS, TYPOS INCLUDED.
 * This is the practice's own instrument, not copy we own. Three source
 * inconsistencies are preserved deliberately and are NOT bugs in this file:
 *
 *   - Slot 3 (in person) reads "We're you greeted upon arrival?" — the source
 *     writes "We're" where it means "Were".
 *   - Slot 3 (telehealth) reads "If you had an technical difficulties…" — the
 *     source writes "an" where it means "any".
 *   - Slot 6 says "of value to us" on the in-person form and "a value to us"
 *     on the telehealth form, and slot 7's prompt carries a comma after
 *     "0-10" on telehealth but not on in person. Both are therefore
 *     modality-specific strings rather than shared ones.
 *
 * Do not correct any of these without the client asking for it.
 *
 * ANCHOR RECONSTRUCTION: a scale question's verbatim source text is
 * `${prompt} ${lowAnchor} & ${highAnchor}`. The UI shows the prompt and the two
 * anchors separately (a tap row reads better on a phone than an 11-item
 * dropdown), but fullPromptText() below reproduces the source string exactly
 * for storage, PDF rendering and reporting.
 *
 * IMPORTS: this module must stay dependency-free. It is compiled into a PUBLIC
 * bundle, so it may not import from shared/access-control.ts or anything that
 * transitively reaches it.
 */

export const SURVEY_VERSION = 1;

/**
 * form_submissions.form_type for a survey row. The Submissions page switches on
 * this, and the public write endpoint sets it — declared here so the two cannot
 * drift, since the page cannot import from server/.
 */
export const SURVEY_FORM_TYPE = "survey";

/** form_submissions.source. Versioned so a future v2 instrument is distinguishable. */
export const SURVEY_SOURCE = "client_survey_v1";

/** URL segment. Also the stored `formVariant`. */
export type SurveyVariant = "in-person" | "telehealth";

export const SURVEY_VARIANTS: readonly SurveyVariant[] = ["in-person", "telehealth"];

/**
 * Display/storage modality. These two strings are NOT invented here — they are
 * the same literal union the TherapyNotes V2 payload already uses for
 * `appointment_modality` (server/therapy-notes/types.ts:52), so a survey row
 * and an appointment row describe modality with the same vocabulary.
 */
export type SurveyModality = "In Person" | "Telehealth";

export const MODALITY_FOR_VARIANT: Record<SurveyVariant, SurveyModality> = {
  "in-person": "In Person",
  telehealth: "Telehealth",
};

export function variantFromPath(segment: string): SurveyVariant | null {
  const s = segment.trim().toLowerCase();
  return (SURVEY_VARIANTS as readonly string[]).includes(s) ? (s as SurveyVariant) : null;
}

// ============================================================================
// Question shapes
// ============================================================================

/** Single-select. */
export interface ChoiceQuestion {
  kind: "choice";
  key: string;
  slot: number;
  prompt: string;
  options: readonly string[];
  required: true;
  /**
   * RETIRED 2026-09-03, READ-ONLY. Until the client review these four questions
   * showed a conditional "If no, please explain" box that appeared only on a
   * "No", stored at this key inside `answers`. The client replaced that with a
   * comment box on EVERY answer (see COMMENT_* below), so nothing writes these
   * keys any more: the form does not render one, and the server's schema no
   * longer accepts one.
   *
   * The definition stays because 32 submissions already stored under the old
   * shape carry 14 of these values, and the PDF is the clinical record of what
   * those clients wrote. It is the only reader, it reads and never writes, and
   * it needs `prompt` to label the text with the question it actually answered.
   *
   * This is NOT a second comment mechanism — nothing can produce one. It is a
   * reader for data that already exists. Delete it once those rows are gone.
   */
  legacyExplain?: {
    key: string;
    prompt: string;
    /** The answer that used to reveal the box. */
    revealOn: string;
  };
}

/** 0–10, stored as an integer. */
export interface ScaleQuestion {
  kind: "scale";
  key: string;
  slot: number;
  prompt: string;
  lowAnchor: string;
  highAnchor: string;
  required: true;
}

/** Free text. Optional in the source, and it stays optional here. */
export interface TextQuestion {
  kind: "text";
  key: string;
  slot: number;
  prompt: string;
  required: false;
  maxLength: number;
}

/** Single-select over the live provider roster. */
export interface TherapistQuestion {
  kind: "therapist";
  key: string;
  slot: number;
  prompt: string;
  /** Client decision, 2026-08: single-select and required, unlike the source
   *  preview's unmarked checkbox list. */
  required: true;
  maxLength: number;
}

export type SurveyQuestion =
  | ChoiceQuestion
  | ScaleQuestion
  | TextQuestion
  | TherapistQuestion;

// ============================================================================
// Option sets
// ============================================================================

export const SATISFACTION_OPTIONS = [
  "Excellent",
  "Satisfied",
  "Neutral",
  "Could be better",
  "Needs improvement immediately",
] as const;

export const YES_NO_NA_OPTIONS = ["Yes", "No", "N/A"] as const;

export const YES_NO_OPTIONS = ["Yes", "No"] as const;

export const SCALE_MIN = 0;
export const SCALE_MAX = 10;

/**
 * Per-question comment box (client decision, 2026-09-03).
 *
 * The same 1000 characters the retired "If no, please explain" boxes allowed —
 * generous for a sentence or two, and it bounds the row. There are now eleven
 * of these instead of four, so the cap is what keeps a submission inside
 * SURVEY_MAX_BODY_BYTES; scripts/test-survey-fields.ts asserts that it does.
 */
export const COMMENT_MAX = 1000;

/**
 * The invitation on every comment box. Deliberately a question rather than an
 * instruction: the client asked for this so people can leave PRAISE, not only
 * explain a complaint, and "If no, please explain" only ever invited the latter.
 */
export const COMMENT_PROMPT = "Anything you would like to add?";

/** "Additional Comments" is the one field a client may write at length in. */
export const COMMENTS_MAX = 2000;

export const THERAPIST_MAX = 160;

// ============================================================================
// Slot 1 — shared
// ============================================================================

const THERAPIST_QUESTION: TherapistQuestion = {
  kind: "therapist",
  key: "therapist",
  slot: 1,
  prompt: "Please select the treating therapist's name",
  required: true,
  maxLength: THERAPIST_MAX,
};

// ============================================================================
// Slots 2–6 — modality specific
//
// Slots 2 and 3 are genuinely different questions between the two forms, so
// they carry different keys: conflating "was the facility clean" with "how was
// the video platform" under one key would make the eventual report wrong.
// Slots 4, 5 and 6 are the SAME question reworded for context, so they share a
// key and stay comparable across modalities — only their prompt text differs.
// ============================================================================

const IN_PERSON_MIDDLE: readonly SurveyQuestion[] = [
  {
    kind: "choice",
    key: "facilityClean",
    slot: 2,
    prompt: "Was the facility clean and inviting?",
    options: SATISFACTION_OPTIONS,
    required: true,
  },
  {
    kind: "choice",
    key: "greetedOnArrival",
    slot: 3,
    // Source typo preserved: "We're" for "Were".
    prompt: "We're you greeted upon arrival?",
    options: YES_NO_NA_OPTIONS,
    required: true,
    legacyExplain: {
      key: "greetedOnArrivalExplain",
      prompt: "If no, please explain",
      revealOn: "No",
    },
  },
  {
    kind: "choice",
    key: "seenWithinTenMinutes",
    slot: 4,
    prompt:
      "Were you called back to a room within 10 minutes of your scheduled appointment time?",
    options: YES_NO_NA_OPTIONS,
    required: true,
    legacyExplain: {
      key: "seenWithinTenMinutesExplain",
      prompt: "If no, please explain",
      revealOn: "No",
    },
  },
  {
    kind: "choice",
    key: "privacyRespected",
    slot: 5,
    prompt: "Did you feel your privacy was respected?",
    options: YES_NO_NA_OPTIONS,
    required: true,
    legacyExplain: {
      key: "privacyRespectedExplain",
      prompt: "If no, please explain",
      revealOn: "No",
    },
  },
  {
    kind: "choice",
    key: "endedFeelingValued",
    slot: 6,
    // "of value" here; the telehealth form says "a value". Preserved.
    prompt: "Did you end session feeling like you are of value to us?",
    options: YES_NO_NA_OPTIONS,
    required: true,
    legacyExplain: {
      key: "endedFeelingValuedExplain",
      prompt: "If no, please explain",
      revealOn: "No",
    },
  },
];

const TELEHEALTH_MIDDLE: readonly SurveyQuestion[] = [
  {
    kind: "choice",
    key: "platformSatisfaction",
    slot: 2,
    prompt:
      "How satisfied were you with the Telehealth platform or telephone for your session?",
    options: SATISFACTION_OPTIONS,
    required: true,
  },
  {
    kind: "choice",
    key: "techDifficultyResponse",
    slot: 3,
    // Source typo preserved: "an technical" for "any technical".
    prompt:
      "If you had an technical difficulties, did you receive a prompt call from your provider to resolve the issue?",
    options: YES_NO_NA_OPTIONS,
    required: true,
    legacyExplain: {
      key: "techDifficultyResponseExplain",
      prompt: "If no, please explain",
      revealOn: "No",
    },
  },
  {
    kind: "choice",
    key: "seenWithinTenMinutes",
    slot: 4,
    prompt:
      "Were you called within 10 minutes of your appointment time to begin your session?",
    options: YES_NO_NA_OPTIONS,
    required: true,
    legacyExplain: {
      key: "seenWithinTenMinutesExplain",
      prompt: "If no, please explain",
      revealOn: "No",
    },
  },
  {
    kind: "choice",
    key: "privacyRespected",
    slot: 5,
    prompt: "Did you feel your privacy was respected in this treatment format?",
    options: YES_NO_NA_OPTIONS,
    required: true,
    legacyExplain: {
      key: "privacyRespectedExplain",
      prompt: "If no, please explain",
      revealOn: "No",
    },
  },
  {
    kind: "choice",
    key: "endedFeelingValued",
    slot: 6,
    // "a value" here; the in-person form says "of value". Preserved.
    prompt: "Did you end session feeling like you are a value to us?",
    options: YES_NO_NA_OPTIONS,
    required: true,
    legacyExplain: {
      key: "endedFeelingValuedExplain",
      prompt: "If no, please explain",
      revealOn: "No",
    },
  },
];

// ============================================================================
// Slots 7–12 — shared, except slot 7's comma (see the header note)
// ============================================================================

const SCALE_QUESTIONS: readonly ScaleQuestion[] = [
  {
    kind: "scale",
    key: "connectionRating",
    slot: 7,
    // In-person wording. Telehealth adds a comma after "0-10"; see
    // TELEHEALTH_PROMPT_OVERRIDES below.
    prompt:
      "On a scale of 0-10 how would you rate your connection with your therapist?",
    lowAnchor: "0-Not being heard, understood or respected",
    highAnchor: "10- Felt heard, understood, and respected",
    required: true,
  },
  {
    kind: "scale",
    key: "goalsRating",
    slot: 8,
    prompt:
      "On a scale of 0-10, how would you rate your goals and topics for session?",
    lowAnchor: "0-Did not work or talk about goals",
    highAnchor: "10-Worked or talked about goals",
    required: true,
  },
  {
    kind: "scale",
    key: "approachRating",
    slot: 9,
    prompt:
      "On a scale of 0-10, how would you rate your therapist's approach or methods?",
    lowAnchor: "0- The approach is not a good fit for me",
    highAnchor: "10-The approach is a good fit for me",
    required: true,
  },
  {
    kind: "scale",
    key: "overallRating",
    slot: 10,
    prompt: "On a scale of 0-10, how would you rate your session overall?",
    lowAnchor: "0- There was something missing in session",
    highAnchor: "10- Overall session was right for me",
    required: true,
  },
];

const FOLLOW_UP_QUESTION: ChoiceQuestion = {
  kind: "choice",
  key: "followUpRequested",
  slot: 11,
  prompt: "Would you like our team to follow up with you regarding your survey?",
  // The source offers only Yes/No here — no N/A, unlike slots 3 through 6.
  options: YES_NO_OPTIONS,
  required: true,
};

const COMMENTS_QUESTION: TextQuestion = {
  kind: "text",
  key: "additionalComments",
  slot: 12,
  prompt: "Additional Comments",
  required: false,
  maxLength: COMMENTS_MAX,
};

/**
 * Prompts that differ on the telehealth form only in ways too small to justify
 * a separate question. Keyed by question key.
 */
const TELEHEALTH_PROMPT_OVERRIDES: Record<string, string> = {
  connectionRating:
    "On a scale of 0-10, how would you rate your connection with your therapist?",
};

// ============================================================================
// Assembly
// ============================================================================

function applyOverrides(
  questions: readonly SurveyQuestion[],
  overrides: Record<string, string>,
): SurveyQuestion[] {
  return questions.map((q) =>
    overrides[q.key] ? ({ ...q, prompt: overrides[q.key] } as SurveyQuestion) : q,
  );
}

/** The full ordered instrument for one variant, slots 1 through 12. */
export function questionsFor(variant: SurveyVariant): SurveyQuestion[] {
  const middle = variant === "in-person" ? IN_PERSON_MIDDLE : TELEHEALTH_MIDDLE;
  const tail: SurveyQuestion[] = [
    ...SCALE_QUESTIONS,
    FOLLOW_UP_QUESTION,
    COMMENTS_QUESTION,
  ];
  const assembled = [THERAPIST_QUESTION, ...middle, ...tail];
  return variant === "telehealth"
    ? applyOverrides(assembled, TELEHEALTH_PROMPT_OVERRIDES)
    : [...assembled];
}

/** Look up one question by slot within a variant. */
export function questionAtSlot(
  variant: SurveyVariant,
  slot: number,
): SurveyQuestion | undefined {
  return questionsFor(variant).find((q) => q.slot === slot);
}

/**
 * The verbatim source text for a question — what a PDF or a report should
 * print. For a scale this reassembles prompt + anchors exactly as the
 * TherapyNotes form renders them.
 */
export function fullPromptText(q: SurveyQuestion): string {
  return q.kind === "scale" ? `${q.prompt} ${q.lowAnchor} & ${q.highAnchor}` : q.prompt;
}

/**
 * Every answer key a variant can legitimately produce. This is what the
 * server's closed schema is built from — anything not in this set is stripped
 * at parse. The retired legacyExplain keys are NOT here: they can no longer be
 * submitted, only read off rows that already hold them.
 */
export function answerKeysFor(variant: SurveyVariant): string[] {
  return questionsFor(variant).map((q) => q.key);
}

// ============================================================================
// Per-question comments (client decision, 2026-09-03)
//
// "if they want to add positive feedback I think we'd want to know that as
// well." The old conditional box only opened on a "No", so the instrument could
// record a complaint and not a compliment. Every question now carries an
// optional box that is visible whatever the answer.
//
// ONE MECHANISM PER QUESTION. This REPLACED the conditional box rather than
// joining it — see ChoiceQuestion.legacyExplain for why the retired definition
// is still in the file and who is allowed to read it.
//
// STORED SEPARATELY FROM `answers`, in a sibling `comments` object keyed by the
// QUESTION KEY:
//
//   answers:  { greetedOnArrival: "Yes", overallRating: 9, ... }
//   comments: { greetedOnArrival: "Front desk was lovely.", ... }
//
// so pairing a comment with the question it belongs to is a key lookup and
// nothing else — the export the client asked for is
// `questionsFor(variant).map(q => [fullPromptText(q), comments[q.key]])`. It
// also keeps `answers` meaning exactly what it meant before, so the 32 stored
// submissions read back unchanged, and it gives the Submissions page a single
// object to exclude instead of eleven scattered keys.
// ============================================================================

/**
 * Does this question get a comment box?
 *
 * Every question except the "Additional Comments" free-text box itself. That
 * question's ANSWER already is the client's own prose; putting a comment field
 * under a comment field would be the two-mechanisms problem in miniature, and
 * a client facing two empty boxes cannot tell which one is wanted.
 */
export function isCommentable(q: SurveyQuestion): boolean {
  return q.kind !== "text";
}

/** The questions that carry a comment box, in slot order. */
export function commentableQuestionsFor(variant: SurveyVariant): SurveyQuestion[] {
  return questionsFor(variant).filter(isCommentable);
}

/** Every key the `comments` object may legitimately carry. */
export function commentKeysFor(variant: SurveyVariant): string[] {
  return commentableQuestionsFor(variant).map((q) => q.key);
}

/**
 * A comment paired with the question it answers, ready for the PDF or an
 * export. Skips questions the client left blank.
 */
export function pairedComments(
  variant: SurveyVariant,
  comments: Record<string, unknown> | null | undefined,
): { key: string; prompt: string; comment: string }[] {
  const out: { key: string; prompt: string; comment: string }[] = [];
  for (const q of commentableQuestionsFor(variant)) {
    const raw = comments?.[q.key];
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text) out.push({ key: q.key, prompt: fullPromptText(q), comment: text });
  }
  return out;
}

// ============================================================================
// Identity fields
//
// NOT part of the source instrument. The TherapyNotes forms show the patient's
// name and date of birth in a merge-field header, auto-filled from the portal
// session; a public page has no session, so these become real questions.
//
// CLIENT REVIEW, 2026-09-03 — all four are now REQUIRED, because every one of
// them is a field the matcher lines up against the EHR record:
//
//   - LEGAL NAME, not preferred name. The practice sees transgender and
//     non-binary clients whose preferred name is the one they would naturally
//     type, while the record carries the legal name from their insurance. A
//     preferred name matches nothing, and the failure is silent — the survey
//     stores fine and simply never pairs. The label has to say "legal" out
//     loud; a neutral "full name" is what produces the wrong answer.
//   - EMAIL was optional and is not any more: "it says optional here for email
//     address, that's going to be gone, we need that to match them."
//   - PHONE is new, and is the fourth matching field. The client's reasoning:
//     people mistype an email far more readily than their own phone number.
//
// Matching itself is the NEXT build. Nothing here reads these for matching;
// this collects them and stores them so that build has something to match on.
// ============================================================================

export const CLIENT_NAME_MAX = 120;
export const CLIENT_EMAIL_MAX = 160;

/** Long enough for "+1 (505) 555-0142 ext. 12" and short enough to bound a row. */
export const CLIENT_PHONE_MAX = 32;

/**
 * The helper line under the legal-name field.
 *
 * Written for a client to read on a phone in a waiting room, not for us: it
 * says which name and why, in one sentence, without naming the reason someone
 * might use a different one. Nobody should have to read an explanation about
 * themselves to fill in a form.
 */
export const LEGAL_NAME_HINT =
  "The name on your insurance or ID — not a preferred or shortened name. We need it to find your record.";

/** Oldest plausible date of birth. Anything before this is a typo, not a person. */
export const DOB_MIN_ISO = "1900-01-01";

/** ISO calendar date, YYYY-MM-DD, with a real month and day. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

/**
 * Shared date-of-birth rule so the form and the server agree on what they
 * reject. Returns null when acceptable, or a message written for the client.
 * `today` is injected so the server can use its own clock.
 */
export function dateOfBirthProblem(value: string, today: Date): string | null {
  const v = (value ?? "").trim();
  if (!v) return "Please enter your date of birth.";
  if (!isCalendarDate(v)) return "Please enter your date of birth as a real date.";
  if (v > today.toISOString().slice(0, 10)) {
    return "That date is in the future. Please check it.";
  }
  if (v < DOB_MIN_ISO) return "Please check the year on that date.";
  return null;
}

/**
 * Digits only, with a leading "+" preserved where the client typed one.
 *
 * Exported for the pairing build: comparing a typed phone against a stored one
 * has to happen on digits, because the two will never agree on brackets,
 * spaces, dashes or dots. Nothing here calls it for matching — the STORED value
 * is what the client typed, verbatim, so that a staff member reading the record
 * sees the number as it was given rather than a reformatted one.
 */
export function phoneDigits(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  const plus = v.startsWith("+") ? "+" : "";
  return plus + v.replace(/\D/g, "");
}

/**
 * Shared phone rule, run by the form and re-run by the server.
 *
 * DELIBERATELY LOOSE. People write "(505) 555-0142", "505.555.0142",
 * "+1 505 555 0142" and "5055550142", and every one of them is the same usable
 * number. This counts digits and nothing else: 10 is a US number, 11 is one
 * with the country code, and up to 15 is the E.164 ceiling for international.
 * Below 10 is a number that cannot be dialled, which is the only case worth
 * refusing — a rejection here costs a real response, and a slightly odd format
 * costs nothing because a person reads it before anyone rings it.
 */
export function phoneProblem(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return "Please enter your phone number.";
  const digits = v.replace(/\D/g, "");
  if (digits.length < 10) return "Please enter a phone number with at least 10 digits.";
  if (digits.length > 15) return "Please check that phone number.";
  return null;
}

/** Shared email rule. Same reasoning as phoneProblem: shape only, never a lookup. */
export function emailProblem(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return "Please enter your email address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Please check that email address.";
  if (v.length > CLIENT_EMAIL_MAX) return "Please check that email address.";
  return null;
}

/** Shared legal-name rule. */
export function legalNameProblem(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return "Please enter your legal name.";
  if (v.length > CLIENT_NAME_MAX) return "Please shorten that name.";
  return null;
}
