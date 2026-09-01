/**
 * The public survey's two network calls. Nothing else talks to the server.
 */

import type { SurveyVariant } from "@shared/survey-questions";

export interface PublicProvider {
  /** "Name (LOCATION)" — the shape the source form rendered. */
  label: string;
  name: string;
  credentials: string;
  location: string;
}

export interface RosterResult {
  providers: PublicProvider[];
  degraded: boolean;
}

export async function fetchRoster(): Promise<RosterResult> {
  const res = await fetch("/api/public/survey/providers", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return { providers: [], degraded: true };
  const json = (await res.json()) as {
    providers?: PublicProvider[];
    degraded?: boolean;
  };
  return {
    providers: Array.isArray(json.providers) ? json.providers : [],
    degraded: json.degraded === true,
  };
}

export interface SubmitBody {
  surveyVersion: number;
  client: { name: string; dateOfBirth: string; email?: string };
  answers: Record<string, string | number>;
  formLoadedAt: number;
  company?: string;
}

export type SubmitResult =
  | { ok: true }
  | { ok: false; message: string };

const GENERIC_FAILURE =
  "We could not save your response just now. Please try again.";

export async function submitSurvey(
  variant: SurveyVariant,
  body: SubmitBody,
): Promise<SubmitResult> {
  try {
    const res = await fetch(`/api/public/survey/${variant}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
    };
    if (res.ok && json.success === true) return { ok: true };
    // The server writes these messages for the client to read; they never
    // contain submitted values.
    return { ok: false, message: json.error || GENERIC_FAILURE };
  } catch {
    // Never log the body. A network failure tells us nothing worth the risk.
    return { ok: false, message: GENERIC_FAILURE };
  }
}
