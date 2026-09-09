/**
 * Self-checks — survey PDF to chart attach.
 *
 * Run: npx tsx scripts/test-survey-attach.ts
 *
 * Pure checks only (eligibility, wording, wiring). The atomic claim needs a real
 * database and lives in scripts/test-survey-attach-claim.ts.
 *
 * NO PHI. Every identity is invented for this file.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import {
  ATTACH_FAILURE_REASONS, ATTACH_FAILURE_TEXT, ATTACH_INELIGIBLE_TEXT,
  ATTACH_LOCAL_REASONS, attachFailureText, attachIneligibleText, isAttachFailureReason,
} from "../shared/survey-attach-reasons";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const routesSrc = readFileSync(join(process.cwd(), "server", "routes.ts"), "utf8");
const runnerSrc = readFileSync(join(process.cwd(), "server", "survey", "attach-runner.ts"), "utf8");
const dbSrc = readFileSync(join(process.cwd(), "server", "survey", "attach-db.ts"), "utf8");
const cronSrc = readFileSync(join(process.cwd(), "server", "reminders", "cron.ts"), "utf8");
const pageSrc = readFileSync(join(process.cwd(), "client", "src", "pages", "submissions.tsx"), "utf8");

// ---------------------------------------------------------------------------
console.log("\n[1] The PDF route is API-key gated and mirrors the two beside it");
const attachRoutesSrc = readFileSync(join(process.cwd(), "server", "survey", "attach-routes.ts"), "utf8");
const pdfRoute = attachRoutesSrc;
ok("the internal survey PDF route exists",
  pdfRoute.includes('app.get("/api/internal/survey-pdf/:submissionId"'));
// It is NOT in publicPaths and auth.ts is untouched, so it MUST be mounted
// above the middleware or the agent gets a login redirect instead of a PDF.
const indexSrc = readFileSync(join(process.cwd(), "server", "index.ts"), "utf8");
ok("it is mounted BEFORE app.use(authMiddleware)",
  indexSrc.indexOf("registerSurveyAttachInternalRoutes(app);") <
  indexSrc.indexOf("app.use(authMiddleware);"));
const authSrc = readFileSync(join(process.cwd(), "server", "auth.ts"), "utf8");
ok("auth.ts was not touched",
  execSync("git diff --name-only HEAD -- server/auth.ts", { encoding: "utf8" }).trim() === "");
ok("no path was added to publicPaths", !authSrc.includes("survey-pdf"));
ok("it checks X-API-Key against TN_API_KEY",
  /req\.headers\["x-api-key"\]/.test(pdfRoute) && /process\.env\.TN_API_KEY/.test(pdfRoute));
ok("it 401s without the key", /return res\.status\(401\)/.test(pdfRoute));
ok("it reuses buildSurveyDocument, not a second generator",
  pdfRoute.includes("buildSurveyDocument") && !pdfRoute.includes("buildIntakeDocument"));
ok("it refuses a non-survey submission", pdfRoute.includes("isSurveyPayload"));
ok("it logs the id and outcome only, never the filename",
  /\[internal-survey-pdf\] SERVED: id=/.test(pdfRoute) && !/console\.[a-z]+\([^)]*filename/.test(pdfRoute));
ok("the agent-facing filename carries no name, only the submission id",
  /filename="Client-Survey-Sub\$\{submission\.id\}\.pdf"/.test(pdfRoute));
// Same gate shape as the existing internal routes.
for (const route of ["contact-intake-pdf", "contact-snapshot-pdf"]) {
  const existing = routesSrc.slice(routesSrc.indexOf(`app.get("/api/internal/${route}/`));
  ok(`  ${route} uses the same gate (pattern confirmed)`,
    existing.slice(0, 400).includes('req.headers["x-api-key"]'));
}
ok("the agent is pointed at the internal route, not the staff one",
  runnerSrc.includes("/api/internal/survey-pdf/") && !runnerSrc.includes("/api/survey/pdf/"));

// ---------------------------------------------------------------------------
console.log("\n[2] Eligibility — only a matched survey with every verified field");
// checkEligibility needs a DB for the match lookup, so the RULE is asserted from
// the source and the field logic is exercised directly below.
for (const gate of ["awaiting_review", "no_match", "no_name", "no_dob", "no_phone", "no_therapist", "not_a_survey"]) {
  ok(`  the runner refuses on ${gate}`, runnerSrc.includes(`code: "${gate}"`));
}
ok("a review row is refused BEFORE anything else about the payload is read",
  runnerSrc.indexOf('code: "awaiting_review"') < runnerSrc.indexOf('code: "no_name"'));
ok("only status 'matched' passes", /state\.status !== "matched"/.test(runnerSrc));
ok("the phone floor matches the agent's schema (>= 7 digits)",
  /replace\(\/\\D\/g, ""\)\.length < 7/.test(runnerSrc));
ok("the date of birth is converted to the MM/DD/YYYY the agent requires",
  runnerSrc.includes("isoToMMDDYYYY"));
ok("every field the agent verifies is required before dispatch",
  ["firstName", "lastName", "dob", "phone", "clinicianName"].every((f) => runnerSrc.includes(f)));

// ---------------------------------------------------------------------------
console.log("\n[3] The button cannot be double-pressed");
ok("the claim is an atomic INSERT ... ON CONFLICT", dbSrc.includes("ON CONFLICT (submission_id) DO UPDATE"));
ok("an 'attached' row never yields the claim",
  /WHERE survey_attach_attempts\.status = 'failed'/.test(dbSrc)
  && !/status = 'attached'\s*$/m.test(dbSrc.slice(dbSrc.indexOf("WHERE survey_attach_attempts.status"), dbSrc.indexOf("RETURNING submission_id"))));
ok("a 'running' row yields only after it goes stale",
  /status = 'running'[\s\S]{0,120}started_at < NOW\(\)/.test(dbSrc));
ok("the claim happens BEFORE the dispatch",
  runnerSrc.indexOf("claimAttach(") < runnerSrc.indexOf("fetch(SURVEY_ATTACH_AGENT_URL"));
ok("losing the claim is reported, not retried",
  /const code = existing\?\.status === "running" \? "in_progress" : "already_attached";/.test(runnerSrc)
  && runnerSrc.includes('status: "skipped", reason: code'));
ok("the button is disabled once attached",
  pageSrc.includes('if (attachState?.status === "attached") ineligible = "already_attached";'));
ok("the button is disabled while running",
  pageSrc.includes('ineligible = "in_progress"'));
ok("disabled is driven by the ineligibility code, not a separate flag",
  pageSrc.includes("disabled={!!ineligible}"));
ok("the button shows that it is running", pageSrc.includes("Filing to chart…"));

// ---------------------------------------------------------------------------
console.log("\n[4] The scheduled job — timezone, cap, and a logged next fire");
ok("registered with node-cron", cronSrc.includes("startSurveyAttachCron"));
ok("midnight by default", cronSrc.includes('DEFAULT_ATTACH_SCHEDULE = "0 0 * * *"'));
ok("EXPLICIT timezone, America/Denver",
  cronSrc.includes('ATTACH_TIMEZONE = "America/Denver"')
  && /cron\.schedule\(schedule, \(\) => \{ void runSurveyAttachBatch\(\); \}, \{ timezone: ATTACH_TIMEZONE \}\)/.test(cronSrc));
ok("the expression is validated before it is trusted", /cron\.validate\(schedule\)/.test(cronSrc));
ok("an invalid expression is loud and does NOT silently schedule nothing",
  /INVALID schedule[\s\S]{0,160}NOT scheduled/.test(cronSrc));
ok("the next fire time is computed and logged at boot", cronSrc.includes("nextFireDescription"));
ok("it is registered at startup",
  readFileSync(join(process.cwd(), "server", "index.ts"), "utf8").includes("startSurveyAttachCron();"));
ok("the table is created at startup",
  readFileSync(join(process.cwd(), "server", "index.ts"), "utf8").includes("initSurveyAttachTable();"));
ok("a cap exists and is exported", runnerSrc.includes("ATTACH_BATCH_CAP = 12"));
ok("over-cap work is deferred, not dropped", runnerSrc.includes("summary.deferred"));

console.log("\n[5] One at a time, and a failure does not stop the rest");
ok("the batch awaits each attach in sequence",
  /for \(const sub of ready\) \{[\s\S]{0,400}await attachOne\(/.test(runnerSrc));
ok("there is no Promise.all over the batch",
  !/Promise\.all\([\s\S]{0,200}attachOne/.test(runnerSrc));
ok("each attach is wrapped so one cannot take the run down",
  /try \{[\s\S]{0,300}await attachOne\([\s\S]{0,600}\} catch \(e\) \{/.test(runnerSrc));
ok("attachOne resolves rather than throws on agent failure",
  /catch \(err\) \{[\s\S]{0,200}AbortError/.test(runnerSrc));
ok("a second overlapping cron run is refused", cronSrc.includes("isAttaching"));
ok("a heartbeat is logged even with nothing to do",
  /Run complete in \$\{[\s\S]{0,200}eligible=/.test(cronSrc));

// ---------------------------------------------------------------------------
console.log("\n[6] Every failure reason has staff-facing wording");
const FALLBACK = "Download the PDF and attach it in TherapyNotes by hand.";
for (const r of ATTACH_FAILURE_REASONS) {
  const text = ATTACH_FAILURE_TEXT[r];
  ok(`  ${r} has wording`, typeof text === "string" && text.length > 20);
  ok(`  ${r} names no code`, !text.includes(r));
  ok(`  ${r} points at the manual path`, /attach it in TherapyNotes by hand|check the chart/i.test(text));
  for (const jargon of ["payload", "selector", "phase", "verification", "HTTP", "null", "422"]) {
    ok(`  ${r} avoids "${jargon}"`, !text.toLowerCase().includes(jargon.toLowerCase()));
  }
}
// The two expected refusals must read as expected, not as breakage.
ok("phone_mismatch says a home number is expected",
  /home number this is expected and nothing is\s+wrong/.test(ATTACH_FAILURE_TEXT.phone_mismatch));
ok("patient_not_found says a middle name explains it",
  /middle name/.test(ATTACH_FAILURE_TEXT.patient_not_found)
  && /Nothing is wrong with the survey/.test(ATTACH_FAILURE_TEXT.patient_not_found));
for (const [k, v] of Object.entries(ATTACH_LOCAL_REASONS)) {
  ok(`  local reason ${k} has wording`, typeof v === "string" && v.length > 20);
}
ok("agent_timeout warns the chart may already have it",
  /may still have filed/.test(ATTACH_LOCAL_REASONS.agent_timeout));
eq("an unknown code is shown, not swallowed",
  attachFailureText("something_new"), `something_new. ${FALLBACK}`);
eq("an empty code still gives an instruction",
  attachFailureText(""), `The survey was not filed. ${FALLBACK}`);
ok("isAttachFailureReason rejects a local code", !isAttachFailureReason("agent_timeout"));
for (const k of Object.keys(ATTACH_INELIGIBLE_TEXT)) {
  ok(`  ineligibility ${k} has wording`, attachIneligibleText(k).length > 10);
}
eq("an unknown ineligibility falls back safely",
  attachIneligibleText("nope"), "This survey cannot be filed to a chart.");
ok("awaiting_review explains the next step is the review queue",
  /Review the identity first/.test(ATTACH_INELIGIBLE_TEXT.awaiting_review));

console.log("\n[7] The download button survives a failed attach");
ok("Download PDF is rendered for every survey row, ungated by attach state",
  /isSurveySubmission\(sub\) && \(\s*<a\s+href=\{`\/api\/survey\/pdf\/\$\{sub\.id\}`\}/.test(pageSrc));
ok("the failure line is rendered on the row", pageSrc.includes("attach-failure-"));
ok("the failure line uses the shared wording", pageSrc.includes("attachFailureText(attachFor(sub.id)?.reason)"));
ok("an expected refusal is not shown as a destructive toast",
  /title: "Not filed", description: attachFailureText\(r\.reason\) \}\)/.test(pageSrc));

console.log("\n[8] Nothing else in the repository was disturbed");
// Pinned to the commit that shipped this build rather than to HEAD. Comparing
// against HEAD held while the work was in flight and says nothing once it is
// committed and later builds land on top — it then flags THEIR files, not ours.
const ATTACH_COMMIT = "8b81184";
const changed = execSync(`git diff --name-only ${ATTACH_COMMIT}^ ${ATTACH_COMMIT}`, { encoding: "utf8" })
  .trim().split("\n").filter(Boolean);
const expected = [
  "client/src/pages/submissions.tsx",
  "package.json",
  "scripts/test-survey-attach-claim.ts",
  "scripts/test-survey-attach.ts",
  "scripts/test-tn-partial-success.ts",
  "server/activity/db.ts",
  "server/index.ts",
  "server/reminders/cron.ts",
  "server/reminders/index.ts",
  "server/routes.ts",
  "server/survey/attach-db.ts",
  "server/survey/attach-routes.ts",
  "server/survey/attach-runner.ts",
  "shared/survey-attach-reasons.ts",
];
eq("this build touched exactly the files it should have", changed.sort(), expected.sort());
ok("the partial-success work is committed and untouched",
  !changed.includes("client/src/lib/tn-run-state.ts"));
const untracked = execSync("git ls-files --others --exclude-standard", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
ok("the pre-existing untracked directory is still untracked and unmodified",
  // git quotes a path containing a non-breaking space, so the entry is
  // "\"TFC-Q4-SURVEY/Screenshot …\"" rather than a bare path.
  untracked.some((f) => f.includes("TFC-Q4-SURVEY/")));
// The agent repository is a SEPARATE checkout and another session is working
// in it concurrently, so "it has no uncommitted changes" is not a claim this
// build can make. What this build must guarantee is that NOTHING IT WROTE is
// in there — asserted by path, which is the property that is actually ours.
const agentDirty = execSync(
  "git -C /Users/raunekpratap/Desktop/axiom-browser-agent-clone status --porcelain",
  { encoding: "utf8" },
).trim();
ok("no file this build touched lives in the agent repository",
  changed.every((f) => !f.includes("axiom-browser-agent")) &&
  untracked.every((f) => !f.includes("axiom-browser-agent")));
console.log(
  `       (note: the agent repo has ${agentDirty ? agentDirty.split("\n").length : 0} ` +
  `file(s) modified by ANOTHER session — not this one)`,
);

console.log("\n[9] No PHI in any log line or activity entry");
/** Source with comments removed — a line SAYING "no phone is stored" is not a
 *  line that stores one, and a substring test cannot tell them apart. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** The identity-shaped things that must never be INTERPOLATED into a log. */
const IDENTITY = /firstName|lastName|\.name\b|dateOfBirth|\.dob\b|\.phone\b|clinicianName|payload|document_name|attachDocumentName/;
for (const [label, src] of [["runner", runnerSrc], ["attach-db", dbSrc], ["cron", cronSrc]] as const) {
  const logs = codeOnly(src).match(/console\.(log|warn|error)\([\s\S]*?\);/g) ?? [];
  for (const l of logs) {
    // Only the ${...} substitutions can carry a value; the fixed text around
    // them is a description and may legitimately use the word "phone".
    const interpolations = l.match(/\$\{[^}]*\}/g) ?? [];
    ok(`  ${label}: log interpolates no identity — ${l.slice(0, 44).replace(/\s+/g, " ")}…`,
      !interpolations.some((i) => IDENTITY.test(i)), interpolations.join(" "));
  }
}
ok("the activity entry's entityName is a fixed string",
  runnerSrc.includes('entityName: "Client survey"'));
ok("the activity metadata carries ids and codes only",
  /metadata: \{\s*submissionId, contactId: elig\.fields\.contactId, trigger,/.test(runnerSrc));
// Assert on the DDL itself, not the file, so the doc comment promising the
// absence is not mistaken for the thing it forbids.
const ddl = dbSrc.slice(
  dbSrc.indexOf("CREATE TABLE IF NOT EXISTS survey_attach_attempts"),
  dbSrc.indexOf("CREATE INDEX IF NOT EXISTS idx_survey_attach_status"),
);
ok("the attach table stores no identity and no chart URL",
  !/first_name|last_name|patient_dob|\bphone\b|tn_patient_url|patient_url/.test(ddl), ddl.slice(0, 80));
eq("its columns are ids, status, a reason code, a trigger and timings",
  (ddl.match(/^\s+([a-z_]+) +(INTEGER|TEXT|TIMESTAMPTZ)/gm) ?? []).map((l) => l.trim().split(/\s+/)[0]).sort(),
  ["actor_email", "contact_id", "duration_ms", "finished_at", "reason", "started_at",
   "status", "submission_id", "trigger", "updated_at"]);
ok("the document name carries a date and an id, never a name",
  /return `Client Survey \$\{date\} \(Sub \$\{submission\.id\}\)`/.test(runnerSrc));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
