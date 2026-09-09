/**
 * Self-checks — partial success on a failed TN run.
 *
 * Run: npx tsx scripts/test-tn-partial-success.ts
 *
 * The fixtures below are the REAL callback sequences, transcribed from
 * activity_log by shape: which phases the agent reported, in which order, with
 * which metadata keys. No patient data appears — every field carrying a name,
 * a date or a URL is replaced with a synthetic value.
 */
import {
  computeTnRun, joinNaturally, TN_POST_SAVE_PHASES, type TnActivity,
} from "../client/src/lib/tn-run-state";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const CHART = "https://www.therapynotes.com/app/patients/00000/";
const RUN = "run-0001";
let clock = Date.parse("2026-09-08T18:00:00Z");
/** Activities are served newest-first; each helper prepends. */
const feed: TnActivity[] = [];
function at(type: string, metadata: Record<string, unknown>, summary = "") {
  clock += 1000;
  feed.unshift({ type, metadata, summary, createdAt: new Date(clock).toISOString() });
}
function reset(startedAgoMs = 60_000) {
  feed.length = 0;
  clock = Date.now() - startedAgoMs;
  at("tn_schedule_started", { contactId: 1, runId: RUN, appointmentDatetime: "9/15/2026 2:00 pm" });
}
const phase = (p: string, status: string, meta: Record<string, unknown> = {}) =>
  at("tn_schedule_phase", { contactId: 1, runId: RUN, phase: p, status, message: `${p} ${status}`, ...meta });
/** The callback writes a terminal for the failing phase AND for workflow_complete. */
const terminalFail = (p: string, reason: string) =>
  at("tn_schedule_failed", { contactId: 1, runId: RUN, phase: p, failureReason: reason });

/** Phases up to and including a successful save. */
function throughSave(withUrl = true) {
  for (const p of ["entry", "login", "navigate", "fill_form"]) { phase(p, "started"); phase(p, "ok"); }
  phase("save", "started");
  phase("save", "ok", withUrl ? { tnPatientUrl: CHART, tnPatientId: "00000" } : {});
}

// ===========================================================================
console.log("\n[1] A run failing after patient creation shows the partial state and a chart link");
// This is run 418b7899 / 2a358d92 from 8 September, by shape: save ok with a
// chart URL, then upload_intake_pdf failed.
reset();
throughSave();
phase("upload_intake_pdf", "started");
phase("upload_intake_pdf", "failed", { failureReason: "Upload timed out" });
terminalFail("upload_intake_pdf", "Upload timed out");
phase("workflow_complete", "failed", { failedPhase: "upload_intake_pdf", failureReason: "Upload timed out" });
terminalFail("workflow_complete", "Upload timed out");
{
  const r = computeTnRun(feed);
  ok("not in flight", r.inFlight === false);
  ok("the patient is reported created", r.patientCreated === true);
  eq("the chart URL is recovered from the save phase", r.patientUrl, CHART);
  ok("the appointment is NOT reported scheduled", r.appointmentScheduled === false);
  eq("everything after save is outstanding", r.outstanding,
    ["the intake PDF", "the appointment confirmation PDF", "the appointment"]);
  ok("the failure reason is still carried", !!r.failedReason);
  eq("the sentence a scheduler reads",
    `Still to do in TherapyNotes: ${joinNaturally(r.outstanding ?? [])}.`,
    "Still to do in TherapyNotes: the intake PDF, the appointment confirmation PDF and the appointment.");
}

console.log("\n[1b] Failing at scheduling only — the case the brief describes");
reset();
throughSave();
for (const p of ["upload_intake_pdf", "upload_snapshot_pdf"]) { phase(p, "started"); phase(p, "ok", { documentName: "doc" }); }
phase("schedule_appointment", "started");
phase("schedule_appointment", "failed", { failureReason: "No clinician match in dropdown" });
terminalFail("schedule_appointment", "No clinician match in dropdown");
terminalFail("workflow_complete", "No clinician match in dropdown");
{
  const r = computeTnRun(feed);
  ok("patient created", r.patientCreated === true);
  ok("appointment not scheduled", r.appointmentScheduled === false);
  eq("only the appointment is outstanding", r.outstanding, ["the appointment"]);
  eq("the sentence reads naturally with one item",
    `Still to do in TherapyNotes: ${joinNaturally(r.outstanding ?? [])}.`,
    "Still to do in TherapyNotes: the appointment.");
}

console.log("\n[2] A run failing before creation is a plain failure, unchanged");
for (const [label, failAt] of [["login", "login"], ["entry", "entry"], ["fill_form", "fill_form"], ["save", "save"]] as const) {
  reset();
  const before = ["entry", "login", "navigate", "fill_form", "save"];
  for (const p of before) {
    phase(p, "started");
    if (p === failAt) break;
    phase(p, "ok");
  }
  phase(failAt, "failed", { failureReason: `${failAt} failed` });
  terminalFail(failAt, `${failAt} failed`);
  terminalFail("workflow_complete", `${failAt} failed`);
  const r = computeTnRun(feed);
  ok(`  failing at ${label}: no patient reported`, r.patientCreated === false);
  ok(`  failing at ${label}: no chart URL`, r.patientUrl === undefined);
  ok(`  failing at ${label}: the reason is unchanged`, r.failedReason === `${failAt} failed`);
}
// A save that is REFUSED (the duplicate guard, or a validation refusal) reports
// save/failed, never save/ok — so it must not read as a created patient.
reset();
for (const p of ["entry", "login", "navigate", "fill_form"]) { phase(p, "started"); phase(p, "ok"); }
phase("save", "started");
phase("save", "failed", { failureReason: "Duplicate patient warning" });
terminalFail("save", "Duplicate patient warning");
ok("a refused save does not read as a created patient", computeTnRun(feed).patientCreated === false);

console.log("\n[3] The state survives a page reload");
// It is derived from activity_log, which is the store — there is nothing held
// in component state. Re-deriving from the same rows must give the same answer.
reset();
throughSave();
phase("upload_intake_pdf", "failed", { failureReason: "Upload timed out" });
terminalFail("workflow_complete", "Upload timed out");
{
  const a = computeTnRun(feed);
  const reloaded = computeTnRun(JSON.parse(JSON.stringify(feed)) as TnActivity[]);
  eq("a fresh derivation from the same rows is identical", a, reloaded);
  ok("nothing is memoised across calls", computeTnRun(feed).patientCreated === true);
}

console.log("\n[4] A successful run's verdict is unchanged");
reset();
throughSave();
for (const p of ["upload_intake_pdf", "upload_snapshot_pdf", "schedule_appointment"]) { phase(p, "started"); phase(p, "ok"); }
phase("workflow_complete", "ok", { tnPatientUrl: CHART, durationMs: 101000 });
at("tn_schedule_completed", { contactId: 1, runId: RUN, tnPatientUrl: CHART });
{
  const r = computeTnRun(feed);
  eq("a successful run returns exactly what it always returned", r, { inFlight: false, runId: RUN });
  ok("  no failure reason", r.failedReason === undefined);
  ok("  no partial-state fields at all", r.patientCreated === undefined && r.patientUrl === undefined
    && r.appointmentScheduled === undefined && r.outstanding === undefined);
}

console.log("\n[5] Creation reported without a chart URL degrades gracefully");
reset();
throughSave(false); // save/ok, no tnPatientUrl in the metadata
phase("schedule_appointment", "failed", { failureReason: "No clinician match" });
terminalFail("workflow_complete", "No clinician match");
{
  const r = computeTnRun(feed);
  ok("still reports the patient as created", r.patientCreated === true);
  ok("no chart URL is invented", r.patientUrl === undefined);
  ok("outstanding work is still listed", (r.outstanding?.length ?? 0) > 0);
}
// An empty-string URL must not be treated as a link either.
reset();
for (const p of ["entry", "login", "navigate", "fill_form"]) { phase(p, "started"); phase(p, "ok"); }
phase("save", "started"); phase("save", "ok", { tnPatientUrl: "   " });
terminalFail("workflow_complete", "later failure");
ok("a blank chart URL is not offered as a link", computeTnRun(feed).patientUrl === undefined);

console.log("\n[6] Several failed runs on one contact — the latest wins");
// Two runs: an older one that got as far as save, and a newer one that failed
// at login. The newest tn_schedule_started is the run in view.
feed.length = 0;
clock = Date.now() - 600_000;
const OLD = "run-old", NEW = "run-new";
const atRun = (run: string, type: string, meta: Record<string, unknown>) =>
  at(type, { contactId: 1, runId: run, ...meta });
atRun(OLD, "tn_schedule_started", {});
atRun(OLD, "tn_schedule_phase", { phase: "save", status: "ok", tnPatientUrl: CHART, message: "save ok" });
atRun(OLD, "tn_schedule_failed", { phase: "workflow_complete", failureReason: "old run failed after save" });
clock = Date.now() - 60_000;
atRun(NEW, "tn_schedule_started", {});
atRun(NEW, "tn_schedule_phase", { phase: "login", status: "failed", message: "login failed" });
atRun(NEW, "tn_schedule_failed", { phase: "workflow_complete", failureReason: "login failed" });
{
  const r = computeTnRun(feed);
  eq("the newest run is the one displayed", r.runId, NEW);
  ok("the older run's patient does not leak into the newer one", r.patientCreated === false);
  ok("no chart URL from the older run", r.patientUrl === undefined);
  eq("the newer run's reason is shown", r.failedReason, "login failed");
}

console.log("\n[edge] A run that fails before any phase reports, and a stale run");
reset();
terminalFail("entry", "Agent unreachable");
{
  const r = computeTnRun(feed);
  ok("no phases at all: nothing created", r.patientCreated === false);
  eq("outstanding lists every post-save step", r.outstanding, [...TN_POST_SAVE_PHASES].map(() => undefined).length === 3
    ? ["the intake PDF", "the appointment confirmation PDF", "the appointment"] : []);
  ok("the reason is carried", r.failedReason === "Agent unreachable");
}
// A run that died after save, with no terminal at all, must still surface the
// patient once it ages out — that is exactly how an agent crash presents.
reset(11 * 60 * 1000); // older than TN_STALE_MS
throughSave();
{
  const r = computeTnRun(feed);
  ok("a stale run is not in flight", r.inFlight === false);
  ok("a stale run is marked stale", r.stale === true);
  ok("a stale run still reports the created patient", r.patientCreated === true);
  eq("...with its chart URL", r.patientUrl, CHART);
}
// A young run with no terminal is still in flight and must NOT show a card.
reset(30_000);
throughSave();
{
  const r = computeTnRun(feed);
  ok("a young run is still in flight", r.inFlight === true);
  ok("an in-flight run shows no failure", r.failedReason === undefined);
}

console.log("\n[7/8] No agent change, and no patient data in anything new");
const fs = await import("fs");
const path = await import("path");
const libSrc = fs.readFileSync(path.join(process.cwd(), "client", "src", "lib", "tn-run-state.ts"), "utf8");
ok("the derivation module logs nothing", !/console\.|fetch\(/.test(libSrc));
const routesSrc = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf8");
const callback = routesSrc.slice(
  routesSrc.indexOf('app.post("/api/internal/tn-progress/:contactId"'),
  routesSrc.indexOf('// Submissions API'),
);
ok("the progress callback is untouched — still no name in its log lines",
  !/console\.(log|warn|error)\([^)]*contactName/.test(callback));
// The real property is not a magic number: it is that the SERVER did not change
// at all. This build consumes what already arrives, so every server file must be
// byte-identical to the committed version.
const { execSync } = await import("child_process");
const serverDiff = execSync("git diff --name-only HEAD -- server/ shared/", { encoding: "utf8" }).trim();
ok("no server or shared file changed — the agent is asked for nothing new",
  serverDiff === "", serverDiff);
const agentDiff = execSync(
  "git -C /Users/raunekpratap/Desktop/axiom-browser-agent-clone status --porcelain", { encoding: "utf8" },
).trim();
ok("the agent repository is untouched", agentDiff === "", agentDiff);

console.log("\n[wording] Every state's text is a fixed string, built from no record data");
const pageSrc = fs.readFileSync(path.join(process.cwd(), "client", "src", "pages", "contact-detail.tsx"), "utf8");
for (const line of [
  "Patient created in TherapyNotes — appointment not scheduled",
  "Patient created and appointment scheduled — the run did not finish",
  "Do not create this patient again — the record already exists.",
  "No patient was created in TherapyNotes.",
  "Open in TherapyNotes",
]) {
  ok(`  the page contains: "${line.slice(0, 46)}…"`, pageSrc.includes(line));
}
ok("the chart button renders only when a URL exists",
  pageSrc.includes("{tnRun.patientCreated && tnRun.patientUrl && ("));
ok("Retry is still one control with the same handler",
  (pageSrc.match(/data-testid="button-tn-retry"/g) ?? []).length === 1
  && (pageSrc.match(/onClick=\{\(\) => setShowScheduleTnModal\(true\)\}/g) ?? []).length >= 1);

console.log("\n[join] The list reads as a person would say it");
eq("one", joinNaturally(["a"]), "a");
eq("two", joinNaturally(["a", "b"]), "a and b");
eq("three", joinNaturally(["a", "b", "c"]), "a, b and c");
eq("none", joinNaturally([]), "");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
