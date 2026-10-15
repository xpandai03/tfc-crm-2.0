/**
 * What a survey row on Submissions says about where it stands (2026-10-15).
 *
 * The bare "Matched" chip left staff asking "has it gone to the chart yet?".
 * One of three states replaces it, on every survey row and therefore in the
 * review queue (a filter over the same list):
 *
 *   Filed to TherapyNotes <date>     the attach is confirmed on the chart;
 *                                    "(staff)" when a person pressed the button
 *   Matched to CRM contact · files to TherapyNotes tonight 3:30 AM MT
 *                                    matched, not yet filed — the nightly batch
 *                                    (03:30 Mountain) will file it
 *   Needs review: <reason>           in the review queue, with its short reason
 *
 * Every label names its system (CRM or TherapyNotes) — client copy, 2026-10-15.
 *
 * A row with no match yet, or matched to no contact, keeps its existing chip
 * (null here). The filters and their counts are not touched.
 *
 * Pure. Codes, dates and fixed labels only — never identity or answers.
 */
import { REASON_SHORT, isMatchReason } from "./survey-match-reasons";

export interface RowMatch {
  status: "matched" | "review" | "no_contact";
  reason: string;
}

export interface RowAttach {
  status: "running" | "attached" | "failed";
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
}

export type SurveyRowState =
  | { kind: "filed"; text: string }
  | { kind: "files_tonight"; text: string }
  | { kind: "needs_review"; text: string };

export const FILES_TONIGHT_TEXT = "Matched to CRM contact · files to TherapyNotes tonight 3:30 AM MT";

/** "Oct 14" in Mountain time (the practice's day). */
export function filedDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Denver" });
}

export function surveyRowState(match: RowMatch | undefined, attach: RowAttach | undefined): SurveyRowState | null {
  if (attach?.status === "attached") {
    const when = filedDate(attach.finishedAt ?? attach.startedAt);
    const staff = attach.trigger === "manual" ? " (staff)" : "";
    return { kind: "filed", text: `Filed to TherapyNotes${when ? ` ${when}` : ""}${staff}` };
  }
  if (match?.status === "review") {
    const why = isMatchReason(match.reason) ? REASON_SHORT[match.reason] : "see details";
    return { kind: "needs_review", text: `Needs review: ${why}` };
  }
  if (match?.status === "matched") return { kind: "files_tonight", text: FILES_TONIGHT_TEXT };
  return null;
}
