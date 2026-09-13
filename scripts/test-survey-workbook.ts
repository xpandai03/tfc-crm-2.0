/**
 * Self-checks — survey export workbook builder.
 *
 * Run: npx tsx scripts/test-survey-workbook.ts
 * Add --write <path> to also emit a workbook for opening by hand.
 *
 * No database and no PHI. Client names are invented here; provider names are
 * staff names and are the subject.
 *
 * THE FORMULA EVALUATOR IS THE POINT. The builder writes formulas without
 * cached values, so nothing in the file says what they come to. evaluate()
 * below reads the emitted workbook back, resolves each formula's range against
 * the value cells, and computes it — then every expectation is compared against
 * a number worked out independently from the aggregate. A range that silently
 * covered the wrong rows would pass a "did we write a formula" check and fail
 * this one.
 */
import { unzipSync, strFromU8 } from "fflate";
import { writeFileSync } from "fs";
import { aggregateSurveys, type RosterEntry, type SubmissionInput } from "../server/survey/aggregate";
import { buildSurveyWorkbook, sheetNameFor } from "../server/survey/workbook";

// ===========================================================================
// Reading the emitted file
//
// NOT VIA XLSX.read. SheetJS's reader DROPS any cell that carries a formula but
// no cached value — and this builder deliberately writes formulas without one,
// so Excel recalculates on open. Verified: a written `<c r="B1"><f>SUM(A1:A2)
// </f></c>` reads back as `undefined`. The file is correct; the reader cannot
// see it. So these checks parse the OOXML directly, which is what Excel does.
// fflate is already a dependency (server/dashboard/xlsx-images.ts uses it).
// ===========================================================================

interface ParsedCell { v?: number | string; f?: string }
type Cells = Record<string, ParsedCell>;
interface Parsed { names: string[]; sheets: Record<string, Cells>; dims: Record<string, string> }

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#([0-9]+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&");
}

function openWorkbook(buffer: Buffer): Parsed {
  const zip = unzipSync(new Uint8Array(buffer));
  const wbXml = strFromU8(zip["xl/workbook.xml"]);
  const relsXml = strFromU8(zip["xl/_rels/workbook.xml.rels"]);
  const rels: Record<string, string> = {};
  const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(relsXml))) rels[rm[1]] = rm[2];

  const shared: string[] = [];
  if (zip["xl/sharedStrings.xml"]) {
    const ssXml = strFromU8(zip["xl/sharedStrings.xml"]);
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let sm: RegExpExecArray | null;
    while ((sm = siRe.exec(ssXml))) {
      const parts = sm[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
      shared.push(parts.map((t) => decodeXml(t.replace(/<[^>]+>/g, ""))).join(""));
    }
  }

  const names: string[] = [];
  const sheets: Record<string, Cells> = {};
  const dims: Record<string, string> = {};
  const shRe = /<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g;
  let hm: RegExpExecArray | null;
  while ((hm = shRe.exec(wbXml))) {
    const name = decodeXml(hm[1]);
    names.push(name);
    const target = rels[hm[2]].replace(/^\//, "");
    const path = target.startsWith("xl/") ? target : `xl/${target}`;
    const xml = strFromU8(zip[path]);
    const dim = /<dimension ref="([^"]+)"/.exec(xml);
    dims[name] = dim ? dim[1] : "";
    const cells: Cells = {};
    const cRe = /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cRe.exec(xml))) {
      const ref = cm[1], attrs = cm[2], body = cm[3] ?? "";
      const cell: ParsedCell = {};
      const fm = /<f[^>]*>([\s\S]*?)<\/f>/.exec(body);
      if (fm) cell.f = decodeXml(fm[1]);
      const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (vm) {
        const raw = decodeXml(vm[1]);
        const t = /t="([^"]+)"/.exec(attrs)?.[1];
        if (t === "s") cell.v = shared[parseInt(raw, 10)];
        else if (t === "str" || t === "inlineStr") cell.v = raw;
        else cell.v = parseFloat(raw);
      }
      const im = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
      if (im) cell.v = decodeXml(im[1]);
      if (cell.v !== undefined || cell.f !== undefined) cells[ref] = cell;
    }
    sheets[name] = cells;
  }
  return { names, sheets, dims };
}

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ===========================================================================
// A minimal formula evaluator over the emitted sheet
// ===========================================================================

function colIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}
function parseRef(ref: string): { c: number; r: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad ref ${ref}`);
  return { c: colIndex(m[1]), r: parseInt(m[2], 10) - 1 };
}
function addr(c: number, r: number): string {
  let s = "", x = c;
  do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return `${s}${r + 1}`;
}
function rangeCells(a: string, b: string): string[] {
  const s = parseRef(a), e = parseRef(b);
  const out: string[] = [];
  for (let r = s.r; r <= e.r; r++) for (let c = s.c; c <= e.c; c++) out.push(addr(c, r));
  return out;
}
/** Numeric value of a cell, or null when blank. Formula cells are resolved. */
function valueOf(ws: Cells, ref: string): number | null {
  const cell = ws[ref];
  if (!cell) return null;
  if (cell.f) return evaluate(ws, ref);
  return typeof cell.v === "number" ? cell.v : null;
}
/** Supports the only three shapes the builder emits. */
function evaluate(ws: Cells, ref: string): number | null {
  const cell = ws[ref];
  if (!cell || !cell.f) return null;
  const f = cell.f;
  let m = /^(SUM|AVERAGE)\(([A-Z]+\d+):([A-Z]+\d+)\)$/.exec(f);
  if (m) {
    const vals = rangeCells(m[2], m[3])
      .map((a) => valueOf(ws, a))
      .filter((v): v is number => v !== null);
    if (m[1] === "SUM") return vals.reduce((t, v) => t + v, 0);
    return vals.length === 0 ? null : vals.reduce((t, v) => t + v, 0) / vals.length;
  }
  m = /^([A-Z]+\d+)$/.exec(f);
  if (m) return valueOf(ws, m[1]);
  throw new Error(`unsupported formula: ${f}`);
}
/** The cells a formula's range covers, for asserting coverage directly. */
function rangeOf(ws: Cells, ref: string): string[] {
  const f = ws[ref]?.f ?? "";
  const m = /^(?:SUM|AVERAGE)\(([A-Z]+\d+):([A-Z]+\d+)\)$/.exec(f);
  return m ? rangeCells(m[1], m[2]) : [];
}

// ===========================================================================
// Fixture builders
// ===========================================================================

const IP = ["facilityClean", "greetedOnArrival", "seenWithinTenMinutes", "privacyRespected", "endedFeelingValued"];
const RK = ["connectionRating", "goalsRating", "approachRating", "overallRating"];

let nextId = 1;
function mkSub(label: string, ratings: number[], opts: {
  date?: string; choices?: string[]; comments?: Record<string, string>; client?: string;
} = {}): SubmissionInput {
  const answers: Record<string, unknown> = { therapist: label };
  const choices = opts.choices ?? ["Excellent", "Yes", "Yes", "Yes", "Yes"];
  IP.forEach((k, i) => { answers[k] = choices[i]; });
  RK.forEach((k, i) => { answers[k] = ratings[i]; });
  const payload: Record<string, unknown> = {
    formVariant: "in-person", modality: "In Person",
    client: { name: opts.client ?? `Client ${nextId}` },
    answers,
  };
  if (opts.comments) payload.comments = opts.comments;
  const date = opts.date ?? "2026-08-01";
  return { id: nextId++, submittedAt: `${date}T12:00:00.000Z`, createdAt: `${date}T12:00:00.000Z`, payload };
}
const PERIOD = { from: "2026-07-01", to: "2026-09-30" };
const agg = (roster: RosterEntry[], submissions: SubmissionInput[]) =>
  aggregateSurveys({ roster, submissions, period: PERIOD });

/** A production-scale roster: 10 ABQ, 8 LL, 8 RR, as the live data carries. */
function productionRoster(): RosterEntry[] {
  const mk = (i: number, office: string): RosterEntry => ({
    id: i, name: `Provider ${String(i).padStart(2, "0")} Surname`,
    shortName: `Prov${String(i).padStart(2, "0")}`, office, isActive: true,
  });
  const out: RosterEntry[] = [];
  let i = 1;
  for (let k = 0; k < 10; k++) out.push(mk(i++, "ABQ"));
  for (let k = 0; k < 8; k++) out.push(mk(i++, "LL"));
  for (let k = 0; k < 8; k++) out.push(mk(i++, "RR"));
  return out;
}

// ===========================================================================
console.log("\n[1] Production scale — 26 providers, every rollup over its own block");
{
  const roster = productionRoster();
  // Give each provider a distinct, predictable rating so a misplaced range
  // shows up as a wrong average rather than a coincidence.
  const subs: SubmissionInput[] = [];
  roster.forEach((p, i) => {
    subs.push(mkSub(`${p.name} (${p.office})`, [i + 1, i + 1, i + 1, i + 1]));
  });
  const a = agg(roster, subs);
  const { buffer, sheetNames } = buildSurveyWorkbook(a);
  const wb = openWorkbook(buffer);
  const ws = wb.sheets["Survey Analysis "];

  eq("30 sheets (4 structural + 26 providers)", sheetNames.length, 30);
  // Rows 2..11 ABQ, 12..19 LL, 20..27 RR, 28 Total — same shape as the
  // template once Corp folds into ABQ.
  const expect: Record<string, [number, number, number]> = {
    // office -> [rollup row, first provider row, last provider row]
    ABQ: [2, 2, 11], LL: [3, 12, 19], RR: [4, 20, 27],
  };
  Object.keys(expect).forEach((office) => {
    const [rr, first, last] = expect[office];
    eq(`${office} rollup row labels the office`, ws[`L${rr}`]?.v, office);
    const covered = rangeOf(ws, `P${rr}`);
    eq(`${office} rating rollup covers exactly its own rows`,
      [covered[0], covered[covered.length - 1], covered.length],
      [`F${first}`, `F${last}`, last - first + 1]);
    const countCovered = rangeOf(ws, `N${rr}`);
    eq(`${office} survey-count rollup covers exactly its own rows`,
      [countCovered[0], countCovered[countCovered.length - 1]], [`D${first}`, `D${last}`]);
  });
  // Independently computed: ABQ holds providers 1..10 scoring 1..10 -> mean 5.5
  eq("ABQ mean evaluates to 5.5", evaluate(ws, "P2"), 5.5);
  // LL holds 11..18 -> mean 14.5 ; RR holds 19..26 -> mean 22.5
  eq("LL mean evaluates to 14.5", evaluate(ws, "P3"), 14.5);
  eq("RR mean evaluates to 22.5", evaluate(ws, "P4"), 22.5);
  eq("the Total row sums all 26 surveys", evaluate(ws, "D28"), 26);
  eq("the rollup Total reads the Total row, not a re-sum", ws["N5"].f, "D28");
  check("the practice mean is the mean of 1..26 = 13.5", close(evaluate(ws, "P5")!, 13.5));
}

// ===========================================================================
console.log("\n[2] A 27th provider — the silent-failure safeguard");
{
  const roster = productionRoster();
  // Inserted into ABQ, which pushes LL and RR down by one row.
  roster.push({ id: 99, name: "Newcomer Surname", shortName: "Newcomer", office: "ABQ", isActive: true });
  const subs: SubmissionInput[] = [];
  roster.forEach((p, i) => subs.push(mkSub(`${p.name} (${p.office})`, [i + 1, i + 1, i + 1, i + 1])));
  const a = agg(roster, subs);
  const wb = openWorkbook(buildSurveyWorkbook(a).buffer);
  const ws = wb.sheets["Survey Analysis "];

  eq("ABQ now spans 11 rows", rangeOf(ws, "P2").length, 11);
  eq("LL has shifted down and still spans 8",
    [rangeOf(ws, "P3")[0], rangeOf(ws, "P3").length], ["F13", 8]);
  eq("RR has shifted down and still spans 8",
    [rangeOf(ws, "P4")[0], rangeOf(ws, "P4").length], ["F21", 8]);
  // No row may be counted twice or missed: the three office ranges must
  // partition the provider rows exactly.
  const all = ["P2", "P3", "P4"].reduce<string[]>((acc, r) => acc.concat(rangeOf(ws, r)), []);
  eq("the three ranges cover 27 rows with no overlap",
    [all.length, new Set(all).size], [27, 27]);
  eq("...and exactly the rows the Total row covers",
    [all[0], all[all.length - 1]], [rangeOf(ws, "F29")[0], rangeOf(ws, "F29")[rangeOf(ws, "F29").length - 1]]);
  eq("the Total row now sums 27", evaluate(ws, "D29"), 27);
}

// ===========================================================================
console.log("\n[3] An office with one provider, and an office with none");
{
  const roster: RosterEntry[] = [
    { id: 1, name: "Solo Provider", shortName: "Solo", office: "ABQ", isActive: true },
    { id: 2, name: "Pair One", shortName: "PairOne", office: "RR", isActive: true },
    { id: 3, name: "Pair Two", shortName: "PairTwo", office: "RR", isActive: true },
  ];
  const a = agg(roster, [
    mkSub("Solo Provider (ABQ)", [4, 4, 4, 4]),
    mkSub("Pair One (RR)", [6, 6, 6, 6]),
    mkSub("Pair Two (RR)", [8, 8, 8, 8]),
  ]);
  const ws = openWorkbook(buildSurveyWorkbook(a).buffer).sheets["Survey Analysis "];
  eq("a one-provider office still gets a valid single-cell range", rangeOf(ws, "P2"), ["F2"]);
  eq("...that evaluates to that provider's own average", evaluate(ws, "P2"), 4);
  eq("a two-provider office averages both", evaluate(ws, "P3"), 7);

  // LL carries no providers at all. Its row must exist with NO formula — a
  // range over an empty block would wrap onto the next office's rows.
  const withEmpty = agg(
    roster.concat([]),
    [mkSub("Solo Provider (ABQ)", [4, 4, 4, 4])],
  );
  // Force an office with zero providers by declaring it on a provider who has
  // no submissions, then removing... simpler: an LL provider with no rows still
  // occupies a row, so construct the true empty-office case via `offices`.
  const emptyOfficeAgg = {
    ...withEmpty,
    offices: ["ABQ", "LL"],
  };
  const ws2 = openWorkbook(buildSurveyWorkbook(emptyOfficeAgg as any).buffer).sheets["Survey Analysis "];
  const llRow = ["L2", "L3"].filter((r) => ws2[r]?.v === "LL")[0];
  check("an office with no providers gets a row", !!llRow);
  const n = llRow.replace("L", "");
  check("...and no rollup formula beside it",
    !ws2[`M${n}`] && !ws2[`N${n}`] && !ws2[`P${n}`]);
}

// ===========================================================================
console.log("\n[4] Sheet names — legal, unique, and hazard-proof");
{
  eq("a 31-character name is kept whole",
    sheetNameFor("A".repeat(31), []).length, 31);
  eq("a 33-character name is capped at 31",
    sheetNameFor("Abena Marfowaa Owusu-Nkwantabisah", []).length, 31);
  eq("forbidden characters are stripped",
    sheetNameFor("A/B:C\\D?E*F[G]H", []), "ABCDEFGH");
  eq("a duplicate gets a numeric suffix", sheetNameFor("Amber", ["Amber"]), "Amber 2");
  eq("a third collision continues", sheetNameFor("Amber", ["Amber", "Amber 2"]), "Amber 3");
  eq("collision is case-insensitive, as Excel treats it",
    sheetNameFor("amber", ["AMBER"]), "amber 2");
  eq("a suffix on a 31-char name still fits",
    sheetNameFor("B".repeat(31), ["B".repeat(31)]).length <= 31, true);
  eq("the reserved name History is avoided", sheetNameFor("History", []), "History (provider)");
  eq("an empty name falls back", sheetNameFor("   ", []), "Provider");

  // Forced collision end to end: two providers with no stored short name whose
  // first names match. The database cannot prevent this — the fallback is
  // computed, never written.
  const roster: RosterEntry[] = [
    { id: 1, name: "Amber Lute", shortName: "Amber", office: "LL", isActive: true },
    { id: 2, name: "Amber Merritt", shortName: "Amber", office: "RR", isActive: true },
  ];
  const { sheetNames, renamed } = buildSurveyWorkbook(agg(roster, []));
  eq("both providers get a distinct tab", sheetNames.slice(4), ["Amber", "Amber 2"]);
  eq("the rename is reported", renamed, { Amber: "Amber 2" });
  eq("no two sheet names collide",
    new Set(sheetNames.map((s) => s.toLowerCase())).size, sheetNames.length);
}

// ===========================================================================
console.log("\n[5] An empty tab matches the template, and Total Active Clients is blank");
{
  const roster: RosterEntry[] = [
    { id: 1, name: "Busy Provider", shortName: "Busy", office: "ABQ", isActive: true },
    { id: 2, name: "Quiet Provider", shortName: "Quiet", office: "ABQ", isActive: true },
  ];
  const a = agg(roster, [mkSub("Busy Provider (ABQ)", [9, 9, 9, 9], { comments: { overallRating: "Great." } })]);
  const wb = openWorkbook(buildSurveyWorkbook(a).buffer);
  const quiet = wb.sheets["Quiet"];
  const busy = wb.sheets["Busy"];

  eq("the empty tab keeps its name", quiet["B2"]?.v, "Quiet");
  eq("...and its two labels", [quiet["B3"]?.v, quiet["B4"]?.v],
    ["Total Surveys Completed", "Total Active Clients"]);
  eq("...and its rating headers", [quiet["B5"]?.v, quiet["E5"]?.v], ["Relationship", "Overall"]);
  eq("...and its listing headers", [quiet["A8"]?.v, quiet["D8"]?.v], ["Name", "Comments"]);
  check("...with no survey count", quiet["C3"] === undefined);
  check("...no averages", quiet["B6"] === undefined && quiet["E6"] === undefined);
  check("...and NO percentage formula", quiet["D3"] === undefined);
  check("the populated tab has a count and averages",
    busy["C3"]?.v === 1 && busy["B6"]?.v === 9);
  check("but still no Total Active Clients and no percentage formula",
    busy["C4"] === undefined && busy["D3"] === undefined);

  const ws = wb.sheets["Survey Analysis "];
  check("column C is blank on every provider row",
    ws["C2"] === undefined && ws["C3"] === undefined);
  check("column E carries no formula on any provider row",
    ws["E2"] === undefined && ws["E3"] === undefined);
  eq("but the C header is still present", ws["C1"]?.v, "Total Active Clients");
  check("the rollup percentage column is likewise absent", ws["O2"] === undefined);
  check("no cell anywhere is a division formula",
    !Object.keys(ws).some((k) => typeof ws[k].f === "string" && (ws[k].f as string).indexOf("/") !== -1));
}

// ===========================================================================
console.log("\n[6] The two comment rules differ, correctly");
{
  const roster: RosterEntry[] = [
    { id: 1, name: "Test Provider", shortName: "Tester", office: "ABQ", isActive: true },
  ];
  const a = agg(roster, [
    // A negative response with NO comment: belongs on Neutrals, not on the tab.
    mkSub("Test Provider (ABQ)", [5, 5, 5, 5], { choices: ["Neutral", "Yes", "Yes", "Yes", "Yes"] }),
    // A positive response WITH a comment: belongs on the tab, not on Neutrals.
    mkSub("Test Provider (ABQ)", [9, 9, 9, 9], {
      choices: ["Excellent", "Yes", "Yes", "Yes", "Yes"],
      comments: { overallRating: "Delighted." },
    }),
  ]);
  const wb = openWorkbook(buildSurveyWorkbook(a).buffer);
  const tab = wb.sheets["Tester"];
  const neut = wb.sheets["Neutrals and Below"];

  eq("the provider tab lists exactly one row — the commented one", tab["A9"]?.v !== undefined, true);
  check("...and it is the commented response", tab["D9"]?.v === "Delighted.");
  check("...with no second row", tab["A10"] === undefined);
  const neutCells = Object.keys(neut).filter((k) => neut[k].v === "Neutral");
  check("the uncommented negative still appears on Neutrals and Below", neutCells.length > 0);
}

// ===========================================================================
console.log("\n[7] No identifying field other than the client's name");
{
  const roster: RosterEntry[] = [
    { id: 1, name: "Test Provider", shortName: "Tester", office: "ABQ", isActive: true },
  ];
  const SENTINEL_DOB = "1979-06-21";
  const SENTINEL_EMAIL = "sentinel@example.invalid";
  const SENTINEL_PHONE = "(505) 555-0199";
  const s = mkSub("Test Provider (ABQ)", [3, 3, 3, 3], {
    choices: ["Neutral", "No", "N/A", "No", "No"],
    comments: { overallRating: "A comment." }, client: "Sentinel Client",
  });
  (s.payload.client as Record<string, unknown>).dateOfBirth = SENTINEL_DOB;
  (s.payload.client as Record<string, unknown>).email = SENTINEL_EMAIL;
  (s.payload.client as Record<string, unknown>).phone = SENTINEL_PHONE;

  const { buffer } = buildSurveyWorkbook(agg(roster, [s]));
  const haystack = buffer.toString("binary");
  check("no date of birth anywhere in the file", haystack.indexOf(SENTINEL_DOB) === -1);
  check("no email anywhere in the file", haystack.indexOf(SENTINEL_EMAIL) === -1);
  check("no phone anywhere in the file", haystack.indexOf("555-0199") === -1);
  const wb = openWorkbook(buffer);
  const neut = wb.sheets["Neutrals and Below"];
  check("but the client's name IS present, by the client's own design",
    Object.keys(neut).some((k) => neut[k].v === "Sentinel Client"));
}

// ===========================================================================
console.log("\n[8] Listing rows beyond the template's drawn block");
{
  const roster: RosterEntry[] = [
    { id: 1, name: "Chatty Provider", shortName: "Chatty", office: "ABQ", isActive: true },
  ];
  // 25 commented submissions — the template draws only 20 listing rows.
  const subs = [];
  for (let i = 0; i < 25; i++) {
    subs.push(mkSub("Chatty Provider (ABQ)", [5, 5, 5, 5], {
      comments: { overallRating: `Comment number ${i + 1}` }, client: `Client ${i + 1}`,
    }));
  }
  const wb = openWorkbook(buildSurveyWorkbook(agg(roster, subs)).buffer);
  const tab = wb.sheets["Chatty"];
  eq("the 25th row is written past the drawn block", tab["D33"]?.v, "Comment number 25");
  const lastRow = parseInt(/(\d+)$/.exec(wb.dims["Chatty"].split(":")[1])![1], 10);
  check("the sheet's dimension grew to fit", lastRow >= 33, `${lastRow}`);
}

// ===========================================================================
console.log("\n[9] Structure, wording and the trailing space");
{
  const roster = productionRoster();
  const a = agg(roster, roster.map((p, i) => mkSub(`${p.name} (${p.office})`, [i + 1, i + 1, i + 1, i + 1])));
  const { buffer, sheetNames } = buildSurveyWorkbook(a);
  const wb = openWorkbook(buffer);

  eq("sheet order matches the template", sheetNames.slice(0, 4),
    ["Data", "Survey Analysis ", "In Person and TH Ratings", "Neutrals and Below"]);
  check("Survey Analysis keeps its trailing space",
    sheetNames[1] === "Survey Analysis " && wb.sheets["Survey Analysis"] === undefined);
  eq("...and the reader sees the same name", wb.names[1], "Survey Analysis ");
  const data = wb.sheets["Data"];
  check("the Data sheet is emitted empty — no invented columns",
    Object.keys(data).length === 0);

  // The template's telehealth headings are wrong in two places; the instrument's
  // real wording must appear instead.
  const flat = JSON.stringify(wb.sheets["Neutrals and Below"]) + JSON.stringify(wb.sheets["In Person and TH Ratings"]);
  check("the telehealth 10-minute question uses the instrument's wording",
    flat.indexOf("Were you called within 10 minutes of your appointment time to begin your session?") !== -1);
  check("the telehealth privacy question keeps 'in this treatment format'",
    flat.indexOf("in this treatment format") !== -1);

  // No rollup is computed in code: every rollup cell must be a formula.
  const ws = wb.sheets["Survey Analysis "];
  const rollupCells = ["M2", "N2", "P2", "Q2", "R2", "S2", "M5", "N5", "P5"];
  check("every rollup cell is a formula, not a number",
    rollupCells.every((c) => typeof ws[c]?.f === "string"));
  check("...and none carries a cached value",
    rollupCells.every((c) => ws[c]?.v === undefined));
  check("the Total row is a formula too",
    typeof ws["D28"]?.f === "string" && ws["D28"]?.v === undefined);

  const write = process.argv.indexOf("--write");
  if (write !== -1 && process.argv[write + 1]) {
    writeFileSync(process.argv[write + 1], buffer);
    console.log(`  (wrote ${process.argv[write + 1]} — ${buffer.length} bytes, ${sheetNames.length} sheets)`);
  }
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
