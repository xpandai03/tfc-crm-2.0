/**
 * Sending a survey PDF to a patient's chart.
 * ============================================================================
 *
 * The agent's attach route takes identifying details and a PDF URL, finds the
 * patient in TherapyNotes, verifies name, date of birth, phone and assigned
 * clinician against the chart, and refuses with a named reason if any check
 * fails. This module decides WHICH submissions may be sent, builds the payload,
 * and records what came back. It asks the agent for nothing new.
 *
 * ELIGIBILITY IS DELIBERATELY NARROW. A survey filed to the wrong chart is a
 * PHI disclosure that cannot be undone; a refusal costs a staff member a minute.
 * The agent verifies four fields, and a verification that skips a field it did
 * not receive is not a verification — so every field it checks must be present
 * before anything is sent, and a submission awaiting review is never sent at
 * all. That is what the review queue is for.
 *
 * NO PHI IN ANY LOG LINE. Submission ids, contact ids, counts, reason codes and
 * durations only — the same discipline as the survey write path and the
 * tn-progress callback.
 */

import { getSubmissionById, getRecentSurveySubmissions, type FormSubmission } from "../sync/db";
import { SURVEY_FORM_TYPE } from "@shared/survey-questions";
import { logActivity } from "../activity/db";
import { getMatchState } from "./match-db";
import {
  claimAttach,
  getAttachRow,
  getAttachedOrRunningIds,
  recordAttachOutcome,
} from "./attach-db";
import type { AttachIneligibleCode } from "@shared/survey-attach-reasons";

/** The agent's route. Derived from the create flow's base, same as V2. */
const AGENT_BASE_URL =
  process.env.TN_AGENT_BASE_URL ||
  (process.env.TN_AGENT_URL || "https://axiom-browser-agent-clone-production.up.railway.app/api/tn/create-patient")
    .replace(/\/api\/tn\/.*$/, "");
export const SURVEY_ATTACH_AGENT_URL = `${AGENT_BASE_URL}/api/tn/attach-survey-to-chart`;

/**
 * How long to wait on one attach.
 *
 * The client measured 45–75s per job, every one paying a full login. 180s is a
 * ceiling with room for a slow login, well under the create flow's 240s. A
 * timeout is recorded as a FAILURE whose wording warns the chart may have been
 * written anyway — because it may have been, and telling someone to file again
 * without checking is how a duplicate gets made.
 */
export const ATTACH_TIMEOUT_MS = 180_000;

/**
 * Most submissions one scheduled run may attempt.
 *
 * The agent serialises — one job at a time, each 45–75s — so twelve is roughly
 * 9 to 15 minutes of agent time. That comfortably clears the overnight window
 * while guaranteeing the agent is free long before staff arrive, which is the
 * constraint the client actually set: survey attaches must never compete with
 * scheduling runs during the working day. A backlog larger than the cap is not
 * lost, it is simply taken over successive nights, and the run logs how many
 * were left.
 */
export const ATTACH_BATCH_CAP = 12;

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface AttachPayloadFields {
  firstName: string;
  lastName: string;
  /** MM/DD/YYYY, the form the agent's schema requires. */
  dob: string;
  phone: string;
  clinicianName: string;
  contactId: number;
}

export type Eligibility =
  | { eligible: true; fields: AttachPayloadFields }
  | { eligible: false; code: AttachIneligibleCode };

/** ISO YYYY-MM-DD to MM/DD/YYYY. Anything else is not a date we will send. */
function isoToMMDDYYYY(raw: unknown): string | null {
  const m = String(raw ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/**
 * Split a legal name into the two parts the agent's search needs.
 *
 * Last token is the surname, everything before it the given name(s). A middle
 * name the client typed therefore travels in first_name, which is what the
 * chart usually holds. The reverse case — a chart holding a middle name the
 * client did NOT type — is the known search miss, and it surfaces as
 * patient_not_found with wording that says so.
 */
function splitName(full: string): { firstName: string; lastName: string } | null {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

/**
 * May this submission be sent to a chart, and with what?
 *
 * THE RULE, all of which must hold:
 *   1. it is a survey
 *   2. the matcher resolved it to exactly one contact — status "matched".
 *      A row awaiting review, or resolved to "no contact", is never sent.
 *   3. it carries a usable legal name (at least two tokens)
 *   4. it carries a real date of birth
 *   5. it carries a phone — the agent requires one, and a survey taken before
 *      the form asked for it simply cannot be verified
 *   6. it names a therapist
 *
 * Pure apart from the match lookup, so the button and the scheduled run agree
 * by construction rather than by both remembering the same list.
 */
export async function checkEligibility(submission: FormSubmission): Promise<Eligibility> {
  if (submission.formType !== SURVEY_FORM_TYPE) {
    return { eligible: false, code: "not_a_survey" };
  }

  const state = await getMatchState(submission.id);
  if (!state || state.status === "review") return { eligible: false, code: "awaiting_review" };
  if (state.status !== "matched" || !state.matchedContactId) {
    return { eligible: false, code: "no_match" };
  }

  const p = (submission.payload ?? {}) as {
    client?: { name?: unknown; dateOfBirth?: unknown; phone?: unknown };
    answers?: { therapist?: unknown };
  };
  const name = typeof p.client?.name === "string" ? p.client.name : "";
  const split = splitName(name);
  if (!split) return { eligible: false, code: "no_name" };

  const dob = isoToMMDDYYYY(p.client?.dateOfBirth);
  if (!dob) return { eligible: false, code: "no_dob" };

  const phone = typeof p.client?.phone === "string" ? p.client.phone.trim() : "";
  // The agent's schema requires at least 7 digits; refuse locally rather than
  // send something it will reject.
  if (phone.replace(/\D/g, "").length < 7) return { eligible: false, code: "no_phone" };

  const clinician = typeof p.answers?.therapist === "string" ? p.answers.therapist.trim() : "";
  if (!clinician) return { eligible: false, code: "no_therapist" };

  return {
    eligible: true,
    fields: { ...split, dob, phone, clinicianName: clinician, contactId: state.matchedContactId },
  };
}

// ---------------------------------------------------------------------------
// One attach
// ---------------------------------------------------------------------------

export interface AttachResult {
  submissionId: number;
  status: "attached" | "failed" | "skipped";
  /** Reason code on failure; ineligibility code on skip. */
  reason: string | null;
  durationMs: number;
}

/** The document name TherapyNotes will show. Date and id only — never a name. */
export function attachDocumentName(submission: FormSubmission): string {
  const iso = (submission.submittedAt || submission.createdAt || "").slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : "undated";
  return `Client Survey ${date} (Sub ${submission.id})`;
}

/**
 * Claim, dispatch, record. The only function that talks to the agent.
 *
 * The claim happens BEFORE the dispatch and the outcome is written after, so a
 * process that dies mid-attach leaves a `running` row rather than a silent gap —
 * and that row blocks a retry until it ages out, because the chart may already
 * have the document.
 */
export async function attachOne(params: {
  submissionId: number;
  trigger: "manual" | "scheduled";
  actorEmail: string;
}): Promise<AttachResult> {
  const { submissionId, trigger, actorEmail } = params;
  const t0 = Date.now();

  const submission = await getSubmissionById(submissionId);
  if (!submission) return { submissionId, status: "skipped", reason: "not_a_survey", durationMs: 0 };

  const elig = await checkEligibility(submission);
  if (!elig.eligible) {
    console.warn(`[survey-attach] SKIPPED id=${submissionId} reason=${elig.code}`);
    return { submissionId, status: "skipped", reason: elig.code, durationMs: 0 };
  }

  if (!process.env.TN_API_KEY) {
    return { submissionId, status: "skipped", reason: "agent_unreachable", durationMs: 0 };
  }

  // Exclusive claim. Losing it is not an error — it means someone else, or the
  // scheduled run, is already on it, or it is already filed.
  const claimed = await claimAttach({
    submissionId, contactId: elig.fields.contactId, trigger, actorEmail,
  });
  if (!claimed) {
    // Losing the claim has two causes and they read very differently to a staff
    // member: "already filed" is finished, "filing now" is thirty seconds away.
    // Reporting the first for both would tell someone their colleague's
    // in-flight run had already succeeded.
    const existing = await getAttachRow(submissionId);
    const code = existing?.status === "running" ? "in_progress" : "already_attached";
    console.log(`[survey-attach] NOT CLAIMED id=${submissionId} (${code})`);
    return { submissionId, status: "skipped", reason: code, durationMs: 0 };
  }

  const baseUrl = (process.env.APP_URL || "https://tfc-crm-2-0.fly.dev").replace(/\/$/, "");
  const body = {
    first_name: elig.fields.firstName,
    last_name: elig.fields.lastName,
    dob: elig.fields.dob,
    phone: elig.fields.phone,
    clinician_name: elig.fields.clinicianName,
    pdf_url: `${baseUrl}/api/internal/survey-pdf/${submissionId}`,
    document_name: attachDocumentName(submission),
    contact_id: elig.fields.contactId,
  };

  let status: "attached" | "failed" = "failed";
  let reason: string | null = "unknown_error";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACH_TIMEOUT_MS);
  try {
    console.log(`[survey-attach] DISPATCH id=${submissionId} contact=${elig.fields.contactId} trigger=${trigger}`);
    const res = await fetch(SURVEY_ATTACH_AGENT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": process.env.TN_API_KEY! },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (res.status === 422 || res.status === 400) {
      reason = "agent_rejected_request";
    } else if (!res.ok) {
      reason = "agent_unreachable";
    } else {
      // The route answers synchronously with SurveyAttachOutput.
      let parsed: { status?: string; failure_reason?: string } | null = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (parsed?.status === "success") {
        status = "attached";
        reason = null;
      } else {
        reason = parsed?.failure_reason || "unknown_error";
      }
    }
  } catch (err) {
    reason = (err as Error)?.name === "AbortError" ? "agent_timeout" : "agent_unreachable";
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - t0;
  await recordAttachOutcome({ submissionId, status, reason, durationMs });

  // Audit trail. entityName is a FIXED string: logActivity persists it and the
  // Activity page renders it, so a client's name here would put them in a feed.
  await logActivity({
    type: status === "attached" ? "survey_attach_completed" : "survey_attach_failed",
    actorEmail: actorEmail || "system",
    entityType: "submission",
    entityId: String(submissionId),
    entityName: "Client survey",
    metadata: {
      submissionId, contactId: elig.fields.contactId, trigger,
      ...(reason ? { failureReason: reason } : {}), durationMs,
    },
  }).catch((e) => console.error("[survey-attach] activity write failed:", e instanceof Error ? e.message : "unknown"));

  console.log(
    `[survey-attach] ${status.toUpperCase()} id=${submissionId} ` +
    `${reason ? `reason=${reason} ` : ""}ms=${durationMs}`,
  );
  return { submissionId, status, reason, durationMs };
}

// ---------------------------------------------------------------------------
// The overnight batch
// ---------------------------------------------------------------------------

export interface AttachRunSummary {
  considered: number;
  eligible: number;
  attempted: number;
  attached: number;
  failed: number;
  /** Eligible but over the cap — taken on a later night. */
  deferred: number;
  byReason: Record<string, number>;
}

/**
 * Everything eligible and not already filed, oldest first.
 *
 * Oldest first because a survey's usefulness decays: the one that has been
 * waiting longest is the one a clinician is most likely to be missing.
 */
export async function findAttachable(limit: number): Promise<{ ready: FormSubmission[]; totalEligible: number }> {
  const [submissions, taken] = await Promise.all([
    getRecentSurveySubmissions(1000),
    getAttachedOrRunningIds(),
  ]);
  const ready: FormSubmission[] = [];
  // getRecentSurveySubmissions returns newest-first; reverse for oldest-first.
  for (const sub of [...submissions].reverse()) {
    if (taken.has(sub.id)) continue;
    const e = await checkEligibility(sub);
    if (e.eligible) ready.push(sub);
  }
  return { ready: ready.slice(0, limit), totalEligible: ready.length };
}

/**
 * The scheduled run.
 *
 * ONE AT A TIME, deliberately awaited in sequence. The agent serialises — a
 * second concurrent job does not double throughput, it produces a failure — so
 * concurrency here would buy nothing and cost correctness.
 *
 * A failure on one never stops the rest: attachOne resolves rather than throws,
 * and the loop is wrapped anyway.
 */
export async function runScheduledAttach(cap: number = ATTACH_BATCH_CAP): Promise<AttachRunSummary> {
  const summary: AttachRunSummary = {
    considered: 0, eligible: 0, attempted: 0, attached: 0, failed: 0, deferred: 0, byReason: {},
  };

  const { ready, totalEligible } = await findAttachable(cap);
  summary.eligible = totalEligible;
  summary.deferred = Math.max(0, totalEligible - ready.length);
  summary.considered = ready.length;

  for (const sub of ready) {
    try {
      const r = await attachOne({ submissionId: sub.id, trigger: "scheduled", actorEmail: "system" });
      if (r.status === "skipped") continue;
      summary.attempted += 1;
      if (r.status === "attached") summary.attached += 1;
      else {
        summary.failed += 1;
        const k = r.reason ?? "unknown_error";
        summary.byReason[k] = (summary.byReason[k] ?? 0) + 1;
      }
    } catch (e) {
      // Belt and braces: one submission must never take the batch down.
      summary.attempted += 1;
      summary.failed += 1;
      summary.byReason.unknown_error = (summary.byReason.unknown_error ?? 0) + 1;
      console.error(
        `[survey-attach] UNCAUGHT on id=${sub.id}:`,
        e instanceof Error ? e.message : "unknown",
      );
    }
  }

  return summary;
}
