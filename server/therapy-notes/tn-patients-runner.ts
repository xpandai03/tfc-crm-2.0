/**
 * The nightly pull: call the agent, store one complete snapshot.
 *
 * Calls GET /api/tn/active-patients, which logs into TherapyNotes once, walks
 * every clinician's Active list and returns identity rows verbatim. Measured
 * twice on 2026-09-15: 1,011 rows across 33 options in 133 seconds, 99.3%
 * carrying a phone, 100% a date of birth, and zero patients under more than one
 * clinician.
 *
 * A PARTIAL PULL DOES NOT TOUCH THE TABLE. The agent returns "partial" when some
 * clinicians read and others did not, and that is a legitimate outcome for it —
 * but not for storage. Replacing the table from a partial pull silently deletes
 * the patients belonging to whichever clinicians failed, and the symptom is a
 * survey that matched yesterday landing in review today, which reads as a
 * matcher bug. So only a complete pull replaces; anything else is recorded and
 * yesterday's snapshot stands.
 *
 * SHARED CARE IS COLLAPSED HERE, NOT IN THE AGENT. The route returns one row per
 * clinician per patient, deliberately — it does not decide. This folds them onto
 * one row per chart id with a clinician list, which is the shape the matcher
 * wants.
 *
 * PHI: no patient value is logged. Every line below carries counts and clinician
 * labels, which are staff names.
 */

import { logActivity } from "../activity/db";
import { replaceTnPatients, tnPatientStats, type TnPatientRow } from "./tn-patients-db";

const TN_AGENT_BASE_URL =
  process.env.TN_AGENT_BASE_URL ||
  (process.env.TN_AGENT_URL || "").replace(/\/api\/tn\/.*$/, "") ||
  "https://axiom-browser-agent-clone-production.up.railway.app";

const PATIENTS_URL = `${TN_AGENT_BASE_URL}/api/tn/active-patients`;

/** Measured at 133s. Ten minutes is the ceiling, not the expectation. */
const PULL_TIMEOUT_MS = 600_000;

/** The agent's contract — verified against the live route on 2026-09-15. */
interface AgentPatientRow {
  chart_id: string;
  name: string;
  dob: string;
  phone: string;
  clinician_option_value: string;
  clinician_label: string;
}
interface AgentClinicianPage {
  option_value: string;
  label: string;
  is_aggregate?: boolean;
  status: "success" | "failure";
  failure_reason?: string | null;
  row_count?: number;
  rows?: AgentPatientRow[];
}
interface AgentPatientsResponse {
  status: "success" | "partial" | "failure";
  captured_at: string;
  duration_ms?: number;
  total_options?: number;
  succeeded?: number;
  failed?: number;
  total_rows?: number;
  distinct_chart_ids?: number;
  columns_found?: Record<string, boolean>;
  results?: AgentClinicianPage[];
  failure_reason?: string | null;
  message?: string | null;
}

export interface TnPatientPullSummary {
  ok: boolean;
  passStatus: string;
  capturedOn: string | null;
  optionsReturned: number;
  failedOptions: number;
  rowsReturned: number;
  distinctPatients: number;
  sharedCare: number;
  withPhone: number;
  stored: number;
  replaced: boolean;
  message?: string;
}

function isDisabled(url: string): boolean {
  return !url || url.toLowerCase() === "disabled";
}

/**
 * Fold the route's per-clinician rows into one row per patient.
 *
 * Exported for the fixture test: this is where shared care becomes a list, and
 * where a patient appearing twice stops being two candidates.
 */
export function collapseByChart(pages: AgentClinicianPage[]): TnPatientRow[] {
  const byChart = new Map<string, TnPatientRow>();
  for (const page of pages) {
    if (page.is_aggregate) continue; // repeats everyone; never a source of rows
    if (page.status !== "success") continue;
    for (const r of page.rows ?? []) {
      const id = (r.chart_id ?? "").trim();
      if (!id) continue;
      const existing = byChart.get(id);
      if (existing) {
        // Same patient under another clinician. The identity fields are the
        // same page's rendering of the same record, so the first wins and only
        // the clinician list grows.
        if (r.clinician_label && !existing.clinicians.includes(r.clinician_label)) {
          existing.clinicians.push(r.clinician_label);
        }
        continue;
      }
      byChart.set(id, {
        chartId: id,
        name: r.name ?? "",
        dob: r.dob ?? "",
        phone: r.phone ?? "",
        clinicians: r.clinician_label ? [r.clinician_label] : [],
      });
    }
  }
  return Array.from(byChart.values());
}

export async function runTnPatientPull(
  trigger: "scheduled" | "manual",
): Promise<TnPatientPullSummary> {
  const started = Date.now();
  const fail = async (message: string, passStatus = "error"): Promise<TnPatientPullSummary> => {
    const before = await tnPatientStats().catch(() => ({ rows: 0, capturedOn: null }));
    const summary: TnPatientPullSummary = {
      ok: false, passStatus, capturedOn: before.capturedOn, optionsReturned: 0,
      failedOptions: 0, rowsReturned: 0, distinctPatients: 0, sharedCare: 0,
      withPhone: 0, stored: 0, replaced: false, message,
    };
    console.error(
      `[tn-patients] ${trigger} pull FAILED: ${message} — ` +
      `keeping the previous snapshot (${before.rows} patients from ${before.capturedOn ?? "never"})`,
    );
    await logActivity({
      type: "tn_patient_pull", actorEmail: "system", entityType: "report",
      entityName: "tn_patient_pull",
      metadata: {
        trigger, outcome: "failed", passStatus, message,
        keptRows: before.rows, durationMs: Date.now() - started,
      },
    }).catch(() => { /* logging must not mask the failure */ });
    return summary;
  };

  if (isDisabled(TN_AGENT_BASE_URL) || !process.env.TN_API_KEY) {
    return fail("TN_AGENT_BASE_URL or TN_API_KEY not configured", "skipped");
  }

  let body: AgentPatientsResponse;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(PATIENTS_URL, {
        method: "GET",
        headers: { "X-API-Key": process.env.TN_API_KEY! },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const raw = await res.text();
    if (!res.ok) return fail(`agent returned HTTP ${res.status}`);
    try {
      body = JSON.parse(raw) as AgentPatientsResponse;
    } catch {
      return fail(`agent returned invalid JSON (HTTP ${res.status})`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : "agent call failed");
  }

  const pages = body.results ?? [];
  const failedOptions = pages.filter((p) => p.status !== "success").length;

  // THE GUARD. Anything short of a complete pull leaves the table alone.
  if (body.status !== "success" || failedOptions > 0 || pages.length === 0) {
    return fail(
      `pull was ${body.status} with ${failedOptions} unreadable clinician(s) — ` +
      `not replacing the snapshot`,
      body.status,
    );
  }

  const patients = collapseByChart(pages);
  if (patients.length === 0) {
    return fail("pull returned no patient rows — not replacing the snapshot", body.status);
  }

  const capturedAt = body.captured_at || new Date().toISOString();
  const rowsReturned = pages
    .filter((p) => !p.is_aggregate)
    .reduce((n, p) => n + (p.rows?.length ?? 0), 0);
  const withPhone = patients.filter((p) => p.phone.trim() !== "").length;
  const sharedCare = patients.filter((p) => p.clinicians.length > 1).length;

  let stored = 0;
  try {
    stored = await replaceTnPatients(patients, capturedAt);
  } catch (e) {
    return fail(
      `storing the snapshot failed, previous one intact: ${e instanceof Error ? e.message : "unknown"}`,
      body.status,
    );
  }

  const summary: TnPatientPullSummary = {
    ok: true,
    passStatus: body.status,
    capturedOn: capturedAt.slice(0, 10),
    optionsReturned: pages.length,
    failedOptions: 0,
    rowsReturned,
    distinctPatients: patients.length,
    sharedCare,
    withPhone,
    stored,
    replaced: true,
  };

  console.log(
    `[tn-patients] ${trigger} pull ${body.status}: ${pages.length} options, ` +
    `${rowsReturned} rows -> ${patients.length} patients stored, ` +
    `${sharedCare} shared-care, ${withPhone} with a phone ` +
    `(${((100 * withPhone) / patients.length).toFixed(1)}%), ${Date.now() - started}ms`,
  );

  await logActivity({
    type: "tn_patient_pull", actorEmail: "system", entityType: "report",
    entityName: "tn_patient_pull",
    metadata: {
      trigger, outcome: "ok", passStatus: body.status,
      capturedOn: summary.capturedOn, options: pages.length,
      rows: rowsReturned, patients: patients.length, sharedCare, withPhone,
      durationMs: Date.now() - started,
    },
  }).catch(() => { /* best effort */ });

  return summary;
}
