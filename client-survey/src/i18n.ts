/**
 * Language lookup for the public survey.
 *
 * The words live in shared/survey-copy.es.ts; this file only picks between
 * them. It never changes a value that gets stored: every function here takes
 * the stored value (an English option, a question key) and returns the text to
 * SHOW for it.
 */

import {
  DEFAULT_SURVEY_LANGUAGE,
  MODALITY_FOR_VARIANT,
  languageFromParam,
  type ScaleQuestion,
  type SurveyLanguage,
  type SurveyQuestion,
  type SurveyVariant,
} from "@shared/survey-questions";
import {
  ANCHOR_COPY,
  CONFIRMATION_COPY,
  MESSAGE_COPY,
  MODALITY_COPY,
  OPTION_COPY,
  QUESTION_COPY,
  UI_COPY,
  type Copy,
  type UiKey,
} from "@shared/survey-copy.es";

export type { SurveyLanguage };

/**
 * One side of a pair. An empty Spanish line falls back to the English rather
 * than rendering a blank label, so a half-applied correction cannot hide a
 * question.
 */
export function pick(copy: Copy | undefined, lang: SurveyLanguage, fallback = ""): string {
  if (!copy) return fallback;
  if (lang === "es" && copy.es.trim()) return copy.es;
  return copy.en || fallback;
}

/** "{n} of {total}" with the braces filled in. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** A screen, button or field string. */
export function ui(key: UiKey, lang: SurveyLanguage, vars?: Record<string, string | number>): string {
  const text = pick(UI_COPY[key], lang);
  return vars ? fill(text, vars) : text;
}

/**
 * A question's prompt. English is ALWAYS the original from
 * shared/survey-questions.ts, never the copy file's `en:` line, so the English
 * form renders exactly what it rendered before this file existed.
 */
export function promptFor(variant: SurveyVariant, q: SurveyQuestion, lang: SurveyLanguage): string {
  if (lang === "en") return q.prompt;
  const copy = QUESTION_COPY.byVariant[variant][q.key] ?? QUESTION_COPY.shared[q.key];
  return pick(copy, lang, q.prompt);
}

export function anchorsFor(
  q: ScaleQuestion,
  lang: SurveyLanguage,
): { low: string; high: string } {
  if (lang === "en") return { low: q.lowAnchor, high: q.highAnchor };
  const copy = ANCHOR_COPY[q.key];
  return {
    low: pick(copy?.low, lang, q.lowAnchor),
    high: pick(copy?.high, lang, q.highAnchor),
  };
}

/** The label for a stored option value. The value itself never changes. */
export function optionLabel(value: string, lang: SurveyLanguage): string {
  if (lang === "en") return value;
  return pick(OPTION_COPY[value], lang, value);
}

export function modalityLabel(variant: SurveyVariant, lang: SurveyLanguage): string {
  const modality = MODALITY_FOR_VARIANT[variant];
  return pick(MODALITY_COPY[modality], lang, modality);
}

/**
 * An error message from a validation rule or from the server, both of which
 * speak English. Unknown text is shown as it came rather than dropped.
 */
export function message(english: string | null, lang: SurveyLanguage): string | null {
  if (english === null) return null;
  if (lang === "en") return english;
  const es = MESSAGE_COPY[english];
  return es && es.trim() ? es : english;
}

export function confirmation(key: keyof typeof CONFIRMATION_COPY, lang: SurveyLanguage): string {
  return pick(CONFIRMATION_COPY[key], lang);
}

/** `?lang=es` on the page URL. Lets the practice hand out a Spanish QR code. */
export function languageFromSearch(search: string): SurveyLanguage | null {
  try {
    return languageFromParam(new URLSearchParams(search).get("lang"));
  } catch {
    return null;
  }
}

export { DEFAULT_SURVEY_LANGUAGE };
