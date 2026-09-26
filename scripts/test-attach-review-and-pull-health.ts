/**
 * Self-checks — attach refusals that go to review, and a pull that says when it
 * failed.
 *
 * Run: npx tsx scripts/test-attach-review-and-pull-health.ts
 *
 * No database, no network, no browser. The pull is driven through its injected
 * fetch; with no DATABASE_URL the snapshot write fails, which is exactly the
 * point where these checks stop caring. Every value below is invented.
 */
import { readFileSync } from "fs";
import {
  ATTACH_REFUSAL_REVIEW_REASON,
  REASON_FIELD,
  REASON_LABEL,
  REASON_SHORT,
  REVIEW_REASONS,
  isAttachRefusal,
  isMatchReason,
  reviewReasonForAttachRefusal,
} from "../shared/survey-match-reasons";
import { ATTACH_FAILURE_REASONS, ATTACH_LOCAL_REASONS } from "../shared/survey-attach-reasons";

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

async function main() {
  // =========================================================================
  console.log("\n[1] The refusal-class table");
  const DATA = {
    clinician_mismatch: "attach_clinician_mismatch",
    clinician_unassigned: "attach_clinician_unassigned",
    phone_mismatch: "attach_phone_mismatch",
    dob_mismatch: "attach_dob_mismatch",
    name_mismatch: "attach_name_mismatch",
    expected_chart_not_in_results: "attach_chart_not_in_search",
    multiple_candidates: "attach_multiple_charts",
  };
  eq("exactly these seven are data mismatches", ATTACH_REFUSAL_REVIEW_REASON, DATA);
  for (const [code, review] of Object.entries(DATA)) {
    eq(`${code} -> review as ${review}`, reviewReasonForAttachRefusal(code), review);
  }
  // Every other code the agent or the CRM can record is transient.
  const transient = [
    ...ATTACH_FAILURE_REASONS.filter((c) => !(c in DATA)),
    ...Object.keys(ATTACH_LOCAL_REASONS),
  ];
  for (const code of transient) {
    eq(`${code} stays matched and retries`, reviewReasonForAttachRefusal(code), null);
  }
  // The four the brief called ambiguous are, by rule, transient.
  for (const code of ["patient_not_found", "result_set_possibly_truncated", "field_unreadable", "agent_rejected_request"]) {
    check(`ambiguous ${code} is transient`, reviewReasonForAttachRefusal(code) === null);
  }
  eq("no code at all is transient", reviewReasonForAttachRefusal(null), null);
  eq("an unknown code is transient", reviewReasonForAttachRefusal("zztest_unknown"), null);
  eq("a prototype key is not a code", reviewReasonForAttachRefusal("toString"), null);

  // =========================================================================
  console.log("\n[2] The review reasons exist, read plainly, and carry no identity");
  for (const r of Object.values(DATA)) {
    check(`${r} is a review reason`, (REVIEW_REASONS as readonly string[]).includes(r));
    check(`${r} is recognised by isMatchReason`, isMatchReason(r));
    check(`${r} is an attach refusal`, isAttachRefusal(r));
    check(`${r} has a label and a chip`,
      !!REASON_LABEL[r as keyof typeof REASON_LABEL] && !!REASON_SHORT[r as keyof typeof REASON_SHORT]);
    check(`${r} has a field entry`, r in REASON_FIELD);
  }
  eq("the clinician refusal reads as the client's wording",
    REASON_LABEL.attach_clinician_mismatch,
    "Clinician on survey does not match the chart's assigned clinician");
  check("no matcher reason is mistaken for an attach refusal",
    REVIEW_REASONS.filter((r) => !r.startsWith("attach_")).every((r) => !isAttachRefusal(r)));
  check("a staff sentence is not an attach refusal", !isAttachRefusal("Confirmed by staff"));

  // =========================================================================
  console.log("\n[3] The state machine — by the code, not by hand");
  const db = read("server/survey/match-db.ts");
  check("the re-match leaves an attach refusal alone",
    /WHERE survey_match_reviews\.resolved_by IS NULL\s+AND left\(survey_match_reviews\.reason, 7\) <> 'attach_'/.test(db));
  const mark = db.slice(db.indexOf("export async function markAttachRefusalForReview"),
    db.indexOf("export async function recordHumanResolution"));
  check("the transition sets review", /status\s+= 'review'/.test(mark));
  check("...stamps the attempt time", /updated_at\s+= NOW\(\)/.test(mark));
  check("...clears a prior human confirmation", /resolved_by = NULL/.test(mark));
  check("...keeps the contact and chart the reviewer needs",
    !/matched_contact_id\s*=/.test(mark) && !/matched_chart_id\s*=/.test(mark));
  const human = db.slice(db.indexOf("export async function recordHumanResolution"));
  check("a person can still resolve it (no attach_ guard on their write)",
    !/attach_/.test(human.slice(0, human.indexOf("export async function setSubmissionContactId"))));

  const runner = read("server/survey/attach-runner.ts");
  const one = runner.slice(runner.indexOf("export async function attachOne"),
    runner.indexOf("// The overnight batch"));
  check("attachOne classifies only a failure",
    /status === "failed" \? reviewReasonForAttachRefusal\(reason\) : null/.test(one));
  check("...and moves it through markAttachRefusalForReview",
    /await markAttachRefusalForReview\(\{ submissionId, reason: reviewReason \}\)/.test(one));
  check("...after the attempt is recorded, not instead of it",
    one.indexOf("recordAttachOutcome(") < one.indexOf("markAttachRefusalForReview("));
  check("the log line carries the id and the code, nothing else",
    /TO REVIEW id=\$\{submissionId\} reason=\$\{reviewReason\}/.test(one));
  check("the batch still sends only matched rows",
    /if \(state\.status !== "matched"\) \{/.test(runner));
  check("the button still needs no match, so a reviewed row can be re-run",
    /trigger === "scheduled"\s*\n?\s*\? await checkEligibility\(submission\)/.test(runner));
  check("the batch summary counts what went to review", /if \(r\.sentToReview\) summary\.toReview \+= 1;/.test(runner));
  check("the nightly log line reports it", /to_review=\$\{s\.toReview\}/.test(read("server/reminders/cron.ts")));
  check("the batch query itself was not edited to hide anything",
    /getRecentSurveySubmissions\(1000\),\s*\n\s*getAttachedOrRunningIds\(\),/.test(runner));

  // =========================================================================
  console.log("\n[4] The pull: floor, retry, truncation, loud failure");
  const pull = await import("../server/therapy-notes/tn-patients-runner");
  eq("floor is 80%", pull.MIN_KEEP_FRACTION, 0.8);
  check("1,041 against 1,043 passes", !pull.belowFloor(1041, 1043));
  check("835 against 1,043 passes (exactly 80%, rounded up)", !pull.belowFloor(835, 1043));
  check("834 against 1,043 is below the floor", pull.belowFloor(834, 1043));
  check("zero against 1,043 is below the floor", pull.belowFloor(0, 1043));
  check("the first pull ever has no floor", !pull.belowFloor(12, 0));
  for (const s of [502, 503, 504, null]) check(`${s ?? "no response"} is retried`, pull.isTransientTransport(s));
  for (const s of [400, 401, 403, 404, 422, 500]) check(`${s} is not retried`, !pull.isTransientTransport(s));

  const page = (o: Record<string, unknown> = {}) => ({
    option_value: "1", label: "Zztest Clinician", status: "success", pages_read: 2,
    rows: [{ chart_id: "ZZTESTchart0001", name: "Zztest Person", dob: "1/2/1980", phone: "",
             clinician_option_value: "1", clinician_label: "Zztest Clinician" }],
    ...o,
  });
  const ok = (pages: unknown[]) => new Response(JSON.stringify({
    status: "success", captured_at: "2026-09-25T09:02:00Z", results: pages,
  }), { status: 200 });
  const script = (...steps: Array<() => Response | never>) => {
    let i = 0;
    const calls = { n: 0 };
    const f = (async () => { calls.n++; return steps[Math.min(i++, steps.length - 1)](); }) as unknown as typeof fetch;
    return { f, calls };
  };

  {
    const { f, calls } = script(() => new Response("bad gateway", { status: 502 }), () => ok([page()]));
    const s = await pull.runTnPatientPull("manual", { retryDelayMs: 1, fetchImpl: f });
    eq("a 502 then a body: two requests", calls.n, 2);
    eq("...recorded as two attempts", s.attempts, 2);
    check("...and it got as far as the write (which has no database here)",
      /storing the snapshot failed/.test(s.message ?? ""), s.message);
    eq("...with the page count carried", s.pagesRead, 2);
  }
  {
    const { f, calls } = script(() => { throw new TypeError("fetch failed"); }, () => ok([page()]));
    const s = await pull.runTnPatientPull("manual", { retryDelayMs: 1, fetchImpl: f });
    eq("a dropped connection is retried", calls.n, 2);
    check("...and then proceeds", /storing the snapshot failed/.test(s.message ?? ""), s.message);
  }
  {
    const { f, calls } = script(() => new Response("", { status: 502 }));
    const s = await pull.runTnPatientPull("scheduled", { retryDelayMs: 1, fetchImpl: f });
    eq("three 502s: three requests and no more", calls.n, 3);
    check("...fails naming the attempts", /HTTP 502 \(after 3 attempts\)/.test(s.message ?? ""), s.message);
    check("...and does not replace", s.ok === false && s.replaced === false);
  }
  {
    const { f, calls } = script(() => new Response("", { status: 403 }));
    const s = await pull.runTnPatientPull("scheduled", { retryDelayMs: 1, fetchImpl: f });
    eq("a 403 is an answer: one request", calls.n, 1);
    check("...and fails", s.ok === false, s.message);
  }
  {
    const { f, calls } = script(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
    const s = await pull.runTnPatientPull("scheduled", { retryDelayMs: 1, fetchImpl: f });
    eq("a timeout is not retried", calls.n, 1);
    check("...and says so", /did not answer within 600s/.test(s.message ?? ""), s.message);
  }
  {
    const { f } = script(() => ok([page({ truncated: true })]));
    const s = await pull.runTnPatientPull("scheduled", { retryDelayMs: 1, fetchImpl: f });
    check("a truncated clinician list refuses to replace",
      /truncated — incomplete pull, not replacing the snapshot/.test(s.message ?? ""), s.message);
  }
  {
    const { f } = script(() => ok([page({ rows: [], pages_read: 0 })]));
    const s = await pull.runTnPatientPull("scheduled", { retryDelayMs: 1, fetchImpl: f });
    check("zero rows refuses, with the counts",
      /returned no patient rows \(0 rows over 0 pages\)/.test(s.message ?? ""), s.message);
    check("...keeping the previous snapshot", s.replaced === false);
  }
  const src = read("server/therapy-notes/tn-patients-runner.ts");
  check("the floor is checked before the write",
    src.indexOf("belowFloor(patients.length, previous.rows)") < src.indexOf("replaceTnPatients(patients"));
  check("a failure is logged as an error", /console\.error\(\s*\n?\s*`\[tn-patients\] \$\{trigger\} pull FAILED/.test(src));
  check("the success line reports pages and the previous count",
    /\$\{pagesRead\} pages, \$\{rowsReturned\} rows -> \$\{patients\.length\} patients stored/.test(src)
    && /\(was \$\{previous\.rows\}\)/.test(src));
  check("the write is still one transaction (swap only on success)",
    /BEGIN[\s\S]{0,400}DELETE FROM tn_patients/.test(read("server/therapy-notes/tn-patients-db.ts")));

  // =========================================================================
  console.log("\n[5] The health line");
  const tdb = read("server/therapy-notes/tn-patients-db.ts");
  const health = tdb.slice(tdb.indexOf("export async function tnPullHealth"), tdb.indexOf("/** Counts for the run report"));
  check("reads the snapshot's count and capture time", /COUNT\(\*\)::int AS n, MAX\(captured_at\) AS at FROM tn_patients/.test(health));
  check("...and the last attempt from the activity log", /type = 'tn_patient_pull' ORDER BY created_at DESC LIMIT 1/.test(health));
  check("...selecting no patient column", !/\b(name|dob|phone)\b\s*(,|FROM)/.test(health));
  const snap = read("server/survey/snapshot.ts");
  check("the snapshot carries it", /patientPull,\n\s*\};/.test(snap) && /tnPullHealth\(\)\.catch\(\(\) => null\)/.test(snap));
  const ui = read("client/src/components/survey-snapshot.tsx");
  check("the snapshot renders it", /<PatientPullLine pull=\{data\.patientPull\} \/>/.test(ui));
  check("a failed attempt is shown, with the kept list", /failed and the previous list was kept/.test(ui));
  check("a stale list is flagged on its own", /PULL_STALE_MS = 36 \* 60 \* 60 \* 1000/.test(ui));

  console.log(`\n${"=".repeat(62)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
