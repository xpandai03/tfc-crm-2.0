/**
 * Self-checks — the Submissions health line shows the TherapyNotes agent's
 * daily selector smoke.
 *
 * Run: npx tsx scripts/test-tn-agent-smoke.ts
 *
 * No database, no network: the agent call is driven through an injected fetch.
 * Every value is invented.
 */
import { readFileSync } from "fs";
import { agentSmokeFromBody, smokeHealthText, SMOKE_STALE_MS } from "../shared/tn-agent-smoke";

process.env.TN_API_KEY = "ZZTEST-key";
delete process.env.DATABASE_URL;

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
const read = (p: string) => readFileSync(p, "utf8");

const NOW = Date.parse("2026-10-15T15:00:00Z");
const body = (over: Record<string, unknown> = {}) => ({
  status: "pass", checked_at: "2026-10-15T09:01:00Z", first_failed: null, failure_reason: null,
  password_expires_in_days: null, message: "TN layout ok (6/6)",
  signals: { dashboard: true }, duration_ms: 1, ...over,
});

async function main() {
  console.log("\n[1] the agent's body, validated");
  eq("a pass parses", agentSmokeFromBody(body()), {
    status: "pass", checkedAt: "2026-10-15T09:01:00Z", firstFailed: null, failureReason: null, passwordExpiresInDays: null });
  eq("a fail keeps its first failed signal",
    agentSmokeFromBody(body({ status: "fail", first_failed: "chart_tab" }))?.firstFailed, "chart_tab");
  eq("days kept when a whole number", agentSmokeFromBody(body({ password_expires_in_days: 4 }))?.passwordExpiresInDays, 4);
  eq("days dropped when not", agentSmokeFromBody(body({ password_expires_in_days: "4" }))?.passwordExpiresInDays, null);
  eq("unknown status -> null", agentSmokeFromBody(body({ status: "maybe" })), null);
  eq("no checked_at -> null", agentSmokeFromBody(body({ checked_at: undefined })), null);
  eq("not an object -> null", agentSmokeFromBody("TN layout ok"), null);

  console.log("\n[2] the sentences");
  const t = (over: Record<string, unknown>) => smokeHealthText(agentSmokeFromBody(body(over)), NOW);
  eq("pass, no warning -> nothing", t({}), { tnLayout: null, tnPassword: null });
  eq("chart tab", t({ status: "fail", first_failed: "chart_tab" }).tnLayout, "TN layout changed: chart tab");
  eq("Patients page", t({ status: "fail", first_failed: "patients_page" }).tnLayout, "TN layout changed: Patients page");
  eq("scheduling dialog", t({ status: "fail", first_failed: "scheduling_dialog" }).tnLayout, "TN layout changed: scheduling dialog");
  eq("an unknown signal is named as sent", t({ status: "fail", first_failed: "new_thing" }).tnLayout, "TN layout changed: new_thing");
  check("expired password says password, not layout",
    /password expired/.test(t({ status: "fail", first_failed: "dashboard", failure_reason: "password_expired" }).tnLayout ?? ""));
  eq("expires in 4 days", t({ password_expires_in_days: 4 }).tnPassword, "TN password expires in 4 days");
  eq("expires in 1 day (singular)", t({ password_expires_in_days: 1 }).tnPassword, "TN password expires in 1 day");
  eq("expires in 0 days", t({ password_expires_in_days: 0 }).tnPassword, "TN password expires in 0 days");
  eq("both at once", t({ status: "fail", first_failed: "search_box", password_expires_in_days: 2 }),
    { tnLayout: "TN layout changed: Patients search box", tnPassword: "TN password expires in 2 days" });
  const old = new Date(NOW - SMOKE_STALE_MS - 60_000).toISOString();
  eq("a result older than 36h shows nothing",
    t({ status: "fail", first_failed: "chart_tab", checked_at: old }), { tnLayout: null, tnPassword: null });
  eq("no result shows nothing", smokeHealthText(null, NOW), { tnLayout: null, tnPassword: null });

  console.log("\n[3] the agent call (injected fetch)");
  const { fetchAgentSmoke } = await import("../server/therapy-notes/agent-smoke");
  let seen: { url: string; key: string | null; method?: string } | null = null;
  const ok = (async (url: string, init: RequestInit) => {
    seen = { url, key: new Headers(init.headers).get("X-API-Key"), method: init.method };
    return new Response(JSON.stringify(body({ status: "fail", first_failed: "chart_tab" })), { status: 200 });
  }) as unknown as typeof fetch;
  const got = await fetchAgentSmoke({ fetchImpl: ok, now: NOW });
  eq("parsed", got?.firstFailed, "chart_tab");
  check("calls /api/tn/selector-smoke/last", !!seen && /\/api\/tn\/selector-smoke\/last$/.test((seen as any).url), (seen as any)?.url);
  eq("with the agent key", (seen as any)?.key, "ZZTEST-key");
  eq("a GET", (seen as any)?.method, "GET");
  const notFound = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  eq("404 (no smoke since deploy) -> null", await fetchAgentSmoke({ fetchImpl: notFound, now: NOW }), null);
  const boom = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
  eq("agent unreachable -> null, no throw", await fetchAgentSmoke({ fetchImpl: boom, now: NOW }), null);

  console.log("\n[4] wired");
  const snap = read("server/survey/snapshot.ts");
  check("the snapshot reads it next to the pull health",
    /fetchAgentSmoke\(\)\.catch\(\(\) => null\)/.test(snap) && /smokeHealthText\(smoke\)/.test(snap));
  check("the pull health read is unchanged", /tnPullHealth\(\)\.catch\(\(\) => null\)/.test(snap));
  const ui = read("client/src/components/survey-snapshot.tsx");
  check("the line renders both sentences", /pull\.tnLayout \?/.test(ui) && /pull\.tnPassword \?/.test(ui));
  check("and turns amber for them", /agentWarning/.test(ui));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
