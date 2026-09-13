/**
 * The nightly pull: call the agent, match each label, store the pass.
 * ============================================================================
 *
 * Calls GET /api/tn/active-client-counts on the Axiom agent, which logs into
 * TherapyNotes once and reads every clinician's active patient count off the
 * Patients page. The agent returns raw values and no opinions — matching,
 * storage and any decision about the dummy records are this side's job, which
 * is what its schema header says in so many words.
 *
 * STORE WHAT SUCCEEDED, RECORD WHAT FAILED. The agent's own `partial` status is
 * the expected outcome, not an error: one clinician whose count would not parse
 * must never discard the twenty-nine that read cleanly. Failures are stored as
 * failures so a gap is visible in the table rather than inferred from an
 * absence.
 *
 * NOTHING IS SUBTRACTED. Both Test Anna figures are stored exactly as reported.
 */

import { getAllCrmProviders } from "../reminders/db";
import { logActivity } from "../activity/db";
import { matchClinicianLabel, type MatchableProvider } from "./clinician-match";
import { storeActiveCounts, type ActiveCountRow } from "./active-counts-db";

const TN_AGENT_BASE_URL =
  process.env.TN_AGENT_BASE_URL ||
  (process.env.TN_AGENT_URL || "").replace(/\/api\/tn\/.*$/, "") ||
  "https://axiom-browser-agent-clone-production.up.railway.app";

const COUNTS_URL = `${TN_AGENT_BASE_URL}/api/tn/active-client-counts`;

/** The pass walks ~31 options with a browser; 3 minutes typical, 8 the ceiling. */
const COUNTS_TIMEOUT_MS = 480_000;

/** The agent's contract — verified against shared/schemas/active_count.py. */
interface AgentClinicianCount {
  option_value: string;
  label: string;
  is_aggregate?: boolean;
  status: "success" | "failure";
  active_count?: number | null;
  failure_reason?: string | null;
  count_text?: string | null;
  test_anna_exact?: number | null;
  test_anna_token_match?: number | null;
  test_anna_status?: string | null;
}

interface AgentCountsResponse {
  status: "success" | "partial" | "failure";
  captured_at: string;
  duration_ms?: number;
  total_options?: number;
  succeeded?: number;
  failed?: number;
  results?: AgentClinicianCount[];
  failed_phase?: string | null;
  failure_reason?: string | null;
  message?: string | null;
}

export interface ActiveCountRunSummary {
  ok: boolean;
  passStatus: string;
  capturedOn: string | null;
  optionsReturned: number;
  stored: number;
  matched: number;
  unmatched: string[];
  ambiguous: string[];
  failedReads: number;
  aggregateCount: number | null;
  message?: string;
}

function isDisabled(url: string): boolean {
  return !url || url.toLowerCase() === "disabled";
}

/**
 * Run one pass.
 *
 * ALWAYS returns a summary and ALWAYS writes an activity entry, including when
 * the pass returned nothing. A scheduled job that silently never fires is a
 * failure mode this project has already met once; the log line is how anyone
 * notices.
 */
export async function runActiveCountPass(
  trigger: "scheduled" | "manual",
): Promise<ActiveCountRunSummary> {
  const started = Date.now();
  const fail = async (message: string, passStatus = "error"): Promise<ActiveCountRunSummary> => {
    const summary: ActiveCountRunSummary = {
      ok: false, passStatus, capturedOn: null, optionsReturned: 0, stored: 0,
      matched: 0, unmatched: [], ambiguous: [], failedReads: 0,
      aggregateCount: null, message,
    };
    console.error(`[active-counts] ${trigger} pass FAILED: ${message}`);
    await logActivity({
      type: "tn_active_counts",
      actorEmail: "system",
      entityType: "report",
      entityName: "tn_active_counts",
      metadata: { trigger, outcome: "failed", passStatus, message, durationMs: Date.now() - started },
    }).catch(() => { /* logging must not mask the failure */ });
    return summary;
  };

  if (isDisabled(TN_AGENT_BASE_URL) || !process.env.TN_API_KEY) {
    return fail("TN_AGENT_BASE_URL or TN_API_KEY not configured", "skipped");
  }

  let body: AgentCountsResponse;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COUNTS_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(COUNTS_URL, {
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
      body = JSON.parse(raw) as AgentCountsResponse;
    } catch {
      return fail(`agent returned invalid JSON (HTTP ${res.status})`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : "agent call failed");
  }

  const results = body.results ?? [];
  if (results.length === 0) {
    return fail(
      `pass returned no options (status=${body.status}` +
      `${body.failed_phase ? `, phase=${body.failed_phase}` : ""}` +
      `${body.failure_reason ? `, reason=${body.failure_reason}` : ""})`,
      body.status,
    );
  }

  const capturedAt = body.captured_at || new Date().toISOString();
  const capturedOn = capturedAt.slice(0, 10);

  const providers: MatchableProvider[] = (await getAllCrmProviders())
    .map((p) => ({ id: p.id, name: p.name }));

  const rows: ActiveCountRow[] = [];
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  let matched = 0;
  let failedReads = 0;
  let aggregateCount: number | null = null;

  for (const r of results) {
    const isAggregate = r.is_aggregate === true;
    const m = matchClinicianLabel(r.label, isAggregate, providers);
    if (m.status === "matched") matched++;
    if (m.status === "unmatched") unmatched.push(r.label);
    if (m.status === "ambiguous") {
      ambiguous.push(`${r.label} → ${m.candidates.map((c) => c.name).join(" | ")}`);
    }
    if (r.status === "failure") failedReads++;
    if (isAggregate && r.status === "success") aggregateCount = r.active_count ?? null;

    rows.push({
      capturedAt,
      capturedOn,
      optionValue: r.option_value,
      label: r.label,
      isAggregate,
      providerId: m.providerId,
      matchStatus: m.status,
      activeCount: r.status === "success" ? (r.active_count ?? null) : null,
      status: r.status,
      failureReason: r.failure_reason ?? null,
      countText: r.count_text ?? null,
      testAnnaExact: r.test_anna_exact ?? null,
      testAnnaTokenMatch: r.test_anna_token_match ?? null,
      testAnnaStatus: r.test_anna_status ?? null,
    });
  }

  const stored = await storeActiveCounts(rows);

  const summary: ActiveCountRunSummary = {
    ok: true,
    passStatus: body.status,
    capturedOn,
    optionsReturned: results.length,
    stored,
    matched,
    unmatched,
    ambiguous,
    failedReads,
    aggregateCount,
  };

  // Labels are staff names, and every count is a number. No patient value is in
  // scope here — the agent's own contract keeps them inside the browser.
  console.log(
    `[active-counts] ${trigger} pass ${body.status}: ${results.length} options, ` +
    `${stored} stored, ${matched} matched to providers, ${unmatched.length} unmatched, ` +
    `${ambiguous.length} ambiguous, ${failedReads} unreadable, ` +
    `practice total=${aggregateCount ?? "n/a"}, ${Date.now() - started}ms`,
  );
  if (unmatched.length > 0) {
    console.warn(`[active-counts] no CRM provider for: ${unmatched.join("; ")}`);
  }
  if (ambiguous.length > 0) {
    console.warn(`[active-counts] AMBIGUOUS, stored without a provider: ${ambiguous.join("; ")}`);
  }

  await logActivity({
    type: "tn_active_counts",
    actorEmail: "system",
    entityType: "report",
    entityName: "tn_active_counts",
    metadata: {
      trigger, outcome: "ok", passStatus: body.status, capturedOn,
      optionsReturned: results.length, stored, matched,
      unmatched: unmatched.length, ambiguous: ambiguous.length,
      failedReads, durationMs: Date.now() - started,
    },
  }).catch(() => { /* best effort */ });

  return summary;
}
