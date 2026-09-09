/**
 * Closed validation schema for the public survey submission.
 * ============================================================================
 *
 * BUILT FROM shared/survey-questions.ts, never hand-listed. The accepted key
 * set, the accepted option values and every length cap are derived from the
 * instrument definition, so a question added there is accepted here and a key
 * that is not a question is impossible to store.
 *
 * CLOSED, NOT PERMISSIVE. Zod strips unknown keys on parse and `.strict()`
 * rejects them outright at the top level. The stored payload is rebuilt field
 * by field from the PARSED object below — req.body is never spread into the
 * row. This is the DrSnip intake app's rule (api/registration-partial.ts): a
 * payload carrying an unexpected field is impossible by construction, not by
 * the client being well-behaved.
 *
 * This deliberately does NOT reuse POST /api/submissions (server/routes.ts:6266),
 * which is public and accepts any object as `data`.
 */

import { z } from "zod";
import {
  CLIENT_EMAIL_MAX,
  CLIENT_NAME_MAX,
  CLIENT_PHONE_MAX,
  COMMENT_MAX,
  MODALITY_FOR_VARIANT,
  SCALE_MAX,
  SCALE_MIN,
  SURVEY_VERSION,
  THERAPIST_MAX,
  type SurveyQuestion,
  type SurveyVariant,
  commentKeysFor,
  dateOfBirthProblem,
  emailProblem,
  legalNameProblem,
  phoneProblem,
  questionsFor,
} from "@shared/survey-questions";

/**
 * Hard ceiling on the raw request body. The global express.json limit is 5mb
 * (server/index.ts:34-41), sized for the sync endpoint's 500-contact payload; a
 * survey that fits in a few kilobytes has no business anywhere near it. Checked
 * against the raw buffer in the route before anything is stored.
 */
export const SURVEY_MAX_BODY_BYTES = 64 * 1024;

/**
 * A submission arriving faster than this after the page rendered was not typed
 * by a person. Soft signal only — the client reports its own load time, so it
 * is forgeable; it costs nothing and catches unsophisticated scripted posts.
 */
export const SURVEY_MIN_COMPLETION_MS = 5000;

/** A load time further in the past than this is stale or fabricated. */
const SURVEY_MAX_COMPLETION_MS = 12 * 60 * 60 * 1000;

const trimmedString = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim());

/**
 * Answer validator for one question. Choice questions accept only their own
 * declared options; scales accept only an integer in range; text is capped at
 * the question's own limit.
 */
function answerSchemaFor(q: SurveyQuestion): z.ZodTypeAny {
  switch (q.kind) {
    case "choice":
      return z.enum([...q.options] as [string, ...string[]]);
    case "scale":
      return z.number().int().min(SCALE_MIN).max(SCALE_MAX);
    case "therapist":
      return trimmedString(q.maxLength).pipe(z.string().min(1));
    case "text":
      return trimmedString(q.maxLength);
  }
}

/**
 * The `answers` object for one variant: every required question present, every
 * optional one allowed, everything else stripped.
 */
function answersSchemaFor(variant: SurveyVariant) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const q of questionsFor(variant)) {
    const base = answerSchemaFor(q);
    shape[q.key] = q.required ? base : base.optional();
  }
  // .strict(): an unrecognised answer key is a rejected request, not a silently
  // dropped field. Loud beats quiet for the one object that holds free text.
  //
  // The retired "If no, please explain" keys are NOT in this shape any more, so
  // a stale cached bundle still posting one is rejected outright rather than
  // quietly writing a key nothing reads. See ChoiceQuestion.legacyExplain.
  return z.object(shape).strict();
}

/**
 * The `comments` object: one optional, capped string per commentable question,
 * and nothing else.
 *
 * EVERY entry is optional. The client was explicit that the rating and choice
 * questions stay mandatory and no comment is ever required, so there is no
 * branch here that can make one — the box is an invitation, and the schema is
 * the place that guarantees it.
 */
function commentsSchemaFor(variant: SurveyVariant) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const key of commentKeysFor(variant)) {
    shape[key] = trimmedString(COMMENT_MAX).optional();
  }
  return z.object(shape).strict();
}

/**
 * Identity. All four REQUIRED as of the 2026-09-03 client review — each one is
 * a field the pairing build lines up against the EHR record, and an absent one
 * is a submission that can never be filed to a chart.
 *
 * `name` is the client's LEGAL name; the form says so on the label. Nothing
 * here can enforce that, which is exactly why the label carries the weight.
 */
const clientSchema = z
  .object({
    name: trimmedString(CLIENT_NAME_MAX).pipe(z.string().min(1)),
    dateOfBirth: trimmedString(10),
    email: trimmedString(CLIENT_EMAIL_MAX).pipe(z.string().min(1)),
    // Stored as typed. Format is checked in the route by the shared
    // phoneProblem(), which counts digits rather than imposing a layout.
    phone: trimmedString(CLIENT_PHONE_MAX).pipe(z.string().min(1)),
  })
  .strict();

export function surveySubmissionSchema(variant: SurveyVariant) {
  return z
    .object({
      surveyVersion: z.literal(SURVEY_VERSION),
      client: clientSchema,
      answers: answersSchemaFor(variant),
      /**
       * Optional per-question free text. Optional as a whole AND per key: a
       * client who writes nothing sends no object at all, which is what the
       * majority of submissions will look like.
       */
      comments: commentsSchemaFor(variant).optional(),
      /** Epoch ms captured when the form first rendered. See the min-time check. */
      formLoadedAt: z.number().int().positive(),
      /**
       * Honeypot. Rendered, visually hidden, never labelled. A real client
       * cannot fill it; a form-filling bot will. Accepted here so the request
       * parses, then handled in the route — see handleHoneypot().
       */
      company: z.string().max(200).optional(),
    })
    .strict();
}

export type SurveySubmissionInput = z.infer<ReturnType<typeof surveySubmissionSchema>>;

/** True when the honeypot was filled. The caller returns success and stores nothing. */
export function honeypotTripped(input: SurveySubmissionInput): boolean {
  return typeof input.company === "string" && input.company.trim().length > 0;
}

export type TimingProblem = "too-fast" | "stale" | null;

export function completionTimingProblem(
  formLoadedAt: number,
  now: number,
): TimingProblem {
  const elapsed = now - formLoadedAt;
  // A clock ahead of the server reads as negative elapsed time. Treat it the
  // same as too-fast rather than accepting it.
  if (elapsed < SURVEY_MIN_COMPLETION_MS) return "too-fast";
  if (elapsed > SURVEY_MAX_COMPLETION_MS) return "stale";
  return null;
}

/**
 * The row payload. Built field by field from the parsed input — this function
 * is the only thing that decides what is stored.
 *
 * Shape is stable and versioned so the Sept 11 work (PDF rendering, contact
 * matching) can read it without guessing.
 */
export function buildSurveyPayload(
  variant: SurveyVariant,
  input: SurveySubmissionInput,
  submittedAt: string,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const q of questionsFor(variant)) {
    const value = input.answers[q.key];
    if (value !== undefined && value !== "") answers[q.key] = value;
  }

  // Comments live in their own object, keyed by the question key, so pairing a
  // comment to its question is a lookup. Only non-empty ones are stored — an
  // untouched box leaves no trace, and a submission with nothing written has no
  // `comments` key at all rather than eleven empty strings.
  //
  // There is no orphan case to clean up here. The old conditional box could be
  // filled on "No" and then stranded by switching to "Yes", so buildSurveyPayload
  // had to drop text whose revealing answer had changed. A comment box that is
  // always visible belongs to the question however it was answered, so what the
  // client wrote is what gets stored.
  const comments: Record<string, string> = {};
  for (const key of commentKeysFor(variant)) {
    const text = input.comments?.[key];
    if (typeof text === "string" && text !== "") comments[key] = text;
  }

  return {
    surveyVersion: SURVEY_VERSION,
    formVariant: variant,
    modality: MODALITY_FOR_VARIANT[variant],
    submittedAt,
    client: {
      name: input.client.name,
      dateOfBirth: input.client.dateOfBirth,
      email: input.client.email,
      phone: input.client.phone,
    },
    answers,
    ...(Object.keys(comments).length > 0 ? { comments } : {}),
  };
}

/**
 * Identity checks, re-run server-side with the SAME shared rules the form uses,
 * so the two cannot disagree about what is acceptable. The form blocks each of
 * these before the client can advance; a public endpoint cannot trust that.
 *
 * Returns the first problem found together with the field it belongs to, so the
 * route can name the field in its reply without ever echoing the VALUE back.
 */
export function serverDateOfBirthProblem(value: string, now: Date): string | null {
  return dateOfBirthProblem(value, now);
}

/** The identity fields, in the order the form asks for them. */
export const IDENTITY_FIELDS = ["name", "dateOfBirth", "email", "phone"] as const;
export type IdentityField = typeof IDENTITY_FIELDS[number];

/**
 * The message for an identity field that is MISSING, as opposed to malformed.
 *
 * Zod catches an absent key before serverIdentityProblem ever runs, and its own
 * issue text ("Required") is not something to put in front of a client. This
 * reuses the same shared rules by asking them about an empty value, so the
 * wording a client sees for "you left it out" is written in exactly one place.
 */
export function identityFieldMessage(field: IdentityField, now: Date): string {
  switch (field) {
    case "name": return legalNameProblem("") ?? "Please enter your legal name.";
    case "dateOfBirth": return dateOfBirthProblem("", now) ?? "Please enter your date of birth.";
    case "email": return emailProblem("") ?? "Please enter your email address.";
    case "phone": return phoneProblem("") ?? "Please enter your phone number.";
  }
}

/**
 * Which identity field a Zod issue path points at, if any.
 *
 * Paths look like ["client", "phone"]. Used so a schema-level rejection can
 * name the field just as precisely as serverIdentityProblem does — a client who
 * left the phone blank should be told which box, not "check the form".
 */
export function identityFieldFromPath(path: (string | number)[]): IdentityField | null {
  if (path[0] !== "client") return null;
  const field = path[1];
  return (IDENTITY_FIELDS as readonly unknown[]).includes(field)
    ? (field as IdentityField)
    : null;
}

export function serverIdentityProblem(
  client: SurveySubmissionInput["client"],
  now: Date,
): { field: "name" | "dateOfBirth" | "email" | "phone"; message: string } | null {
  const name = legalNameProblem(client.name);
  if (name) return { field: "name", message: name };
  const dob = dateOfBirthProblem(client.dateOfBirth, now);
  if (dob) return { field: "dateOfBirth", message: dob };
  const email = emailProblem(client.email);
  if (email) return { field: "email", message: email };
  const phone = phoneProblem(client.phone);
  if (phone) return { field: "phone", message: phone };
  return null;
}
