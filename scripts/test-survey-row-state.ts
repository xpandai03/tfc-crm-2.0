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
eq("matched, not filed", surveyRowState(matched, undefined), { kind: "files_tonight", text: "Matched to CRM contact · files to TherapyNotes tonight 3:30 AM MT" });
eq("filed by the nightly batch", surveyRowState(matched, nightly), { kind: "filed", text: "Filed to TherapyNotes Oct 15" });
eq("filed by a staff member", surveyRowState(matched, byStaff), { kind: "filed", text: "Filed to TherapyNotes Oct 14 (staff)" });
eq("in review, with its short reason", surveyRowState(review, undefined), { kind: "needs_review", text: "Needs review: Date of birth did not match" });
eq("an attach refusal sent to review", surveyRowState({ status: "review", reason: "attach_phone_mismatch" }, failed),
  { kind: "needs_review", text: "Needs review: phone differs from TherapyNotes chart" });
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
eq("an unreadable date drops the date, not the state", surveyRowState(matched, { ...nightly, finishedAt: "x", startedAt: "y" })?.text, "Filed to TherapyNotes");

console.log("\n[2b] Review reasons name the system (client copy, 2026-10-15)");
const rv = (reason: string) => surveyRowState({ status: "review", reason }, undefined)?.text;
eq("no contact", rv("no_candidates"), "Needs review: no contact with this name in CRM");
eq("email points elsewhere", rv("email_contradiction"), "Needs review: email matches a different CRM contact");
eq("chart phone differs", rv("attach_phone_mismatch"), "Needs review: phone differs from TherapyNotes chart");
eq("clinician mismatch", rv("attach_clinician_mismatch"), "Needs review: therapist doesn't match TherapyNotes chart");
eq("several TherapyNotes charts (the agent's multiple_candidates)", rv("attach_multiple_charts"), "Needs review: more than one possible TherapyNotes chart");
eq("three strikes, not found", rv("attach_repeated_patient_not_found"), "Needs review: not found in TherapyNotes 3 nights in a row");
eq("DOB implausible", rv("attach_dob_implausible"), "Needs review: year of birth looks wrong");
eq("any other reason keeps its existing text", rv("dob_mismatch"), "Needs review: Date of birth did not match");
eq("…including the matcher's several-CRM-contacts reasons (not TherapyNotes charts)",
  [rv("multiple_candidates"), rv("provider_ambiguous")],
  ["Needs review: Several matches, no therapist given", "Needs review: Several matches, therapist matched more than one"]);
const attachText = read("shared", "survey-attach-reasons.ts");
ok("the red phone-mismatch line, exactly",
  attachText.includes("`The phone number on the survey doesn't match the mobile number on the ` +\n    `TherapyNotes chart. If the client gave a home number this is expected. ` +\n    `${FALL_BACK}`"));

console.log("\n[3] Wired; filters and counts unchanged");
const page = read("client", "src", "pages", "submissions.tsx");
ok("rows render SurveyStateBadge with the row's match and attach state",
  /<SurveyStateBadge\s+id=\{sub\.id\}\s+state=\{stateFor\(sub\.id\)\}\s+attach=\{attachFor\(sub\.id\)\}/.test(page));
ok("the bare 'Matched' chip is gone", !/"Matched \(confirmed\)" : "Matched"/.test(page));
ok("the filter predicate is unchanged", page.includes(`if (matchFilter === "review") return !st || st.status === "review";`));
ok("the filter labels name the system; their counts are unchanged",
  page.includes(`["review", "Needs review", reviewCount],`) && page.includes(`["matched", "Matched (CRM)", counts.matched],`) &&
  page.includes(`["no_contact", "No CRM contact", counts.no_contact],`));
ok("the row header wraps its badges instead of truncating the client's name",
  page.includes(`<div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">`));
ok("buttons: File to TherapyNotes / Review match / Change CRM contact",
  page.includes("File to TherapyNotes") && page.includes(`? "Review match"`) && page.includes(`: "Change CRM contact"`) &&
  !/File to chart|Review identity|"Change match"/.test(page));

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
