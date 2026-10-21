/**
 * "Show on survey" (2026-10-21): a provider with the flag off is absent from
 * the survey dropdown, the snapshot's provider rows and the export's tabs and
 * analysis rows — unless the period has her surveys, which keep their row.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-survey-visibility.ts
 *
 * No database. Provider names are invented; every client is a ZZTEST name.
 */
import * as XLSX from "xlsx";
import { rosterEntriesFromRows } from "../server/survey/roster";
import { aggregateSurveys, type RosterEntry, type SubmissionInput } from "../server/survey/aggregate";
import { buildSurveyWorkbook, type ActiveClientCounts } from "../server/survey/workbook";
import { renderSurveySnapshot } from "../server/survey/snapshot";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// ---------------------------------------------------------------------------
console.log("dropdown (both forms and both languages read this one list)");
const dropdown = rosterEntriesFromRows([
  { name: "Zztest Hidden", credentials: "LCSW", location: "RR", survey_locations: null, show_on_survey: false },
  { name: "Zztest Shown", credentials: "LPCC", location: "ABQ", survey_locations: null, show_on_survey: true },
  { name: "Zztest Twice", credentials: "", location: "LL", survey_locations: ["LL", "ABQ"], show_on_survey: false },
  { name: "Zztest Legacy", credentials: "", location: "LL", survey_locations: null },
  { name: "Zztest Nullflag", credentials: "", location: "LL", survey_locations: null, show_on_survey: null },
]).map((e) => e.label);
eq("hidden providers are not offered, at any office", dropdown,
  ["Zztest Shown (ABQ)", "Zztest Legacy (LL)", "Zztest Nullflag (LL)"]);

// ---------------------------------------------------------------------------
const roster: RosterEntry[] = [
  { id: 1, name: "Zztest Hidden", shortName: "Hidden", office: "RR", isActive: true, showOnSurvey: false },
  { id: 2, name: "Zztest Shown", shortName: "Shown", office: "ABQ", isActive: true, showOnSurvey: true },
  { id: 3, name: "Zztest Rio", shortName: "Rio", office: "RR", isActive: true },
  { id: 4, name: "Zztest Twice", shortName: "Twice", office: "LL", surveyLocations: ["LL", "ABQ"], isActive: true, showOnSurvey: false },
];
let nextId = 7001;
function sub(label: string, date: string): SubmissionInput {
  const answers: Record<string, unknown> = { therapist: label, overallRating: 9, connectionRating: 8 };
  return {
    id: nextId++,
    submittedAt: `${date}T15:00:00.000Z`,
    createdAt: `${date}T15:00:00.000Z`,
    payload: { formVariant: "in-person", modality: "In Person", language: "en", client: { name: `ZZTEST ${nextId}` }, answers },
  };
}
const subs = [
  sub("Zztest Hidden (RR)", "2026-10-02"),
  sub("Zztest Shown (ABQ)", "2026-10-05"),
  sub("Zztest Shown (ABQ)", "2026-11-05"),
  sub("Zztest Twice (LL)", "2026-10-07"),
];
const counts: ActiveClientCounts = {
  byProviderId: { 1: { count: 12, capturedOn: "2026-10-01" }, 2: { count: 10, capturedOn: "2026-10-01" }, 3: { count: 7, capturedOn: "2026-10-01" }, 4: { count: 5, capturedOn: "2026-10-01" } },
  newestCapturedOn: "2026-10-01",
};

function surfaces(from: string, to: string) {
  const agg = aggregateSurveys({ roster, submissions: subs, period: { from, to } });
  const snap = renderSurveySnapshot({ from, to }, { aggregate: agg, activeCounts: counts, overrideCount: 0 }, null);
  const { buffer, sheetNames } = buildSurveyWorkbook(agg, counts);
  const wb = XLSX.read(buffer, { type: "buffer" });
  const analysis = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[1]], { header: 1 })
    .map((r) => String((r as unknown[])[0] ?? ""));
  return { agg, snap, sheetNames, analysis };
}

// ---------------------------------------------------------------------------
console.log("\na period with none of her surveys (November)");
{
  const { agg, snap, sheetNames, analysis } = surfaces("2026-11-01", "2026-11-30");
  eq("aggregate: hidden providers have no row", agg.providers.map((p) => p.name), ["Zztest Rio", "Zztest Shown"]);
  ok("snapshot: no provider row for them", !snap.providers.some((r) => r.providerId === 1 || r.providerId === 4),
    JSON.stringify(snap.providers.map((r) => r.providerId)));
  ok("export: no tab for them", !sheetNames.includes("Hidden") && !sheetNames.some((n) => n.startsWith("Twice")), JSON.stringify(sheetNames));
  ok("export: no analysis row for them", !analysis.includes("Hidden") && !analysis.some((a) => a.startsWith("Twice")), JSON.stringify(analysis));
  ok("export: shown providers keep their empty tab", sheetNames.includes("Rio") && sheetNames.includes("Shown"));
  ok("snapshot: the RR office total no longer waits on her count",
    snap.offices.find((o) => o.office === "RR")?.activeClients === 7, JSON.stringify(snap.offices));
}

// ---------------------------------------------------------------------------
console.log("\na period that already has her surveys (October)");
{
  const { agg, snap, sheetNames, analysis } = surfaces("2026-10-01", "2026-10-31");
  const hidden = agg.providers.find((p) => p.providerId === 1);
  ok("aggregate: her row survives, active, with her survey", !!hidden && hidden.isActive && hidden.surveyCount === 1, JSON.stringify(hidden));
  eq("aggregate: she is not reported as departed", agg.departed.length, 0);
  eq("aggregate: only the office with surveys survives for a two-office provider",
    agg.providers.filter((p) => p.providerId === 4).map((p) => [p.office, p.surveyCount]), [["LL", 1]]);
  const row = snap.providers.find((r) => r.providerId === 1);
  ok("snapshot: her row, 1 survey, her active count", !!row && row.surveys === 1 && row.activeClients === 12, JSON.stringify(row));
  ok("export: her tab", sheetNames.includes("Hidden"), JSON.stringify(sheetNames));
  ok("export: her analysis row", analysis.includes("Hidden"), JSON.stringify(analysis));
  eq("every survey still counted", agg.submissionsInPeriod, 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(`FAILED: ${failures.join("; ")}`); process.exit(1); }
