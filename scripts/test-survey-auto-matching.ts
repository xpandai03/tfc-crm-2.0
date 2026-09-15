/**
 * Self-checks — matching that runs itself.
 *
 * Run: npx tsx scripts/test-survey-auto-matching.ts
 *
 * No database, no network, no PHI. Nothing here invents a patient, because
 * nothing here is about matching RULES — those are covered by
 * test-survey-matching.ts and test-tn-patient-matching.ts, and this build did
 * not touch them. This file is about WHEN matching runs, what it costs the
 * person pressing Submit, and what happens when two runs collide.
 *
 * Two kinds of check live here:
 *
 *   - BEHAVIOURAL, for the serialisation guard, which is real code with a real
 *     property and is driven directly with instrumented functions.
 *   - STRUCTURAL, read from source, for the wiring: where the hook sits, that
 *     it is not awaited, that the re-match is conditional, that the crons are
 *     in the right order. These are the things that would silently regress —
 *     an `await` added in front of the hook breaks nothing visible except a
 *     client's confirmation screen, and no unit test of the matcher would ever
 *     notice.
 */
import { readFileSync } from "fs";
import { withMatchLock } from "../server/survey/match-runner";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const routes = read("server/survey/routes.ts");
const runner = read("server/survey/match-runner.ts");
const cron = read("server/reminders/cron.ts");
const submissions = read("client/src/pages/submissions.tsx");

/** Source with block comments and line comments stripped — what the code DOES. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const routesCode = strip(routes);
const runnerCode = strip(runner);
const cronCode = strip(cron);

async function main() {

// ===========================================================================
console.log("\n[1] A submission is matched on arrival, with no button press");

check("the public survey route reaches the matcher at all",
  /matchOneSubmission/.test(routesCode));
check("...by dynamic import, so the public router does not pull the matcher in at boot",
  /import\(["']\.\/match-runner["']\)/.test(routesCode));

const insertAt = routesCode.indexOf("await insertSubmission");
const hookAt = routesCode.indexOf("matchOneSubmission");
check("the hook runs AFTER the row is stored, not before",
  insertAt !== -1 && hookAt !== -1 && hookAt > insertAt,
  `insert at ${insertAt}, hook at ${hookAt}`);

// The single most important line in this build. If someone "tidies" the
// setImmediate away, every client waits for a thousand-identity match between
// pressing Submit and seeing a thank-you page.
check("it is handed to the event loop rather than run inline",
  /setImmediate\(/.test(routesCode));
check("it is NOT awaited",
  !/await\s+[A-Za-z_$.]*matchOneSubmission/.test(routesCode) &&
  !/await\s+import\(["']\.\/match-runner["']\)/.test(routesCode));

// ===========================================================================
console.log("\n[2] The response does not wait for the match");

const hookBlock = routesCode.slice(hookAt);
// The FIRST success response after the hook — this router has an earlier one
// on a different endpoint, and indexOf from the top would find that instead.
const respondAt = routesCode.indexOf("return res.json({ success: true })", hookAt);
check("the success response is still sent, after the hook is scheduled",
  respondAt > hookAt);
check("nothing between the hook and the response blocks",
  !/await/.test(routesCode.slice(hookAt, respondAt)));

// setImmediate semantics, asserted rather than assumed: the callback cannot
// run before the synchronous code that scheduled it has finished.
let ranDuringHandler = false;
let handlerFinished = false;
setImmediate(() => { ranDuringHandler = !handlerFinished; });
handlerFinished = true;
await sleep(20);
check("a setImmediate callback runs only after the scheduling code returns",
  handlerFinished && !ranDuringHandler);

// ===========================================================================
console.log("\n[3] A failure to RUN is logged; a failure to MATCH is not an error");

check("the arrival hook has a catch",
  /\.catch\(/.test(hookBlock.slice(0, 600)));
check("...which logs an error rather than swallowing it",
  /console\.error\(/.test(hookBlock.slice(0, 600)));
// A match that finds nothing resolves normally and writes a review row; only a
// thrown error reaches the catch. Proven by the matcher's own return type: it
// resolves to a summary in both cases and never throws on "no candidates".
check("no-match is a summary, not a throw — the runner returns review counts",
  /summary\.review \+= 1/.test(runnerCode) && /status: "review"/.test(runnerCode));

// PHI: the error line may carry the submission id and the error message, never
// a field from the payload.
const hookLog = hookBlock.slice(0, 600);
for (const forbidden of ["input.client", "payload", "identity", ".name", ".dateOfBirth", ".phone", ".email"]) {
  check(`the failure log carries no ${forbidden}`, !hookLog.includes(forbidden));
}
check("the failure log names the submission id", /id=\$\{id\}/.test(hookLog));

// ===========================================================================
console.log("\n[4] Arrival reads one row, not the whole table");

const arrivalFn = runnerCode.slice(runnerCode.indexOf("export async function matchOneSubmission"));
check("the arrival path fetches the submission by id",
  /getSubmissionById\(submissionId\)/.test(arrivalFn));
check("...and does NOT load every survey submission to find it",
  !/getRecentSurveySubmissions/.test(arrivalFn.slice(0, arrivalFn.indexOf("withMatchLock") + 2000)));
check("a missing or non-survey row is a warning, not a throw",
  /sub\.formType !== "survey"/.test(arrivalFn) && /console\.warn/.test(arrivalFn));

// ===========================================================================
console.log("\n[5] Every entry point goes through ONE matcher");

eq("matchSubmission is called exactly once in the runner",
  (runnerCode.match(/matchSubmission\(/g) || []).length, 1);
eq("markAutoMatchResult is written from exactly one function",
  (runnerCode.match(/await markAutoMatchResult\(/g) || []).length, 2); // the no-name branch and the verdict, both inside matchOne
check("the nightly run and the arrival hook both call matchOne",
  (runnerCode.match(/await matchOne\(/g) || []).length === 2);
check("both entry points are wrapped in the lock",
  /runSurveyMatching\(\): Promise<MatchRunSummary> \{\s*return withMatchLock/.test(runnerCode) &&
  /matchOneSubmission\(submissionId: number\): Promise<MatchRunSummary> \{\s*return withMatchLock/.test(runnerCode));

// ===========================================================================
console.log("\n[6] Two runs that overlap do not interleave");

const order: string[] = [];
const slow = (tag: string, ms: number) => async () => {
  order.push(`${tag}:start`);
  await sleep(ms);
  order.push(`${tag}:end`);
  return tag;
};

// B starts while A is mid-flight — the 03:01 survey landing during the
// post-pull re-match. B must wait, not interleave.
const a = withMatchLock(slow("A", 60));
const b = withMatchLock(slow("B", 5));
const results = await Promise.all([a, b]);

eq("both runs completed", results, ["A", "B"]);
eq("the second waited for the first to finish",
  order, ["A:start", "A:end", "B:start", "B:end"]);

// ===========================================================================
console.log("\n[7] One failed run does not poison the next");

let secondRan = false;
const boom = withMatchLock(async () => { throw new Error("pull vanished"); });
const after = withMatchLock(async () => { secondRan = true; return "ok"; });

let caught = "";
await boom.catch((e) => { caught = e.message; });
eq("the caller of the failing run still sees its own error", caught, "pull vanished");
eq("the run queued behind it still ran", await after, "ok");
check("...and actually executed its body", secondRan);
check("the chain swallows only on itself, never for the caller",
  /matchInFlight = next\.then\(\(\) => undefined, \(\) => undefined\)/.test(runnerCode));

// ===========================================================================
console.log("\n[8] The re-match runs after the pull, and only on a real pull");

check("the patients cron calls the matcher",
  /runSurveyMatching\(\)/.test(cronCode));
const pullFn = cronCode.slice(cronCode.indexOf("async function runScheduledTnPatients"));
check("...guarded on the pull having succeeded AND replaced the snapshot",
  /if \(summary\.ok && summary\.replaced\)/.test(pullFn));
const guardAt = pullFn.indexOf("summary.ok && summary.replaced");
const pullAt = pullFn.indexOf("await runTnPatientPull");
check("the guard is downstream of the pull", pullAt !== -1 && guardAt > pullAt);
check("a re-match failure is logged and does not break the pull's cleanup",
  /re-match after pull FAILED/.test(cron) && /finally \{\s*isPullingPatients = false/.test(pullFn));

// The three outcomes a pull can have, against the guard as written.
const shouldRematch = (s: { ok: boolean; replaced: boolean }) => s.ok && s.replaced;
check("a complete pull re-matches", shouldRematch({ ok: true, replaced: true }));
check("a partial pull does NOT", !shouldRematch({ ok: false, replaced: false }));
check("a pull that succeeded but stored nothing does NOT",
  !shouldRematch({ ok: true, replaced: false }));

// ===========================================================================
console.log("\n[9] The overnight jobs are in an order that works");

/** Minutes past midnight for a `m h * * *` expression. */
function minuteOf(expr: string): number {
  const [m, h] = expr.split(/\s+/);
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}
const defaultOf = (name: string): string => {
  const m = cron.match(new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]+)"`));
  return m ? m[1] : "";
};
const counts = defaultOf("DEFAULT_ACTIVE_COUNTS_SCHEDULE");
const pull = defaultOf("DEFAULT_TN_PATIENTS_SCHEDULE");
const attach = defaultOf("DEFAULT_ATTACH_SCHEDULE");

eq("active counts at 02:30", counts, "30 2 * * *");
eq("the patient pull at 03:00", pull, "0 3 * * *");
eq("the attach batch at 03:30", attach, "30 3 * * *");

check("counts run before the pull", minuteOf(counts) < minuteOf(pull));
// THE BUG THIS BUILD FIXES. Attach used to be "0 0 * * *" — three hours BEFORE
// the pull that makes a new patient matchable, so a survey taken yesterday
// afternoon waited a second night to reach a chart.
check("ATTACH RUNS AFTER THE PULL, not before", minuteOf(attach) > minuteOf(pull));
check("...with headroom over a pull measured at 133 seconds",
  minuteOf(attach) - minuteOf(pull) >= 15);
check("all three are still explicitly Mountain",
  (cronCode.match(/timezone: [A-Z_]+_TIMEZONE/g) || []).length >= 3);
check("the schedule stays overridable by environment",
  /process\.env\.SURVEY_ATTACH_CRON_SCHEDULE \|\| DEFAULT_ATTACH_SCHEDULE/.test(cronCode));

// ===========================================================================
console.log("\n[10] Staff can see that it ran");

check("the client match state carries the last-matched time",
  /updatedAt: string;/.test(submissions.slice(
    submissions.indexOf("interface MatchState"),
    submissions.indexOf("interface MatchCounts"))));
check("...and it is rendered on the row", /<MatchCheckedNote state=/.test(submissions));
check("the rendered value is a timestamp, nothing else",
  /formatRelativeTime\(state\.updatedAt\)/.test(submissions) &&
  /formatExactTime\(state\.updatedAt\)/.test(submissions));
check("the server already returns updatedAt on every state",
  /updatedAt: String\(r\.updated_at\)/.test(read("server/survey/match-db.ts")));

// ===========================================================================
console.log("\n[11] Nothing that was working was changed");

check("the matcher's rules file was not touched by this build",
  !/setImmediate|withMatchLock|cron/.test(read("server/survey/matching.ts")));
check("the attach batch still decides for itself what to attach",
  !/matchOneSubmission|runSurveyMatching/.test(read("server/survey/attach-runner.ts")));
check("auth middleware is untouched by the survey router",
  !/authMiddleware|requireAuth/.test(routesCode));
check("the manual button still exists",
  /survey\/matching\/run/.test(read("server/routes.ts")));

// ===========================================================================
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
}

main().catch((e) => { console.error(e); process.exit(1); });
