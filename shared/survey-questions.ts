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

/** Single-select. `explain` adds the source's optional "If no, please explain". */
export interface ChoiceQuestion {
  kind: "choice";
  key: string;
  slot: number;
  prompt: string;
  options: readonly string[];
  required: true;
  /** Present when the source form shows a follow-up text box under this question. */
  explain?: {
    key: string;
    prompt: string;
    /** The answer that reveals the box. Everything else hides it. */
    revealOn: string;
    maxLength: number;
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

/** Every explanation box in the source is a single-line input with no marked
 *  limit. 1000 characters is generous for a sentence or two and bounds the row. */
const EXPLAIN_MAX = 1000;

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
    explain: {
      key: "greetedOnArrivalExplain",
      prompt: "If no, please explain",
      revealOn: "No",
      maxLength: EXPLAIN_MAX,
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
    explain: {
      key: "seenWithinTenMinutesExplain",
      prompt: "If no, please explain",
      revealOn: "No",
      maxLength: EXPLAIN_MAX,
    },
  },
  {
    kind: "choice",
    key: "privacyRespected",
    slot: 5,
    prompt: "Did you feel your privacy was respected?",
    options: YES_NO_NA_OPTIONS,
    required: true,
    explain: {
      key: "privacyRespectedExplain",
      prompt: "If no, please explain",
      revealOn: "No",
      maxLength: EXPLAIN_MAX,
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
    explain: {
      key: "endedFeelingValuedExplain",
      prompt: "If no, please explain",
      revealOn: "No",
      maxLength: EXPLAIN_MAX,
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
    explain: {
      key: "techDifficultyResponseExplain",
      prompt: "If no, please explain",
      revealOn: "No",
      maxLength: EXPLAIN_MAX,
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
    explain: {
      key: "seenWithinTenMinutesExplain",
      prompt: "If no, please explain",
      revealOn: "No",
      maxLength: EXPLAIN_MAX,
    },
  },
  {
    kind: "choice",
    key: "privacyRespected",
    slot: 5,
    prompt: "Did you feel your privacy was respected in this treatment format?",
    options: YES_NO_NA_OPTIONS,
    required: true,
    explain: {
      key: "privacyRespectedExplain",
      prompt: "If no, please explain",
      revealOn: "No",
      maxLength: EXPLAIN_MAX,
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
    explain: {
      key: "endedFeelingValuedExplain",
      prompt: "If no, please explain",
      revealOn: "No",
      maxLength: EXPLAIN_MAX,
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
 * Every answer key a variant can legitimately produce, including the
 * conditional explanation boxes. This is what the server's closed schema is
 * built from — anything not in this set is stripped at parse.
 */
export function answerKeysFor(variant: SurveyVariant): string[] {
  const keys: string[] = [];
  for (const q of questionsFor(variant)) {
    keys.push(q.key);
    if (q.kind === "choice" && q.explain) keys.push(q.explain.key);
  }
  return keys;
}

// ============================================================================
// Identity fields
//
// NOT part of the source instrument. The TherapyNotes forms show the patient's
// name and date of birth in a merge-field header, auto-filled from the portal
// session; a public page has no session, so these become real questions. Client
// decision, 2026-08: all three are collected and will drive matching later.
// ============================================================================

export const CLIENT_NAME_MAX = 120;
export const CLIENT_EMAIL_MAX = 160;

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
