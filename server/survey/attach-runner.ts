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
import { getMatchState, markAttachRefusalForReview } from "./match-db";
import { reviewReasonForAttachRefusal } from "@shared/survey-match-reasons";
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
  /**
   * The CRM contact, when there is one. NULL for a manual attach on an
   * unmatched survey — roughly half the practice's active patients predate the
   * CRM, so requiring a contact made them unattachable forever. The agent's own
   * schema has always had this as Optional; it is metadata, not a key.
   */
  contactId: number | null;
  /**
   * The TherapyNotes chart this submission's match resolved to, when it
   * resolved to one.
   *
   * NULL is an ordinary case, not a degraded one: a survey attached before
   * matching ran, or matched to a CRM contact that has never been linked to a
   * chart, has no id and is selected by name exactly as it always was.
   *
   * When it is set, it tells the agent WHICH record to open — which is what
   * lets a common surname or two people sharing a date of birth stop being a
   * refusal. It says nothing about whether to file: the agent still verifies
   * all four fields against the chart it opens.
   */
  chartId: string | null;
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
 *   2. the matcher reached "matched". A row awaiting review, or resolved to
 *      "no contact", is never sent.
 *   3. it carries a usable legal name (at least two tokens)
 *   4. it carries a real date of birth
 *   5. it carries a phone — the agent requires one, and a survey taken before
 *      the form asked for it simply cannot be verified
 *   6. it names a therapist
 *
 * A CRM CONTACT IS NOT ONE OF THE CONDITIONS, AND USED TO BE.
 *
 * This required `state.matchedContactId` to be non-null, which quietly excluded
 * the entire population the nightly pull was built to reach: a patient who
 * exists in TherapyNotes and not in the CRM matches with a chart id and no
 * contact id, and the batch skipped them as `no_match`. On 21 September the one
 * submission the preferred-name build exists for matched with chart
 * 1LOBs… and contact null, and the 03:30 run would have passed over it —
 * it could only be filed by a person pressing the button.
 *
 * The button never required a contact. checkIdentityEligibility says why: the
 * agent finds the patient in TherapyNotes and verifies name, date of birth,
 * phone and therapist against the chart, and a CRM contact was never part of
 * that. Two paths applying two rules to the same question is the defect; the
 * contact requirement was the wrong half.
 *
 * WHAT IS DELIBERATELY KEPT. The batch still requires a MATCH. The button does
 * not, and that asymmetry is not an oversight — the batch runs unattended, and
 * a chart nobody looked at is not something to widen on a schedule. A staff
 * member pressing the button has looked at the row. So this closes the gap the
 * client hit without turning the overnight job loose on the review queue.
 *
 * Pure apart from the match lookup, so the button and the scheduled run agree
 * by construction rather than by both remembering the same list.
 */
export async function checkEligibility(submission: FormSubmission): Promise<Eligibility> {
  const identity = checkIdentityEligibility(submission);
  if (!identity.eligible) return identity;

  const state = await getMatchState(submission.id);
  if (!state || state.status === "review") return { eligible: false, code: "awaiting_review" };
  if (state.status !== "matched") {
    return { eligible: false, code: "no_match" };
  }
  // The chart id rides along when the match found one. It is NOT part of the
  // eligibility rule — a match without a chart id is exactly as eligible as it
  // was yesterday, and is selected by name.
  return {
    eligible: true,
    fields: {
      ...identity.fields,
      contactId: state.matchedContactId,
      chartId: state.matchedChartId || null,
    },
  };
}

/**
 * May this submission be sent to a chart on its OWN details, with no contact?
 *
 * THE RULE, all of which must hold:
 *   1. it is a survey
 *   2. it carries a usable legal name (at least two tokens)
 *   3. it carries a real date of birth
 *   4. it carries a phone — the agent requires one, and a survey taken before
 *      the form asked for it simply cannot be verified
 *   5. it names a therapist
 *
 * NO MATCH IS REQUIRED, and that is the point of this function. The agent finds
 * the patient in TherapyNotes and verifies all four fields against the chart; a
 * CRM contact was never part of that and never needed to be. Requiring one made
 * every pre-CRM patient — about half the active caseload — permanently
 * unattachable, which is the gap this exists to close.
 *
 * WHAT IS SENT IS UNCHANGED EITHER WAY. Every field below comes from the
 * submission, exactly as it did before. The matched path added a contact id and
 * nothing else, so no data changes hands differently.
 *
 * Synchronous and pure: the button and the server derive the same verdict from
 * the same code rather than from two copies of the same list.
 */
export function checkIdentityEligibility(
  submission: FormSubmission,
): { eligible: true; fields: Omit<AttachPayloadFields, "contactId" | "chartId"> } | { eligible: false; code: AttachIneligibleCode } {
  if (submission.formType !== SURVEY_FORM_TYPE) {
    return { eligible: false, code: "not_a_survey" };
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

  return { eligible: true, fields: { ...split, dob, phone, clinicianName: clinician } };
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
  /** A data-mismatch refusal sent the row to review; the batch will not retry it. */
  sentToReview?: boolean;
}

/** The document name TherapyNotes will show. Date and id only — never a name. */
export function attachDocumentName(submission: FormSubmission): string {
  const iso = (submission.submittedAt || submission.createdAt || "").slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : "undated";
  return `Client Survey ${date} (Sub ${submission.id})`;
}

/**
 * The request body, from the fields eligibility produced.
 *
 * ONE BUILDER FOR BOTH TRIGGERS. The button and the overnight batch differ in
 * what they will ACCEPT — the batch is scoped to matched submissions, the
 * button is not — and in nothing else. They have always sent the same shape,
 * and extracting it here means they cannot drift into sending different ones:
 * there is no second place to add a field to and forget.
 *
 * Pure, so what is actually sent can be asserted rather than inferred from the
 * source of the function that sends it.
 */
export function buildAttachBody(params: {
  submissionId: number;
  fields: AttachPayloadFields;
  documentName: string;
  /** Defaults to the deployed CRM; injectable so a test need not set env. */
  baseUrl?: string;
}): Record<string, unknown> {
  const { submissionId, fields, documentName } = params;
  const baseUrl = (params.baseUrl ?? process.env.APP_URL ?? "https://tfc-crm-2-0.fly.dev")
    .replace(/\/$/, "");
  return {
    first_name: fields.firstName,
    last_name: fields.lastName,
    dob: fields.dob,
    phone: fields.phone,
    clinician_name: fields.clinicianName,
    pdf_url: `${baseUrl}/api/internal/survey-pdf/${submissionId}`,
    document_name: documentName,
    // Omitted rather than null when there is no contact. The agent's schema has
    // it Optional, and sending an explicit null says something different from
    // not saying it at all.
    ...(fields.contactId !== null ? { contact_id: fields.contactId } : {}),
    // Omitted rather than null for the same reason as contact_id: the agent
    // treats absent as "select by name", and an explicit null would be a third
    // thing to reason about on both sides.
    //
    // TRIMMED, and a blank counts as absent. The agent collapses blanks too, so
    // this changes nothing end to end — but sending "   " would mean the CRM
    // asserting it knows a record when it does not, and the place to stop that
    // is where the claim is made.
    ...((fields.chartId ?? "").trim() ? { expected_chart_id: fields.chartId!.trim() } : {}),
  };
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

  // THE ONLY DIFFERENCE BETWEEN THE TWO PATHS. The overnight batch stays scoped
  // to matched submissions exactly as it was: it runs unattended, and a chart it
  // picked without a human looking is not something to widen. A staff member
  // pressing the button has looked at the row, and the agent verifies all four
  // fields against the chart before it files anything.
  const elig: Eligibility = trigger === "scheduled"
    ? await checkEligibility(submission)
    : ((): Eligibility => {
        const id = checkIdentityEligibility(submission);
        return id.eligible
          ? { eligible: true, fields: { ...id.fields, contactId: null, chartId: null } }
          : id;
      })();
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

  // A manual attach on a row that IS matched still carries its contact id — the
  // id is useful metadata and withholding it would make the manual path record
  // less than the scheduled one for no reason.
  //
  // The chart id comes from the same lookup, and on its own terms: a matched
  // row can carry a chart id without a contact id, so this is deliberately not
  // nested inside the contact branch.
  if (trigger === "manual" && (elig.fields.contactId === null || elig.fields.chartId === null)) {
    const state = await getMatchState(submissionId).catch(() => null);
    if (state?.status === "matched") {
      if (elig.fields.contactId === null && state.matchedContactId) {
        elig.fields.contactId = state.matchedContactId;
      }
      if (elig.fields.chartId === null && state.matchedChartId) {
        elig.fields.chartId = state.matchedChartId;
      }
    }
  }

  const body = buildAttachBody({
    submissionId,
    fields: elig.fields,
    documentName: attachDocumentName(submission),
  });

  let status: "attached" | "failed" = "failed";
  let reason: string | null = "unknown_error";
  let tnPatientUrl: string | null = null;
  let selectionMode: string | null = null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACH_TIMEOUT_MS);
  try {
    console.log(
      `[survey-attach] DISPATCH id=${submissionId} ` +
      `contact=${elig.fields.contactId ?? "none"} trigger=${trigger} ` +
      // Presence only. A chart id names one patient's record as directly as a
      // name does, so it is not written to a log line.
      `expected_chart=${elig.fields.chartId ? "yes" : "no"}`,
    );
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
      let parsed: {
        status?: string; failure_reason?: string; tn_patient_url?: string;
        selection_mode?: string;
      } | null = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      // Recorded on BOTH outcomes. The question it answers is usually asked
      // about a refusal, so capturing it only on success would lose it exactly
      // when it is wanted.
      selectionMode = typeof parsed?.selection_mode === "string" ? parsed.selection_mode : null;
      if (parsed?.status === "success") {
        status = "attached";
        reason = null;
        // The chart the agent actually filed to. Recorded on the attempt so the
        // outcome is checkable, and so a later match has something to reconcile
        // against rather than guessing which chart this went to.
        tnPatientUrl = typeof parsed.tn_patient_url === "string" ? parsed.tn_patient_url : null;
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
  await recordAttachOutcome({ submissionId, status, reason, durationMs, tnPatientUrl, selectionMode });

  // DATA MISMATCH -> REVIEW, AFTER ONE REFUSAL. A refusal on a fact the chart
  // holds (see ATTACH_REFUSAL_REVIEW_REASON for the table) will be refused
  // again tomorrow from the same data, so the row leaves the batch now and goes
  // in front of a person. A transient refusal returns null here and the row
  // stays matched for the next run. Same code path for the button and the
  // batch: a staff member's press that the chart refuses lands in the same
  // place as the batch's.
  let sentToReview = false;
  const reviewReason = status === "failed" ? reviewReasonForAttachRefusal(reason) : null;
  if (reviewReason) {
    try {
      await markAttachRefusalForReview({ submissionId, reason: reviewReason });
      sentToReview = true;
      console.log(`[survey-attach] TO REVIEW id=${submissionId} reason=${reviewReason}`);
    } catch (e) {
      // Not fatal: the attempt is recorded, and the worst case is one more
      // nightly refusal — the behaviour before this existed.
      console.error(
        `[survey-attach] could not send id=${submissionId} to review:`,
        e instanceof Error ? e.message : "unknown",
      );
    }
  }

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
  return { submissionId, status, reason, durationMs, sentToReview };
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
  /** Refused on a data mismatch and moved to review — not retried. */
  toReview: number;
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
    considered: 0, eligible: 0, attempted: 0, attached: 0, failed: 0, deferred: 0, toReview: 0,
    byReason: {},
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
        if (r.sentToReview) summary.toReview += 1;
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
