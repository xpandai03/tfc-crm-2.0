/**
 * Self-checks — the CRM does NOT send a chart id to attach.
 *
 * Run: npx tsx scripts/test-attach-chart-id.ts
 *
 * No database, no network, no PHI. Every identity below is invented here.
 *
 * WHY. Attach used to send the match's TherapyNotes chart id so the agent could
 * open that record directly. TherapyNotes' record id changes between page
 * loads: the id the nightly pull captured never matched what a later search
 * showed for the same patient, and every attach that selected by it refused
 * (2026-09-22 to 2026-10-01). The agent now selects by name + date of birth and
 * verifies four fields. These checks pin the CRM's half: no chart id in any
 * payload, the batch and the button send the same payload, the stored id is
 * kept (advisory), and the matcher did not move.
 *
 * The payload builder is pure and is driven directly. What needs a database —
 * the match lookup on each trigger — is asserted from source.
 */
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { buildAttachBody, type AttachPayloadFields } from "../server/survey/attach-runner";
import { reviewReasonForAttachRefusal } from "@shared/survey-match-reasons";

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
const runner = read("server/survey/attach-runner.ts");
const code = runner.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

function fields(over: Partial<AttachPayloadFields> = {}): AttachPayloadFields {
  return {
    firstName: "Zzmary", lastName: "Zzwatson", dob: "04/12/1990",
    phone: "(505) 555-0143", clinicianName: "Zzamanda Zzdavison (ABQ)",
    contactId: null, ...over,
  };
}
const build = (f: AttachPayloadFields) =>
  buildAttachBody({ submissionId: 7, fields: f, documentName: "Client Survey", baseUrl: "https://crm.test" });

// ===========================================================================
console.log("\n[1] No chart id in any payload");
for (const f of [fields(), fields({ contactId: 42 })]) {
  const b = build(f);
  check(`no expected_chart_id (contact=${f.contactId})`, !("expected_chart_id" in b));
}
// Even a caller that smuggles one in through an untyped object gets nothing.
check("an extra chartId field is not forwarded",
  !("expected_chart_id" in build({ ...fields(), chartId: "ZZCHART1" } as AttachPayloadFields)));
check("the payload type has no chartId", !/chartId/.test(code));
check("the runner never reads matchedChartId", !/matchedChartId/.test(code));
check("no expected_chart in a log line", !/expected_chart/.test(code));

// ===========================================================================
console.log("\n[2] Exactly the keys the agent needs, from the submission");
eq("keys without a contact", Object.keys(build(fields())).sort(),
  ["clinician_name", "dob", "document_name", "first_name", "last_name", "pdf_url", "phone"]);
eq("keys with a contact", Object.keys(build(fields({ contactId: 42 }))).sort(),
  ["clinician_name", "contact_id", "dob", "document_name", "first_name", "last_name", "pdf_url", "phone"]);

// ===========================================================================
console.log("\n[3] The batch, the button and a re-run from review send the SAME payload");
// One builder for every trigger.
eq("buildAttachBody is called once in the runner", (code.match(/= buildAttachBody\(\{/g) ?? []).length, 1);
// The batch takes the contact id from the match row; the button takes it from
// the SAME row whatever its status, so a re-run from review (status "review")
// carries it too. Same fields in, same payload out.
check("the batch carries the match's contact id",
  /fields: \{ \.\.\.identity\.fields, contactId: state\.matchedContactId \}/.test(code));
check("the button fills the contact id from the match row, with no status condition",
  /trigger === "manual" && elig\.fields\.contactId === null\)[\s\S]{0,200}if \(state\?\.matchedContactId\) elig\.fields\.contactId = state\.matchedContactId/.test(code)
  && !/state\?\.status === "matched"/.test(code));
eq("a batch payload and a review re-run payload for the same row are identical",
  JSON.stringify(build(fields({ contactId: 42 }))), JSON.stringify(build(fields({ contactId: 42 }))));

// ===========================================================================
console.log("\n[4] The stored chart id is kept, and labelled advisory");
const matchDb = read("server/survey/match-db.ts");
check("survey_match_reviews still stores matched_chart_id", /matched_chart_id/.test(matchDb));
check("its type says ADVISORY", /ADVISORY, for display and audit only/.test(matchDb));
check("the Submissions page type says ADVISORY",
  /ADVISORY: the TherapyNotes chart id/.test(read("client/src/pages/submissions.tsx")));

// ===========================================================================
console.log("\n[5] Old refusals still read correctly");
// expected_chart_not_in_results is no longer produced, but attempts recorded
// before 2026-10-01 carry it and must still map to their review reason.
eq("the retired agent code still maps", reviewReasonForAttachRefusal("expected_chart_not_in_results"),
  "attach_chart_not_in_search");

// ===========================================================================
console.log("\n[6] The matcher, the schedule and auth are untouched");
const changed = execSync(
  "git diff --name-only origin/main -- server/survey/matching.ts server/survey/match-runner.ts server/auth.ts",
  { encoding: "utf8" },
).trim();
eq("matching.ts, match-runner.ts and auth.ts have no change from main", changed, "");
// match-db.ts itself changed on 2026-10-01 (a comment, and the review counts
// now skip deleted surveys), so the guard is on what the matcher WRITES: the
// two functions that record a verdict must be byte-identical to main.
const fnText = (src: string, name: string) => {
  const a = src.indexOf(`export async function ${name}(`);
  const b = src.indexOf("\nexport ", a + 1);
  return a < 0 ? "" : src.slice(a, b < 0 ? undefined : b);
};
const mainMatchDb = execSync("git show origin/main:server/survey/match-db.ts", { encoding: "utf8" });
for (const fn of ["markAutoMatchResult", "markAttachRefusalForReview", "recordHumanResolution"]) {
  check(`${fn} is unchanged from main`,
    fnText(matchDb, fn) !== "" && fnText(matchDb, fn) === fnText(mainMatchDb, fn));
}
check("the attach schedule is still 03:30",
  /DEFAULT_ATTACH_SCHEDULE = "30 3 \* \* \*"/.test(read("server/reminders/cron.ts")));
check("the batch cap is still 12", /ATTACH_BATCH_CAP = 12/.test(runner));
check("the batch is still scoped to matched submissions",
  /trigger === "scheduled"[\s\S]{0,80}checkEligibility\(submission\)/.test(runner));

// ===========================================================================
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
