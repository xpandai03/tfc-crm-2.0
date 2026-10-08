/**
 * Survey offices: a provider at two offices (Amanda P, ABQ and LL) and the new
 * Corp office (Sandra, Amanda D) — the dropdown, the aggregate, the workbook,
 * the snapshot and the TherapyNotes clinician mapping.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-survey-locations.ts
 *
 * No database. Provider names are staff names (real on purpose, since the
 * short names and the TN mapping are what is being checked); every client is
 * invented.
 */
import { unzipSync, strFromU8 } from "fflate";
import {
  SURVEY_OFFICE_ORDER,
  officeFromLabel,
  primarySurveyOffice,
  surveyOfficesFor,
} from "../shared/survey-locations";
import { rosterEntriesFromRows } from "../server/survey/roster";
import { aggregateSurveys, type RosterEntry, type SubmissionInput } from "../server/survey/aggregate";
import { buildSurveyWorkbook, type ActiveClientCounts } from "../server/survey/workbook";
import { renderSurveySnapshot } from "../server/survey/snapshot";
import { surveyTherapistToTnClinician } from "../server/providers/tn-clinician-name";
import { corpOnlyLabel, isCorpOnly, type CorpRuleProviderRow } from "../server/survey/corp-labels";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// ---------------------------------------------------------------------------
console.log("\nshared helpers");
eq("office order is the template's: Corp first", SURVEY_OFFICE_ORDER, ["CORP", "ABQ", "LL", "RR"]);
eq("no survey_locations → the location", surveyOfficesFor("RR", null), ["RR"]);
eq("empty survey_locations → the location", surveyOfficesFor("RR", []), ["RR"]);
eq("survey_locations win, in stored order, deduped, uppercased", surveyOfficesFor("LL", ["ll", "ABQ", "LL"]), ["LL", "ABQ"]);
eq("unknown codes in survey_locations are ignored", surveyOfficesFor("ABQ", ["XYZ"]), ["ABQ"]);
eq("primary = the location when it is a survey office", primarySurveyOffice("LL", ["ABQ", "LL"]), "LL");
eq("primary = first survey office when the location is not one", primarySurveyOffice("ABQ", ["CORP"]), "CORP");
eq("label office", officeFromLabel("Amanda Plotner (ABQ)"), "ABQ");
eq("label office: Corp in any case", officeFromLabel("Sandra Rivera (Corp)"), "CORP");
eq("label with no office", officeFromLabel("Sandra Rivera"), null);
eq("label with an unknown code", officeFromLabel("Someone (ZZ)"), null);

// ---------------------------------------------------------------------------
console.log("\nsurvey dropdown");
const dropdown = rosterEntriesFromRows([
  { name: "Amanda Davison", credentials: "LMFT", location: "ABQ", survey_locations: ["CORP"] },
  { name: "Amanda Plotner", credentials: "LPCC", location: "LL", survey_locations: ["LL", "ABQ"] },
  { name: "Jill Example", credentials: "", location: "LL", survey_locations: null },
  { name: "Sandra Rivera", credentials: "LMFT", location: "ABQ", survey_locations: ["CORP"] },
]).map((e) => e.label);
eq("Amanda Plotner is offered twice, ABQ then LL", dropdown.filter((l) => l.startsWith("Amanda Plotner")),
  ["Amanda Plotner (ABQ)", "Amanda Plotner (LL)"]);
ok("Sandra and Amanda D are offered under Corp, not ABQ",
  dropdown.includes("Sandra Rivera (CORP)") && dropdown.includes("Amanda Davison (CORP)") &&
  !dropdown.includes("Sandra Rivera (ABQ)") && !dropdown.includes("Amanda Davison (ABQ)"));
ok("a provider without survey_locations is unchanged", dropdown.includes("Jill Example (LL)"));
eq("one entry per provider office", dropdown.length, 5);
eq("labels are unique (the picker keys on them)", new Set(dropdown).size, dropdown.length);

// ---------------------------------------------------------------------------
console.log("\nTherapyNotes clinician mapping");
eq("both Plotner labels map to one TN clinician",
  surveyTherapistToTnClinician("Amanda Plotner (ABQ)"), surveyTherapistToTnClinician("Amanda Plotner (LL)"));
eq("…which is her name", surveyTherapistToTnClinician("Amanda Plotner (ABQ)"), "Amanda Plotner");
eq("a Corp label maps to the same clinician as before",
  surveyTherapistToTnClinician("Sandra Rivera (CORP)"), surveyTherapistToTnClinician("Sandra Rivera (ABQ)"));

// ---------------------------------------------------------------------------
console.log("\nCorp-only rule (write time)");
const ruleRows: CorpRuleProviderRow[] = [
  { name: "Amanda Davison", location: "ABQ", survey_locations: ["CORP"], is_active: true },
  { name: "Sandra Rivera", location: "ABQ", survey_locations: ["CORP"], is_active: true },
  { name: "Amanda Plotner", location: "LL", survey_locations: ["LL", "ABQ"], is_active: true },
  { name: "Kennedy Example", location: "ABQ", survey_locations: null, is_active: true },
  { name: "Ginger Twice", location: "ABQ", survey_locations: ["CORP"], is_active: true },
  { name: "Ginger Twice", location: "ABQ", survey_locations: null, is_active: false },
  { name: "Pat Twin", location: "ABQ", survey_locations: ["CORP"], is_active: true },
  { name: "Pat Twin", location: "LL", survey_locations: null, is_active: true },
];
ok("{CORP} is Corp-only", isCorpOnly("ABQ", ["CORP"]));
ok("{CORP, ABQ} is not", !isCorpOnly("ABQ", ["CORP", "ABQ"]));
ok("no survey_locations is not", !isCorpOnly("ABQ", null));
eq("an old (ABQ) entry for Sandra is stored CORP", corpOnlyLabel("Sandra Rivera (ABQ)", ruleRows), "Sandra Rivera (CORP)");
eq("…and for Amanda D", corpOnlyLabel("Amanda Davison (ABQ)", ruleRows), "Amanda Davison (CORP)");
eq("a bare name is stored CORP", corpOnlyLabel("Sandra Rivera", ruleRows), "Sandra Rivera (CORP)");
eq("name case and spacing do not matter; the stored name is the provider's", corpOnlyLabel("  sandra   rivera (abq)", ruleRows), "Sandra Rivera (CORP)");
eq("an unknown office code is stored CORP", corpOnlyLabel("Sandra Rivera (ZZ)", ruleRows), "Sandra Rivera (CORP)");
eq("a CORP label is unchanged", corpOnlyLabel("Sandra Rivera (CORP)", ruleRows), "Sandra Rivera (CORP)");
eq("Plotner (ABQ) stays ABQ", corpOnlyLabel("Amanda Plotner (ABQ)", ruleRows), "Amanda Plotner (ABQ)");
eq("Plotner (LL) stays LL", corpOnlyLabel("Amanda Plotner (LL)", ruleRows), "Amanda Plotner (LL)");
eq("a provider who did not move is unchanged", corpOnlyLabel("Kennedy Example (ABQ)", ruleRows), "Kennedy Example (ABQ)");
eq("an unknown name is unchanged", corpOnlyLabel("Nobody Here (ABQ)", ruleRows), "Nobody Here (ABQ)");
eq("an empty answer is unchanged", corpOnlyLabel("", ruleRows), "");
eq("an inactive duplicate does not make the active provider ambiguous", corpOnlyLabel("Ginger Twice (ABQ)", ruleRows), "Ginger Twice (CORP)");
eq("two active providers of one name: unchanged", corpOnlyLabel("Pat Twin (ABQ)", ruleRows), "Pat Twin (ABQ)");

// ---------------------------------------------------------------------------
console.log("\naggregate");
const roster: RosterEntry[] = [
  { id: 5, name: "Amanda Davison", shortName: "Amanda D", office: "ABQ", surveyLocations: ["CORP"], isActive: true },
  { id: 23, name: "Sandra Rivera", shortName: "Sandra", office: "ABQ", surveyLocations: ["CORP"], isActive: true },
  { id: 30, name: "Amanda Plotner", shortName: "Amanda P", office: "LL", surveyLocations: ["LL", "ABQ"], isActive: true },
  { id: 40, name: "Kennedy Example", shortName: "Kennedy", office: "ABQ", isActive: true },
  { id: 41, name: "Jill Example", shortName: "Jill", office: "LL", isActive: true },
];
let nextId = 9001;
function sub(label: string, date = "2026-10-03", ratings = [9, 9, 9, 9]): SubmissionInput {
  const answers: Record<string, unknown> = { therapist: label };
  ["facilityClean", "greetedOnArrival", "seenWithinTenMinutes", "privacyRespected", "endedFeelingValued"]
    .forEach((k) => { answers[k] = k === "facilityClean" ? "Excellent" : "Yes"; });
  ["connectionRating", "goalsRating", "approachRating", "overallRating"].forEach((k, i) => { answers[k] = ratings[i]; });
  return {
    id: nextId++,
    submittedAt: `${date}T15:00:00.000Z`,
    createdAt: `${date}T15:00:00.000Z`,
    payload: { formVariant: "in-person", modality: "In Person", language: "en", client: { name: `ZZTEST ${nextId}` }, answers },
  };
}
// Every label as the backfill and the write-time rule leave it: Sandra's
// pre-move "(ABQ)" survey is stored CORP like the rest of hers.
const subs = [
  sub("Amanda Plotner (ABQ)"), sub("Amanda Plotner (ABQ)"), sub("Amanda Plotner (LL)"),
  sub("Sandra Rivera (ABQ)", "2026-09-15"),   // before the move: now Corp too
  sub("Sandra Rivera (CORP)"),
  sub("Amanda Davison (ABQ)", "2026-09-20"),
  sub("Amanda Davison (CORP)"),
  sub("Kennedy Example (ABQ)"), sub("Jill Example (LL)"),
].map((s) => {
  const a = s.payload.answers as Record<string, unknown>;
  return { ...s, payload: { ...s.payload, answers: { ...a, therapist: corpOnlyLabel(String(a.therapist), ruleRows) } } };
});
const agg = aggregateSurveys({ roster, submissions: subs, period: { from: "2026-09-01", to: "2026-10-31" } });
const rows = (name: string) => agg.providers.filter((p) => p.name === name)
  .map((p) => ({ office: p.office, short: p.shortName, n: p.surveyCount, owns: p.ownsActiveCount }));

eq("Plotner: one row per office, ABQ 2 and LL 1, the caseload on LL",
  rows("Amanda Plotner"),
  [{ office: "ABQ", short: "Amanda P (ABQ)", n: 2, owns: false }, { office: "LL", short: "Amanda P (LL)", n: 1, owns: true }]);
eq("Sandra: one row, Corp, both surveys (the pre-move one included)",
  rows("Sandra Rivera"), [{ office: "CORP", short: "Sandra", n: 2, owns: true }]);
eq("Amanda D: one row, Corp, both surveys", rows("Amanda Davison"), [{ office: "CORP", short: "Amanda D", n: 2, owns: true }]);
ok("no ABQ row for either", !agg.providers.some((p) => ["Sandra Rivera", "Amanda Davison"].includes(p.name) && p.office !== "CORP"));
eq("their Data rows all say CORP",
  agg.dataRows.filter((r) => ["Sandra Rivera", "Amanda Davison"].includes(r.provider)).map((r) => r.office), ["CORP", "CORP", "CORP", "CORP"]);
eq("a provider who did not move is untouched", rows("Kennedy Example"), [{ office: "ABQ", short: "Kennedy", n: 1, owns: true }]);
eq("Corp is its own office, listed first", agg.offices, ["CORP", "ABQ", "LL"]);
eq("nothing unresolved", agg.unresolved.length, 0);
eq("Data rows carry the stored office", agg.dataRows.filter((r) => r.provider === "Amanda Plotner").map((r) => r.office), ["ABQ", "ABQ", "LL"]);

// ---------------------------------------------------------------------------
console.log("\nworkbook");
const counts: ActiveClientCounts = {
  byProviderId: {
    5: { count: 6, capturedOn: "2026-10-01" }, 23: { count: 8, capturedOn: "2026-10-01" },
    30: { count: 20, capturedOn: "2026-10-01" }, 40: { count: 9, capturedOn: "2026-10-01" },
    41: { count: 9, capturedOn: "2026-10-01" },
  },
  newestCapturedOn: "2026-10-01",
};
const { buffer, sheetNames } = buildSurveyWorkbook(agg, counts);
ok("Plotner has a tab per office", sheetNames.includes("Amanda P (ABQ)") && sheetNames.includes("Amanda P (LL)"));
ok("Sandra and Amanda D have one tab each", sheetNames.includes("Sandra") && sheetNames.includes("Amanda D"));
ok("…and no ABQ tab", !sheetNames.some((n) => /^(Sandra|Amanda D) \(/.test(n)), JSON.stringify(sheetNames));
const firstProviderTab = sheetNames[4];
eq("provider tabs start with the Corp office, as the template does", ["Amanda D", "Sandra"].includes(firstProviderTab), true);

const zip = unzipSync(new Uint8Array(buffer));
const shared = (() => {
  const xml = zip["xl/sharedStrings.xml"] ? strFromU8(zip["xl/sharedStrings.xml"]) : "";
  return (xml.match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) => (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join(""));
})();
const analysisXml = strFromU8(zip["xl/worksheets/sheet2.xml"]);
type Cell = { v: string; t: string | null; f: string | null };
const cells: Record<string, Cell> = {};
for (const m of analysisXml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
  const t = /t="([^"]+)"/.exec(m[2])?.[1] ?? null;
  const v = /<v>([\s\S]*?)<\/v>/.exec(m[3] ?? "")?.[1] ?? "";
  const f = /<f>([\s\S]*?)<\/f>/.exec(m[3] ?? "")?.[1] ?? null;
  cells[m[1]] = { v: t === "s" ? shared[Number(v)] : v, t, f };
}
const rowOf = (short: string) => Object.keys(cells).find((k) => /^A\d+$/.test(k) && cells[k].v === short)?.slice(1);
const pAbq = rowOf("Amanda P (ABQ)"), pLl = rowOf("Amanda P (LL)");
ok("Plotner's two rows are on the analysis sheet", !!pAbq && !!pLl);
eq("LL row carries her 20 active clients", cells[`C${pLl}`]?.v, "20");
eq("ABQ row carries none, so the caseload is not counted twice", cells[`C${pAbq}`], undefined);
eq("…and her rows sit under their own offices", [cells[`B${pAbq}`]?.v, cells[`B${pLl}`]?.v], ["ABQ", "LL"]);
const corpRows = ["Amanda D", "Sandra"].map(rowOf).map(Number);
eq("one analysis row each for Sandra and Amanda D, under CORP", corpRows.map((r) => cells[`B${r}`]?.v), ["CORP", "CORP"]);
ok("no other analysis row for them", !Object.keys(cells).some((k) => /^A\d+$/.test(k) && /^(Sandra|Amanda D) \(/.test(cells[k].v)));
const abqRow = Number(rowOf("Kennedy"));
ok("Corp rows come before ABQ rows on the analysis sheet", corpRows.every((r) => r < abqRow), JSON.stringify({ corpRows, abqRow }));
const comments = Object.keys(zip).filter((k) => /comments\d*\.xml$/.test(k)).map((k) => strFromU8(zip[k])).join("");
ok("the ABQ row says where her clients are counted", comments.includes("counted on the LL row"));

// The office rollup must still total ABQ: Plotner's ABQ row does not need a count.
const rollupTotals = Object.keys(cells).filter((k) => /^[L-P]\d+$/.test(k)).map((k) => cells[k]);
ok("the ABQ office total is written, not withheld", Object.values(cells).some((c) => c.f !== null && /SUM\(C/.test(c.f)), JSON.stringify(rollupTotals.slice(0, 3)));

// ---------------------------------------------------------------------------
console.log("\nsnapshot");
const snap = renderSurveySnapshot(
  { from: "2026-09-01", to: "2026-10-31" },
  { aggregate: agg, activeCounts: counts, overrideCount: 0 },
  null,
);
const snapRow = (short: string) => snap.providers.find((p) => p.shortName === short);
eq("Plotner split: ABQ 2 surveys, no count, counted at LL",
  [snapRow("Amanda P (ABQ)")?.surveys, snapRow("Amanda P (ABQ)")?.activeClients, snapRow("Amanda P (ABQ)")?.countedAt], [2, null, "LL"]);
eq("Plotner split: LL 1 survey, 20 clients", [snapRow("Amanda P (LL)")?.surveys, snapRow("Amanda P (LL)")?.activeClients], [1, 20]);
const office = (o: string) => snap.offices.find((x) => x.office === o);
eq("offices in template order", snap.offices.map((o) => o.office), ["CORP", "ABQ", "LL"]);
eq("snapshot: one row each for Sandra and Amanda D, CORP",
  snap.providers.filter((p) => ["Sandra Rivera", "Amanda Davison"].includes(p.name)).map((p) => [p.shortName, p.office, p.surveys]),
  [["Amanda D", "CORP", 2], ["Sandra", "CORP", 2]]);
eq("Corp: Sandra + Amanda D, 4 surveys, 14 clients", [office("CORP")?.surveys, office("CORP")?.activeClients], [4, 14]);
eq("ABQ total drops their surveys: Plotner 2 + Kennedy 1",
  [office("ABQ")?.missingCounts, office("ABQ")?.activeClients, office("ABQ")?.surveys], [0, 9, 3]);
eq("LL: Plotner 20 + Jill 9", office("LL")?.activeClients, 29);
eq("practice total counts each caseload once", snap.total.activeClients, 6 + 8 + 20 + 9 + 9);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exit(1); }
console.log("PASS");
