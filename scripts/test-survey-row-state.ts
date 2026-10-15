/**
 * Submissions: the survey row's state chip (2026-10-15).
 *
 * Run: npx tsx scripts/test-survey-row-state.ts
 *
 * Fixture match / attach states only — no database, no identity.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { FILES_TONIGHT_TEXT, filedDate, surveyRowState, type RowAttach, type RowMatch } from "../shared/survey-row-state";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const matched: RowMatch = { status: "matched", reason: "name_dob_phone" };
const review: RowMatch = { status: "review", reason: "dob_mismatch" };
const noContact: RowMatch = { status: "no_contact", reason: "no_candidates" };
const nightly: RowAttach = { status: "attached", trigger: "scheduled", startedAt: "2026-10-15T09:30:40Z", finishedAt: "2026-10-15T09:31:15Z" };
const byStaff: RowAttach = { status: "attached", trigger: "manual", startedAt: "2026-10-15T04:00:34Z", finishedAt: "2026-10-15T04:01:10Z" };
const failed: RowAttach = { status: "failed", trigger: "scheduled", startedAt: "2026-10-14T09:31:00Z", finishedAt: "2026-10-14T09:31:30Z" };
const running: RowAttach = { status: "running", trigger: "manual", startedAt: "2026-10-15T15:00:00Z", finishedAt: null };

console.log("\n[1] The three states");
eq("matched, not filed", surveyRowState(matched, undefined), { kind: "files_tonight", text: "Matched · files tonight 3:30 MT" });
eq("filed by the nightly batch", surveyRowState(matched, nightly), { kind: "filed", text: "Filed to chart Oct 15" });
eq("filed by a staff member", surveyRowState(matched, byStaff), { kind: "filed", text: "Filed to chart Oct 14 (staff)" });
eq("in review, with its short reason", surveyRowState(review, undefined), { kind: "needs_review", text: "Needs review: Date of birth did not match" });
eq("an attach refusal sent to review", surveyRowState({ status: "review", reason: "attach_phone_mismatch" }, failed),
  { kind: "needs_review", text: "Needs review: Chart phone differs" });
eq("a human-resolution sentence is not echoed", surveyRowState({ status: "review", reason: "Staff wrote a sentence" }, undefined),
  { kind: "needs_review", text: "Needs review: see details" });

console.log("\n[2] Precedence and the edges");
eq("filed beats review (filed is final)", surveyRowState(review, nightly)?.kind, "filed");
eq("a failed attach on a matched row still files tonight", surveyRowState(matched, failed)?.text, FILES_TONIGHT_TEXT);
eq("an attach in progress is not 'filed'", surveyRowState(matched, running)?.kind, "files_tonight");
eq("not yet matched keeps its own chip", surveyRowState(undefined, undefined), null);
eq("matched to no contact keeps its own chip", surveyRowState(noContact, undefined), null);
eq("the date is the Mountain-time day (04:01Z Oct 15 = Oct 14 MT)", filedDate("2026-10-15T04:01:10Z"), "Oct 14");
// /api/survey/attach/states sends Date.toString() text, not ISO (prod runs in UTC).
eq("the API's Date.toString() form parses (UTC server)",
  filedDate("Thu Oct 15 2026 09:31:15 GMT+0000 (Coordinated Universal Time)"), "Oct 15");
eq("…and from a server in another zone", filedDate("Wed Oct 14 2026 21:01:10 GMT-0700 (Pacific Daylight Time)"), "Oct 14");
eq("an unreadable date drops the date, not the state", surveyRowState(matched, { ...nightly, finishedAt: "x", startedAt: "y" })?.text, "Filed to chart");

console.log("\n[3] Wired; filters and counts unchanged");
const page = read("client", "src", "pages", "submissions.tsx");
ok("rows render SurveyStateBadge with the row's match and attach state",
  /<SurveyStateBadge\s+id=\{sub\.id\}\s+state=\{stateFor\(sub\.id\)\}\s+attach=\{attachFor\(sub\.id\)\}/.test(page));
ok("the bare 'Matched' chip is gone", !/"Matched \(confirmed\)" : "Matched"/.test(page));
ok("the filter predicate is unchanged", page.includes(`if (matchFilter === "review") return !st || st.status === "review";`));
ok("the filter labels and counts are unchanged",
  page.includes(`["review", "Needs review", reviewCount],`) && page.includes(`["matched", "Matched", counts.matched],`));

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
