/**
 * What the form sends, built from the draft. Pure, so
 * scripts/test-survey-fields.ts can prove that the language a client read
 * changes nothing in the body except the `language` field itself.
 */

import {
  SURVEY_VERSION,
  commentKeysFor,
  isCommentable,
  questionsFor,
  type SurveyLanguage,
  type SurveyQuestion,
  type SurveyVariant,
} from "@shared/survey-questions";
import type { SubmitBody } from "./api";

export type AnswerValue = string | number;

export interface Draft {
  client: { name: string; dateOfBirth: string; email: string; phone: string };
  answers: Record<string, AnswerValue>;
  /** Per-question free text, keyed by question key. Mirrors the stored shape. */
  comments: Record<string, string>;
  /**
   * The language the client chose. Kept with the draft so a reload keeps it,
   * and cleared with the draft on submit so a shared lobby phone does not hand
   * the next person the previous client's choice. Absent from drafts saved
   * before 2026-09-28.
   */
  language?: SurveyLanguage;
}

/**
 * Does this question's comment box appear on the form?
 *
 * Every commentable question EXCEPT the therapist pick on step 2, whose open
 * "Anything you would like to add?" box the client asked to remove
 * (2026-09-23). Decided here, not in isCommentable(): the server, the PDF and
 * the stored `comments.therapist` of earlier submissions are untouched, so old
 * rows still render their comment and an open tab running the previous bundle
 * can still submit. The form simply stops writing that key.
 */
export const showsCommentBox = (q: SurveyQuestion): boolean =>
  isCommentable(q) && q.kind !== "therapist";

export function buildSubmitBody(
  variant: SurveyVariant,
  draft: Draft,
  language: SurveyLanguage,
  formLoadedAt: number,
  company: string,
): SubmitBody {
  const questions = questionsFor(variant);
  const answers: Record<string, AnswerValue> = {};
  for (const q of questions) {
    const v = draft.answers[q.key];
    if (v !== undefined && v !== "") answers[q.key] = v;
  }

  // Only comments that were actually written. An empty box sends nothing, so
  // a client who wrote none sends no `comments` key at all — which is the
  // common case and keeps the row the size it was before.
  //
  // Keyed by commentKeysFor(), not by Object.keys(draft.comments): a stale
  // sessionStorage draft could hold a key for a question this variant does
  // not ask, and the server's .strict() would reject the whole submission for
  // it. Sending only what this variant can carry means a client's answers
  // survive a form change mid-run.
  //
  // The therapist key is skipped too: its box is gone (showsCommentBox), and
  // a draft saved before that could still hold text the client can no longer
  // see or edit. Nothing is sent that is not on screen.
  const comments: Record<string, string> = {};
  for (const key of commentKeysFor(variant)) {
    const q = questions.find((x) => x.key === key);
    if (!q || !showsCommentBox(q)) continue;
    const text = (draft.comments[key] ?? "").trim();
    if (text) comments[key] = text;
  }

  return {
    surveyVersion: SURVEY_VERSION,
    client: {
      name: draft.client.name.trim(),
      dateOfBirth: draft.client.dateOfBirth.trim(),
      email: draft.client.email.trim(),
      phone: draft.client.phone.trim(),
    },
    answers,
    ...(Object.keys(comments).length > 0 ? { comments } : {}),
    language,
    formLoadedAt,
    ...(company ? { company } : {}),
  };
}
