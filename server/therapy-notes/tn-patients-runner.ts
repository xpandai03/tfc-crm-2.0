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

// THE FALLBACK IS LOAD-BEARING IN PRODUCTION, AND SAYS SO OUT LOUD.
//
// Neither TN_AGENT_BASE_URL nor TN_AGENT_URL is set on the Fly app, so the
// hardcoded Railway host on the line above is what every pull actually calls.
// It works, and removing it would take the nightly pull down until a secret
// existed — so it stays. What it should not do is stay SILENT: a deployment
// whose agent address lives in a source file, and nowhere in its own
// configuration, is a thing you want to find out about from a boot log rather
// than from a move that breaks it.
//
// Fires once, at import, which is boot: cron.ts imports this module statically
// and is itself imported by server/index.ts.
//
// The same fallback exists in three other places — active-counts-runner.ts,
// survey/attach-runner.ts and routes.ts — so setting the variable closes all
// four at once. Only this one warns, to keep a boot from printing the same
// sentence four times.
if (!process.env.TN_AGENT_BASE_URL && !process.env.TN_AGENT_URL) {
  console.warn(
    "[tn-patients] TN_AGENT_URL is not set — falling back to the agent host " +
    "hardcoded in server/therapy-notes/tn-patients-runner.ts. The pull will " +
    "work. To make the address configuration rather than source, set it: " +
    "fly secrets set TN_AGENT_URL=https://axiom-browser-agent-clone-production.up.railway.app -a tfc-crm-2-0",
  );
}

const PATIENTS_URL = `${TN_AGENT_BASE_URL}/api/tn/active-patients`;

/** Measured at 133s. Ten minutes is the ceiling, not the expectation. */
const PULL_TIMEOUT_MS = 600_000;

/**
 * RETRY A TRANSPORT FAILURE, NOT A VERDICT.
 *
 * On 23 September the agent completed its pass — 33 clinicians, 1,043 rows —
 * but the CRM received a 502 from Railway's edge at 98s instead of the body
 * (the edge logged the request as client-closed and replayed the GET upstream).
 * The runner treated that like any failure, kept yesterday's snapshot, and
 * nobody knew until a day later. Nothing about the pull was wrong; the hop
 * between the two services was.
 *
 * So a gateway status (502/503/504) or a connection that dropped before any
 * response is retried, twice. Nothing else is: a 4xx, unreadable JSON, a
 * partial pass or a truncated list is an answer, and asking again would only
 * get the same answer. A TIMEOUT is not retried either — at ten minutes the
 * agent may still be holding its single licence, and a second pass would queue
 * behind the first.
 *
 * The wait is longer than one pass (~133s), because the agent keeps running the
 * orphaned pass after the edge drops the connection, and a retry that arrives
 * sooner simply waits on the licence while holding a long request open — the
 * exposure being retried away from. Two retries at 150s end by about 03:12
 * Mountain, well before the 03:30 attach batch.
 */
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const PULL_RETRIES = 2;
const PULL_RETRY_DELAY_MS = 150_000;

/**
 * THE FLOOR. A complete pull that returns fewer than this share of the current
 * snapshot does not replace it. The practice's active caseload moves by a
 * handful a night (1,042 -> 1,043 -> 1,041 over 21-25 September); losing a
 * fifth overnight is a reading problem, not a discharge wave, and replacing the
 * table on it would silently send every survey for the missing patients to
 * review. A genuine large drop is let through by a person running the pull by
 * hand after checking, not by lowering this.
 */
export const MIN_KEEP_FRACTION = 0.8;

/** Would this pull shrink the snapshot below the floor? Pure, for the test. */
export function belowFloor(newRows: number, previousRows: number): boolean {
  if (previousRows <= 0) return false; // first pull ever: nothing to compare with
  return newRows < Math.ceil(previousRows * MIN_KEEP_FRACTION);
}

/** Is this a failure of the hop between the services, worth asking again? */
export function isTransientTransport(status: number | null): boolean {
  return status === null || RETRYABLE_STATUS.has(status);
}

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
  /** How many pages of this clinician's list were read. */
  pages_read?: number;
  /** The agent hit its page ceiling: there were rows it did not read. */
  truncated?: boolean;
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
  /** Pages of the patient list read across every clinician. */
  pagesRead: number;
  /** Patients in the snapshot before this pull — what the floor compares with. */
  previousRows: number;
  /** Requests made, including retries. 1 on a clean night. */
  attempts: number;
  distinctPatients: number;
  sharedCare: number;
  withPhone: number;
  stored: number;
  replaced: boolean;
  /** Name shapes in this pull. Counts only — see classifyNameShapes. */
  nameShapes: NameShapeCounts;
  message?: string;
}

/**
 * How many rows carry each NAME SHAPE, and how many use "Minor".
 *
 * WHY THIS IS COUNTED EVERY PULL RATHER THAN QUERIED ONCE. The rule that keys
 * these names was built for one shape and met another, and nobody knew how many
 * rows the second shape covered — the question had to be answered by hand from
 * a database nobody could reach quickly. It is the number that decides whether a
 * preferred name is an edge case or the main path for children, so the pull now
 * reports it as a standing fact instead of a thing somebody has to go and ask.
 *
 * COUNTS ONLY. No name is stored, logged or returned by this. "minor" is
 * counted as a literal token because the practice uses it as a flag, and a flag
 * word is not a person.
 */
export interface NameShapeCounts {
  /** No parenthetical at all. */
  plain: number;
  /** "Preferred (Legal) Last" — a group with at least one word after it. */
  preferredLegalLast: number;
  /** "Name (annotation)" — a group with nothing after it. */
  trailingAnnotation: number;
  /** Carries a parenthetical but fits neither shape above. */
  other: number;
  /** Of preferredLegalLast, how many whose leading token is "minor". */
  minorFlag: number;
}

/** Classify one pull's rows by shape. Pure, so it can be asserted directly. */
export function classifyNameShapes(rows: { name: string }[]): NameShapeCounts {
  const out: NameShapeCounts = {
    plain: 0, preferredLegalLast: 0, trailingAnnotation: 0, other: 0, minorFlag: 0,
  };
  for (const r of rows) {
    const name = String(r.name ?? "");
    if (!name.includes("(")) { out.plain += 1; continue; }
    // Decided the same way nameKeys decides a reading: a group with words AFTER
    // it stands in for the run before it; a group with nothing after it
    // annotates. A parenthesised name that is neither is "other", which is a
    // number worth seeing rather than a case worth guessing at.
    const preferred = /\S[^()]*\([^)]*\)[^()]*\S/.test(name);
    const trailing = /\([^)]*\)\s*$/.test(name);
    if (preferred) {
      out.preferredLegalLast += 1;
      if (/^\s*minor\b/i.test(name)) out.minorFlag += 1;
    } else if (trailing) {
      out.trailingAnnotation += 1;
    } else {
      out.other += 1;
    }
  }
  return out;
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
  // Injectable for the self-check only: a test cannot wait 150s, and must not
  // call the real agent. Production passes nothing.
  opts: { retryDelayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<TnPatientPullSummary> {
  const started = Date.now();
  const retryDelayMs = opts.retryDelayMs ?? PULL_RETRY_DELAY_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  let attempts = 0;
  let pagesRead = 0;
  let rowsSeen = 0;
  const fail = async (message: string, passStatus = "error"): Promise<TnPatientPullSummary> => {
    const before = await tnPatientStats().catch(() => ({ rows: 0, capturedOn: null }));
    const summary: TnPatientPullSummary = {
      ok: false, passStatus, capturedOn: before.capturedOn, optionsReturned: 0,
      failedOptions: 0, rowsReturned: rowsSeen, pagesRead, previousRows: before.rows, attempts,
      distinctPatients: 0, sharedCare: 0,
      withPhone: 0, stored: 0, replaced: false, message,
      // A failed pull classified nothing. Zeroes, not the previous pull's
      // counts: reporting yesterday's shape against today's failure would be a
      // number that looks measured and is not.
      nameShapes: { plain: 0, preferredLegalLast: 0, trailingAnnotation: 0, other: 0, minorFlag: 0 },
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
        keptRows: before.rows, rows: rowsSeen, pages: pagesRead, attempts,
        durationMs: Date.now() - started,
      },
    }).catch(() => { /* logging must not mask the failure */ });
    return summary;
  };

  if (isDisabled(TN_AGENT_BASE_URL) || !process.env.TN_API_KEY) {
    return fail("TN_AGENT_BASE_URL or TN_API_KEY not configured", "skipped");
  }

  let body: AgentPatientsResponse | null = null;
  while (body === null) {
    attempts += 1;
    // null = no HTTP response at all (the connection dropped).
    let status: number | null = null;
    let problem: string;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);
      let res: Response;
      try {
        res = await doFetch(PATIENTS_URL, {
          method: "GET",
          headers: { "X-API-Key": process.env.TN_API_KEY! },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const raw = await res.text();
      status = res.status;
      if (res.ok) {
        try {
          body = JSON.parse(raw) as AgentPatientsResponse;
          break;
        } catch {
          return fail(`agent returned invalid JSON (HTTP ${res.status})`);
        }
      }
      problem = `agent returned HTTP ${res.status}`;
    } catch (e) {
      // A timeout is final — see PULL_RETRIES. Anything else thrown here is a
      // connection that never produced a response.
      if (e instanceof Error && e.name === "AbortError") {
        return fail(`agent did not answer within ${PULL_TIMEOUT_MS / 1000}s`);
      }
      problem = e instanceof Error ? e.message : "agent call failed";
    }
    if (!isTransientTransport(status) || attempts > PULL_RETRIES) {
      return fail(attempts > 1 ? `${problem} (after ${attempts} attempts)` : problem);
    }
    console.warn(
      `[tn-patients] ${trigger} pull attempt ${attempts} failed in transit (${problem}) — ` +
      `retrying in ${Math.round(retryDelayMs / 1000)}s`,
    );
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  const pages = body.results ?? [];
  const failedOptions = pages.filter((p) => p.status !== "success").length;
  const listPages = pages.filter((p) => !p.is_aggregate);
  pagesRead = listPages.reduce((n, p) => n + (p.pages_read ?? 0), 0);
  rowsSeen = listPages.reduce((n, p) => n + (p.rows?.length ?? 0), 0);

  // THE GUARD. Anything short of a complete pull leaves the table alone.
  if (body.status !== "success" || failedOptions > 0 || pages.length === 0) {
    return fail(
      `pull was ${body.status} with ${failedOptions} unreadable clinician(s) — ` +
      `not replacing the snapshot`,
      body.status,
    );
  }

  // A TRUNCATED LIST IS AN INCOMPLETE PULL. The agent marks a clinician whose
  // pager ran past its ceiling; replacing from that would drop everyone on the
  // pages it never read, exactly as a failed clinician would.
  const truncated = listPages.filter((p) => p.truncated).length;
  if (truncated > 0) {
    return fail(
      `${truncated} clinician list(s) were truncated — incomplete pull, not replacing the snapshot`,
      body.status,
    );
  }

  const patients = collapseByChart(pages);
  if (patients.length === 0) {
    return fail(
      `pull returned no patient rows (${rowsSeen} rows over ${pagesRead} pages) — ` +
      `not replacing the snapshot`,
      body.status,
    );
  }

  // THE FLOOR — see MIN_KEEP_FRACTION.
  const previous = await tnPatientStats().catch(() => ({ rows: 0, capturedOn: null }));
  if (belowFloor(patients.length, previous.rows)) {
    return fail(
      `pull returned ${patients.length} patients against ${previous.rows} in the current ` +
      `snapshot, below the ${Math.round(MIN_KEEP_FRACTION * 100)}% floor — not replacing the snapshot`,
      body.status,
    );
  }

  const capturedAt = body.captured_at || new Date().toISOString();
  const rowsReturned = rowsSeen;
  const withPhone = patients.filter((p) => p.phone.trim() !== "").length;
  const sharedCare = patients.filter((p) => p.clinicians.length > 1).length;
  const nameShapes = classifyNameShapes(patients);

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
    pagesRead,
    previousRows: previous.rows,
    attempts,
    distinctPatients: patients.length,
    sharedCare,
    withPhone,
    stored,
    replaced: true,
    nameShapes,
  };

  console.log(
    `[tn-patients] ${trigger} pull ${body.status}: ${pages.length} options, ` +
    `${pagesRead} pages, ${rowsReturned} rows -> ${patients.length} patients stored ` +
    `(was ${previous.rows}), ${attempts} attempt(s), ` +
    `${sharedCare} shared-care, ${withPhone} with a phone ` +
    `(${((100 * withPhone) / patients.length).toFixed(1)}%), ${Date.now() - started}ms`,
  );
  // Counts only. This line is the answer to "is a preferred name an edge case
  // or the main path for children", and it is printed every pull so nobody has
  // to go and find out again.
  console.log(
    `[tn-patients] name shapes: ${nameShapes.plain} plain, ` +
    `${nameShapes.preferredLegalLast} preferred-legal-last ` +
    `(${nameShapes.minorFlag} flagged "Minor"), ` +
    `${nameShapes.trailingAnnotation} trailing-annotation, ${nameShapes.other} other`,
  );

  await logActivity({
    type: "tn_patient_pull", actorEmail: "system", entityType: "report",
    entityName: "tn_patient_pull",
    metadata: {
      trigger, outcome: "ok", passStatus: body.status,
      capturedOn: summary.capturedOn, options: pages.length,
      rows: rowsReturned, pages: pagesRead, patients: patients.length,
      previousRows: previous.rows, attempts, sharedCare, withPhone,
      durationMs: Date.now() - started,
    },
  }).catch(() => { /* best effort */ });

  return summary;
}
