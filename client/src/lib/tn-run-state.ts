/**
 * TN V2 run state, derived from a contact's activity log.
 * ============================================================================
 *
 * Extracted from pages/contact-detail.tsx unchanged in behaviour. It moved here
 * because it stopped being a two-line helper: it now decides whether a staff
 * member is told to create a patient or told not to, and a decision of that
 * weight should be directly testable rather than reachable only by rendering a
 * 3,000-line page. Same shape as the repo's other pure client libs
 * (status-config, insurance-utils), and tested the same way.
 *
 * PURE. Activities in, verdict out. No fetching, no React, no globals beyond
 * Date.now() for the staleness TTL.
 */

export const TN_STALE_MS = 10 * 60 * 1000;

// Parse an activity `createdAt` to epoch ms. The API serves Postgres
// `created_at::text`, e.g. "2026-07-01 20:21:15.549361+00" — a space separator
// and a BARE 2-digit offset ("+00") that Date.parse() rejects (→ NaN). Normalize
// to ISO ("T" separator, "+00"→"+00:00"); fall back to treating it as UTC. Using
// raw Date.parse here silently returned NaN, which disabled the staleness TTL and
// left runs stuck in-flight forever.
export function parseActivityTs(s: string | undefined | null): number {
  if (!s) return NaN;
  const iso = String(s).trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.parse(iso.replace(/[+-]\d{2}(:?\d{2})?$/, "") + "Z");
}

// ---------------------------------------------------------------------------
// Partial success on a failed run
// ---------------------------------------------------------------------------
//
// THE PROBLEM THIS SOLVES. On 8 September two runs created the patient in
// TherapyNotes — chart URL and all — and then failed at the next step. The
// contact showed "failed" and nothing else, so the only reasonable reading was
// that nothing had happened. A scheduler acting on that creates the patient by
// hand, which is the duplicate the agent's own save-time guard exists to stop.
//
// NOTHING NEW IS ASKED OF THE AGENT, AND NOTHING NEW IS STORED. Every phase the
// agent reports is already written to activity_log as a tn_schedule_phase entry
// (server/routes.ts, POST /api/internal/tn-progress), the save phase's entry
// already carries tnPatientUrl and tnPatientId, and this component already
// fetches the whole list. computeTnRun simply stopped reading it the moment it
// found a terminal failure. This reads it.
//
// Because the source is activity_log, the state is durable by construction and
// survives a reload — there was nothing to persist.

/** The phases that represent work a person would otherwise have to redo. */
export const TN_PHASE_LABELS: Record<string, string> = {
  save: "the patient record",
  upload_intake_pdf: "the intake PDF",
  upload_snapshot_pdf: "the appointment confirmation PDF",
  schedule_appointment: "the appointment",
};

/** Work the agent is expected to do after the patient exists, in order. */
export const TN_POST_SAVE_PHASES = ["upload_intake_pdf", "upload_snapshot_pdf", "schedule_appointment"] as const;

/** "a", "a and b", "a, b and c" — written the way a person would say it. */
export function joinNaturally(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Derive the current TN V2 run state from a contact's activity log (newest-first).
// A run is "in flight" if its tn_schedule_started entry (which carries a runId)
// has no matching terminal entry (tn_schedule_completed/failed) for the same
// runId AND is younger than TN_STALE_MS. A terminal failure — or an aged-out run
// with no terminal — clears the loading state and surfaces a reason.
export type TnActivity = { type: string; metadata: Record<string, unknown>; summary: string; createdAt: string };
export function computeTnRun(activities: TnActivity[] | undefined): {
  inFlight: boolean;
  runId?: string;
  latestPhaseMessage?: string;
  latestPhaseStatus?: string;
  failedReason?: string; // set when the newest run failed or went stale (for the indicator)
  stale?: boolean;       // aged out with no terminal callback
  // --- What the run got done before it stopped. Only computed on a failed or
  // stale run; a successful run is displayed exactly as it was before.
  /** The agent reported the save phase succeeded — a patient record exists. */
  patientCreated?: boolean;
  /** The chart URL the save phase reported, when it reported one. */
  patientUrl?: string;
  /** The agent reported the appointment was booked. */
  appointmentScheduled?: boolean;
  /** Human labels for the post-save work that did NOT report success. */
  outstanding?: string[];
} {
  if (!activities || activities.length === 0) return { inFlight: false };
  const started = activities.find((a) => a.type === "tn_schedule_started");
  const runId = started?.metadata?.runId as string | undefined;
  if (!started || !runId) return { inFlight: false }; // only async (runId-tagged) runs count
  const terminal = activities.find(
    (a) => (a.type === "tn_schedule_completed" || a.type === "tn_schedule_failed") && a.metadata?.runId === runId
  );
  // What the run actually got done, read off the phase breadcrumbs. Computed
  // once and attached to every non-success outcome below.
  //
  // NOTE ON TWO TERMINALS PER FAILED RUN: the agent reports the failing phase
  // AND a workflow_complete/failed, and the callback writes a terminal for each.
  // The terminal therefore says phase "workflow_complete", which tells a person
  // nothing. The breadcrumbs are where the real story is.
  const runPhases = activities.filter(
    (a) => a.type === "tn_schedule_phase" && a.metadata?.runId === runId,
  );
  const okPhases = new Set(
    runPhases.filter((a) => a.metadata?.status === "ok").map((a) => a.metadata?.phase as string),
  );
  const patientCreated = okPhases.has("save");
  // The save phase is where the chart URL comes from; workflow_complete repeats
  // it on a successful run. Take whichever is present.
  const patientUrl = runPhases
    .map((a) => a.metadata?.tnPatientUrl)
    .find((u): u is string => typeof u === "string" && u.trim() !== "");
  const appointmentScheduled = okPhases.has("schedule_appointment");
  const outstanding = TN_POST_SAVE_PHASES.filter((ph) => !okPhases.has(ph)).map(
    (ph) => TN_PHASE_LABELS[ph],
  );
  const progress = { patientCreated, patientUrl, appointmentScheduled, outstanding };

  if (terminal) {
    // Success clears silently; an explicit terminal failure surfaces its reason.
    if (terminal.type === "tn_schedule_failed") {
      const reason = (terminal.metadata?.failureReason as string) || terminal.summary || "unknown error";
      return { inFlight: false, runId, failedReason: reason, ...progress };
    }
    // Unchanged: a successful run returns exactly what it always returned.
    return { inFlight: false, runId };
  }
  // No terminal yet — apply the staleness TTL so a missing callback can't hang forever.
  const startedAtMs = parseActivityTs(started.createdAt);
  const isStale = Number.isFinite(startedAtMs) && Date.now() - startedAtMs > TN_STALE_MS;
  const latestPhase = activities.find((a) => a.type === "tn_schedule_phase" && a.metadata?.runId === runId);
  const latestPhaseMessage = (latestPhase?.metadata?.message as string) || latestPhase?.summary;
  const latestPhaseStatus = latestPhase?.metadata?.status as string | undefined;
  if (isStale) {
    // A run that died mid-flight can have created the patient just as surely as
    // one that reported a failure — the agent going away after save is exactly
    // how that happens — so the same partial state is attached here.
    return {
      inFlight: false,
      runId,
      stale: true,
      failedReason: latestPhaseMessage
        ? `No completion received — last step: ${latestPhaseMessage}`
        : "No response from TN (the run may have failed or timed out)",
      ...progress,
    };
  }
  return {
    inFlight: true,
    runId,
    latestPhaseMessage,
    latestPhaseStatus,
  };
}
