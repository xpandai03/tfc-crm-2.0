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
  MODALITY_FOR_VARIANT,
  SCALE_MAX,
  SCALE_MIN,
  SURVEY_VERSION,
  THERAPIST_MAX,
  type SurveyQuestion,
  type SurveyVariant,
  dateOfBirthProblem,
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
    if (q.kind === "choice" && q.explain) {
      // Always optional — the source form does not mark these required, and
      // making them required would be a change to the client's instrument.
      shape[q.explain.key] = trimmedString(q.explain.maxLength).optional();
    }
  }
  // .strict(): an unrecognised answer key is a rejected request, not a silently
  // dropped field. Loud beats quiet for the one object that holds free text.
  return z.object(shape).strict();
}

const clientSchema = z
  .object({
    name: trimmedString(CLIENT_NAME_MAX).pipe(z.string().min(1)),
    dateOfBirth: trimmedString(10),
    // Optional: a lobby QR submitter may not want to give one, and it is only
    // ever a matching hint. Not verified, never written to.
    email: trimmedString(CLIENT_EMAIL_MAX).optional(),
  })
  .strict();

export function surveySubmissionSchema(variant: SurveyVariant) {
  return z
    .object({
      surveyVersion: z.literal(SURVEY_VERSION),
      client: clientSchema,
      answers: answersSchemaFor(variant),
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
    if (q.kind === "choice" && q.explain) {
      const explain = input.answers[q.explain.key];
      // Only keep an explanation when it belongs to the answer that reveals it.
      // Otherwise a client who typed "No" with detail, then switched to "Yes",
      // would leave orphaned free text on the record.
      if (value === q.explain.revealOn && typeof explain === "string" && explain !== "") {
        answers[q.explain.key] = explain;
      }
    }
  }

  return {
    surveyVersion: SURVEY_VERSION,
    formVariant: variant,
    modality: MODALITY_FOR_VARIANT[variant],
    submittedAt,
    client: {
      name: input.client.name,
      dateOfBirth: input.client.dateOfBirth,
      ...(input.client.email ? { email: input.client.email } : {}),
    },
    answers,
  };
}

/**
 * Date-of-birth check, re-run server-side. The form blocks a bad date before
 * the client can advance, but a public endpoint cannot trust that.
 */
export function serverDateOfBirthProblem(value: string, now: Date): string | null {
  return dateOfBirthProblem(value, now);
}
