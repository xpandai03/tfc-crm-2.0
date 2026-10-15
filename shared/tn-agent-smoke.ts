/**
 * The TherapyNotes agent's daily selector smoke, as the Submissions health line
 * shows it.
 *
 * The agent logs in once a day at 03:00 Mountain and checks six things every
 * flow depends on (dashboard, Patients page, search box, a chart tab, the New
 * Patient form, the scheduling dialog). Its last result is served at
 * GET /api/tn/selector-smoke/last. A TherapyNotes UI change or an expiring
 * password then reads as one plain sentence instead of a day of unrelated
 * refusals (13-14 October 2026).
 *
 * Pure: no I/O. Signal names and counts only — the agent's result carries no
 * patient value.
 */

export interface AgentSmoke {
  status: "pass" | "fail";
  checkedAt: string;
  firstFailed: string | null;
  failureReason: string | null;
  passwordExpiresInDays: number | null;
}

/** Older than this, a smoke result is not shown: it describes a stale day. */
export const SMOKE_STALE_MS = 36 * 60 * 60 * 1000;

const SIGNAL_LABEL: Record<string, string> = {
  dashboard: "dashboard",
  patients_page: "Patients page",
  search_box: "Patients search box",
  chart_tab: "chart tab",
  new_patient_form: "New Patient form",
  scheduling_dialog: "scheduling dialog",
};

/** The agent's JSON, validated. Anything unexpected is null: show nothing. */
export function agentSmokeFromBody(body: unknown): AgentSmoke | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.status !== "pass" && b.status !== "fail") return null;
  if (typeof b.checked_at !== "string" || Number.isNaN(Date.parse(b.checked_at))) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const days = b.password_expires_in_days;
  return {
    status: b.status,
    checkedAt: b.checked_at,
    firstFailed: str(b.first_failed),
    failureReason: str(b.failure_reason),
    passwordExpiresInDays: typeof days === "number" && Number.isInteger(days) && days >= 0 ? days : null,
  };
}

/**
 * The health line's two optional sentences.
 *  - tnLayout: "TN layout changed: <signal>" when the smoke failed at a signal,
 *    or the expired-password sentence when that was the cause.
 *  - tnPassword: "TN password expires in N days" when TherapyNotes said so.
 * Both null when there is no recent result, or it passed with no warning.
 */
export function smokeHealthText(
  smoke: AgentSmoke | null,
  now: number = Date.now(),
): { tnLayout: string | null; tnPassword: string | null } {
  if (!smoke || now - Date.parse(smoke.checkedAt) > SMOKE_STALE_MS) {
    return { tnLayout: null, tnPassword: null };
  }
  let tnLayout: string | null = null;
  if (smoke.status === "fail") {
    if (smoke.failureReason === "password_expired") {
      tnLayout = "TherapyNotes password expired — set a new one; every TherapyNotes step is stopped";
    } else if (smoke.firstFailed) {
      tnLayout = `TN layout changed: ${SIGNAL_LABEL[smoke.firstFailed] ?? smoke.firstFailed}`;
    } else {
      tnLayout = "TN layout check could not run";
    }
  }
  const n = smoke.passwordExpiresInDays;
  const tnPassword = n === null ? null : `TN password expires in ${n} day${n === 1 ? "" : "s"}`;
  return { tnLayout, tnPassword };
}
