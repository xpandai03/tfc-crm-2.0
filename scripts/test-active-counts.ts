/**
 * Self-checks — TherapyNotes active client counts.
 *
 * Run: npx tsx scripts/test-active-counts.ts
 *
 * No database, no network, no PHI. Provider and clinician names are staff names
 * and are the subject; every count is a number.
 */
import { readFileSync } from "fs";
import { unzipSync, strFromU8 } from "fflate";
import { matchClinicianLabel, type MatchableProvider } from "../server/therapy-notes/clinician-match";
import { aggregateSurveys, type RosterEntry, type SubmissionInput } from "../server/survey/aggregate";
import { buildSurveyWorkbook, type ActiveClientCounts } from "../server/survey/workbook";

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

// ===========================================================================
console.log("\n[1] Label → provider reuses the existing mapping, not a second matcher");
{
  const src = read("server/therapy-notes/clinician-match.ts");
  check("it imports the existing TN-name mapping",
    /from\s+"\.\.\/providers\/tn-clinician-name"/.test(src));
  check("...including toTherapyNotesClinicianName", src.indexOf("toTherapyNotesClinicianName") !== -1);
  check("...and the shared tokeniser rather than its own",
    src.indexOf("nameTokens") !== -1 && !/function nameTokens/.test(src));
  check("no correction map is restated here",
    src.indexOf("Ty Jones") === -1 || src.indexOf("PROVIDER_NAME_CORRECTIONS") === -1);
}

// ===========================================================================
console.log("\n[2] Matching — the case that broke scheduling, run backwards");
{
  const roster: MatchableProvider[] = [
    { id: 1, name: "Tyra Jones" },        // CRM display name; TN renders "Ty Jones"
    { id: 2, name: "Anna Aldridge" },
    { id: 3, name: "Amber Lute" },
    { id: 4, name: "Jessica Neuhart" },   // TN renders "Neuhart, Jessica"
  ];
  const m = (label: string, agg = false) => matchClinicianLabel(label, agg, roster);

  eq("TherapyNotes 'Jones, Ty, LMHC' resolves to Tyra Jones",
    [m("Jones, Ty, LMHC").status, m("Jones, Ty, LMHC").providerId], ["matched", 1]);
  eq("a plain 'Ty Jones' resolves too", m("Ty Jones").providerId, 1);
  eq("token order does not matter", m("Aldridge, Anna, LMHC").providerId, 2);
  eq("a reorder-only correction still matches", m("Neuhart, Jessica, Intern").providerId, 4);
  eq("a credential in the label is tolerated", m("Lute, Amber, LAMFT").providerId, 3);

  // The failure the correction map exists to prevent, asserted directly: the
  // CRM's display tokens are NOT a subset of what TherapyNotes renders.
  eq("a label for someone not on the roster matches nobody",
    m("Merritt, Amber, LCSW").status, "unmatched");
  eq("...and is reported as unmatched rather than guessed",
    m("Merritt, Amber, LCSW").providerId, null);
  eq("an empty label matches nobody", m("").status, "unmatched");
}

// ===========================================================================
console.log("\n[3] The aggregate option is never treated as a provider");
{
  const roster: MatchableProvider[] = [{ id: 1, name: "Anna Aldridge" }];
  const agg = matchClinicianLabel("Any Clinician", true, roster);
  eq("'Any Clinician' resolves to the aggregate status", agg.status, "aggregate");
  eq("...and to no provider", agg.providerId, null);
  // Without the flag a short label could subset-match somebody; the flag is what
  // stops the practice-wide total landing on one person's row.
  check("the flag short-circuits before the matcher runs", agg.candidates.length === 0);
}

// ===========================================================================
console.log("\n[4] Two providers matching one label is ambiguous, not a coin toss");
{
  const roster: MatchableProvider[] = [
    { id: 1, name: "Amber Lute" },
    { id: 2, name: "Amber" },   // a single-token name is a subset of both labels
  ];
  const m = matchClinicianLabel("Lute, Amber, LAMFT", false, roster);
  eq("both candidates are found", m.candidates.length, 2);
  eq("the status is ambiguous", m.status, "ambiguous");
  eq("no provider is chosen", m.providerId, null);
}

// ===========================================================================
console.log("\n[5] The schedule and the storage contract");
{
  const cron = read("server/reminders/cron.ts");
  check("the counts cron is registered", cron.indexOf("startActiveCountsCron") !== -1);
  check("with an explicit Mountain timezone",
    /ACTIVE_COUNTS_TIMEZONE = "America\/Denver"/.test(cron));
  check("...passed to cron.schedule, not left to the container's UTC",
    /timezone: ACTIVE_COUNTS_TIMEZONE/.test(cron));
  check("it runs overnight, after the attach batch",
    /DEFAULT_ACTIVE_COUNTS_SCHEDULE = "30 2 \* \* \*"/.test(cron));
  check("an invalid expression refuses to schedule rather than firing wrongly",
    /cron\.validate\(schedule\)[\s\S]{0,300}NOT scheduled/.test(cron));
  check("an overlapping pass is skipped", cron.indexOf("isCountingActive") !== -1);
  check("the next fire time is logged at boot", cron.indexOf("nextFireDescription(schedule, ACTIVE_COUNTS_TIMEZONE)") !== -1);

  const db = read("server/therapy-notes/active-counts-db.ts");
  check("storage is dated, not a mutable column", /captured_on\s+DATE\s+NOT NULL/.test(db));
  check("one row per option per day, so a re-run overwrites",
    /UNIQUE INDEX[\s\S]{0,140}\(captured_on, option_value\)/.test(db));
  check("selection is as-of the period end", /captured_on <= \$1::date/.test(db));
  check("...newest first", /ORDER BY provider_id, captured_on DESC/.test(db));
  check("failures cannot become a denominator",
    /status = 'success'[\s\S]{0,80}active_count IS NOT NULL/.test(db));
  check("no crm_providers column was added for this",
    db.indexOf("ALTER TABLE crm_providers") === -1);
}

// ===========================================================================
console.log("\n[6] Nothing is subtracted, and nothing is dropped");
{
  const db = read("server/therapy-notes/active-counts-db.ts");
  const runner = read("server/therapy-notes/active-counts-runner.ts");
  check("both Test Anna figures are stored",
    db.indexOf("test_anna_exact") !== -1 && db.indexOf("test_anna_token_match") !== -1);
  check("...and neither is subtracted from the count",
    !/active_count\s*-\s*/.test(runner) && !/-\s*testAnna/.test(runner));
  check("failed reads are stored as failures, not skipped",
    /status: r\.status/.test(runner) && /failureReason: r\.failure_reason/.test(runner));
  check("unmatched labels are stored with a null provider, not dropped",
    /providerId: m\.providerId/.test(runner) && runner.indexOf("unmatched.push") !== -1);
  check("...and reported in the log", /no CRM provider for/.test(runner));
  check("an ambiguous label is reported by candidate name", /AMBIGUOUS, stored without a provider/.test(runner));
  check("a pass that returns nothing still writes an activity entry",
    /outcome: "failed"/.test(runner) && /type: "tn_active_counts"/.test(runner));
}

// ===========================================================================
// Workbook behaviour
// ===========================================================================
function openWb(buffer: Buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const sheets: Record<string, string> = {};
  const wbXml = strFromU8(zip["xl/workbook.xml"]);
  const names = Array.from(wbXml.matchAll(/<sheet[^>]*name="([^"]*)"/g)).map((m) => m[1]);
  Object.keys(zip).filter((k) => k.startsWith("xl/worksheets/sheet")).forEach((k) => {
    sheets[k] = strFromU8(zip[k]);
  });
  const all = Object.keys(sheets).map((k) => sheets[k]).join("");
  return { names, sheet2: sheets["xl/worksheets/sheet2.xml"], all };
}
function cellOf(xml: string, ref: string): string | null {
  const m = new RegExp(`<c r="${ref}"[^>]*>((?:(?!</c>).)*)</c>`, "s").exec(xml);
  return m ? m[1] : null;
}
const PERIOD = { from: "2026-07-01", to: "2026-09-30" };
function build(counts: ActiveClientCounts) {
  const roster: RosterEntry[] = [
    { id: 1, name: "Anna Aldridge", shortName: "Anna", office: "ABQ", isActive: true },
    { id: 2, name: "Jill Nantze", shortName: "Jill", office: "LL", isActive: true },
  ];
  const sub = (label: string): SubmissionInput => ({
    id: Math.floor(Math.random() * 1e9), submittedAt: "2026-08-01T12:00:00.000Z",
    createdAt: "2026-08-01T12:00:00.000Z",
    payload: {
      formVariant: "in-person", modality: "In Person", client: { name: "Someone" },
      answers: {
        therapist: label, facilityClean: "Excellent", greetedOnArrival: "Yes",
        seenWithinTenMinutes: "Yes", privacyRespected: "Yes", endedFeelingValued: "Yes",
        connectionRating: 8, goalsRating: 8, approachRating: 8, overallRating: 8,
      },
    },
  });
  const a = aggregateSurveys({
    roster, submissions: [sub("Anna Aldridge (ABQ)"), sub("Jill Nantze (LL)")], period: PERIOD,
  });
  return buildSurveyWorkbook(a, counts);
}

console.log("\n[7] With a count: the number AND the formula. Without: neither.");
{
  const withCounts = build({
    byProviderId: { 1: { count: 40, capturedOn: "2026-09-28" } },
    newestCapturedOn: "2026-09-28",
  });
  const wb = openWb(withCounts.buffer);
  check("Anna's denominator is written", (cellOf(wb.sheet2, "C2") ?? "").indexOf("<v>40</v>") !== -1);
  check("...and her percentage formula with it",
    (cellOf(wb.sheet2, "E2") ?? "").indexOf("<f>D2/C2</f>") !== -1);
  check("Jill has no count, so no denominator", cellOf(wb.sheet2, "C3") === null);
  check("...and NO formula beside it", cellOf(wb.sheet2, "E3") === null);
  // Anna has a count and Jill does not, so the practice total is INCOMPLETE.
  // Dividing all the surveys by only Anna's clients would inflate the headline
  // number, so it is withheld rather than shown wrong.
  check("the practice total is withheld while one denominator is missing",
    cellOf(wb.sheet2, "E4") === null && cellOf(wb.sheet2, "C4") === null);
  check("...but the survey total is still summed", (cellOf(wb.sheet2, "D4") ?? "").indexOf("<f>SUM(D2:D3)</f>") !== -1);
  check("...and Anna's own office rollup, which IS complete, divides",
    /<f>N\d+\/M\d+<\/f>/.test(wb.all));

  // Everyone counted: the totals appear.
  const complete = openWb(build({
    byProviderId: { 1: { count: 40, capturedOn: "2026-09-28" }, 2: { count: 10, capturedOn: "2026-09-28" } },
    newestCapturedOn: "2026-09-28",
  }).buffer);
  check("with every denominator present the practice total divides",
    (cellOf(complete.sheet2, "E4") ?? "").indexOf("<f>D4/C4</f>") !== -1);
  check("...and sums the denominators", (cellOf(complete.sheet2, "C4") ?? "").indexOf("<f>SUM(C2:C3)</f>") !== -1);

  const none = build({ byProviderId: {}, newestCapturedOn: null });
  const wb2 = openWb(none.buffer);
  check("with no counts at all, column C is empty", cellOf(wb2.sheet2, "C2") === null);
  check("...and no percentage formula exists anywhere",
    !/<f>D\d+\/C\d+<\/f>/.test(wb2.all));
  check("...nor on the rollup", !/<f>N\d+\/M\d+<\/f>/.test(wb2.all));
}

console.log("\n[8] No division error is possible in a generated workbook");
{
  [
    build({ byProviderId: {}, newestCapturedOn: null }),
    build({ byProviderId: { 1: { count: 40, capturedOn: "2026-09-28" } }, newestCapturedOn: "2026-09-28" }),
    build({ byProviderId: { 1: { count: 40, capturedOn: "2026-09-28" }, 2: { count: 12, capturedOn: "2026-09-28" } }, newestCapturedOn: "2026-09-28" }),
  ].forEach((r, i) => {
    const wb = openWb(r.buffer);
    const divisions = Array.from(wb.all.matchAll(/<f>([^<]*\/[^<]*)<\/f>/g)).map((m) => m[1]);
    // Every division that exists must point at a cell that HOLDS a number.
    const bad = divisions.filter((f) => {
      const denom = f.split("/")[1];
      const sheetHasIt = wb.all.indexOf(`<c r="${denom}"`) !== -1;
      return !sheetHasIt;
    });
    eq(`case ${i + 1}: every division has a written denominator`, bad, []);
    check(`case ${i + 1}: no DIV/0 literal`, wb.all.indexOf("DIV/0") === -1);
  });
}

console.log("\n[9] The count is never shown without its age");
{
  const fresh = openWb(build({
    byProviderId: { 1: { count: 40, capturedOn: "2026-09-28" } }, newestCapturedOn: "2026-09-28",
  }).buffer);
  check("a fresh reading prints its date", fresh.all.indexOf("2026-09-28") !== -1);
  check("...and how far before the period end it was taken", /2 days before this period ended/.test(fresh.all));
  check("...without the approximate warning", fresh.all.indexOf("treated as approximate") === -1);

  const stale = openWb(build({
    byProviderId: { 1: { count: 40, capturedOn: "2026-07-15" } }, newestCapturedOn: "2026-07-15",
  }).buffer);
  check("a stale reading still shows the number", (cellOf(stale.sheet2, "C2") ?? "").indexOf("<v>40</v>") !== -1);
  check("...prints its age", /77 days before this period ended/.test(stale.all));
  check("...and says the percentages are approximate", stale.all.indexOf("treated as approximate") !== -1);

  const none = openWb(build({ byProviderId: {}, newestCapturedOn: null }).buffer);
  check("with none, the sheet says why rather than going quiet",
    none.all.indexOf("Not available for this period") !== -1);
}

console.log("\n[10] Provider tabs follow the same both-or-neither rule");
{
  const wbFile = build({
    byProviderId: { 1: { count: 40, capturedOn: "2026-09-28" } }, newestCapturedOn: "2026-09-28",
  });
  const zip = unzipSync(new Uint8Array(wbFile.buffer));
  const idx = wbFile.sheetNames.indexOf("Anna") + 1;
  const jdx = wbFile.sheetNames.indexOf("Jill") + 1;
  const anna = strFromU8(zip[`xl/worksheets/sheet${idx}.xml`]);
  const jill = strFromU8(zip[`xl/worksheets/sheet${jdx}.xml`]);
  check("Anna's tab carries the denominator", (cellOf(anna, "C4") ?? "").indexOf("<v>40</v>") !== -1);
  check("...and the percentage formula", (cellOf(anna, "D3") ?? "").indexOf("<f>C3/C4</f>") !== -1);
  check("Jill's tab carries neither", cellOf(jill, "C4") === null && cellOf(jill, "D3") === null);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
