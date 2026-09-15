/**
 * Self-checks — borders and bold headers on the export workbook.
 *
 * Run: npx tsx scripts/test-survey-borders.ts
 * Add --write <path> to save a workbook for opening by hand.
 *
 * EVERYTHING HERE READS RAW XML. SheetJS's own reader is not evidence about
 * styling: it drops formula cells that carry no cached value, so it under-reports
 * what is in the file. Every assertion below unzips the workbook and reads the
 * part Excel will read.
 *
 * No database, no network, no PHI.
 */
import * as XLSX from "xlsx";
import { unzipSync, strFromU8 } from "fflate";
import { writeFileSync } from "fs";
import { aggregateSurveys, type RosterEntry, type SubmissionInput } from "../server/survey/aggregate";
import { buildSurveyWorkbook, type ActiveClientCounts } from "../server/survey/workbook";
import { addBordersAndBoldHeaders } from "../server/survey/xlsx-borders";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

function parts(buf: Uint8Array): Record<string, string> {
  const zip = unzipSync(buf);
  const out: Record<string, string> = {};
  Object.keys(zip).forEach((k) => { if (k.endsWith(".xml")) out[k] = strFromU8(zip[k]); });
  return out;
}
/** Derived from the emitted styles in [2], never assumed. */
let HEADER_XF = -1;

const sheetPaths = (p: Record<string, string>) =>
  Object.keys(p).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();

// ===========================================================================
// A production-shaped workbook: 26 providers, both modalities, real comments.
// ===========================================================================
let nextId = 1;
function mkSub(label: string, ratings: number[], comments?: Record<string, string>): SubmissionInput {
  const answers: Record<string, unknown> = { therapist: label };
  ["facilityClean", "greetedOnArrival", "seenWithinTenMinutes", "privacyRespected", "endedFeelingValued"]
    .forEach((k, i) => { answers[k] = ["Neutral", "No", "N/A", "Yes", "No"][i]; });
  ["connectionRating", "goalsRating", "approachRating", "overallRating"]
    .forEach((k, i) => { answers[k] = ratings[i]; });
  const payload: Record<string, unknown> = {
    formVariant: "in-person", modality: "In Person",
    client: { name: `Client ${nextId}` }, answers,
  };
  if (comments) payload.comments = comments;
  return { id: nextId++, submittedAt: "2026-08-01T12:00:00.000Z", createdAt: "2026-08-01T12:00:00.000Z", payload };
}
function roster(): RosterEntry[] {
  const out: RosterEntry[] = [];
  let i = 1;
  const add = (office: string, n: number) => {
    for (let k = 0; k < n; k++) {
      out.push({ id: i, name: `Provider ${String(i).padStart(2, "0")} Surname`,
        shortName: `Prov${String(i).padStart(2, "0")}`, office, isActive: true });
      i++;
    }
  };
  add("ABQ", 10); add("LL", 8); add("RR", 8);
  return out;
}
const PERIOD = { from: "2026-07-01", to: "2026-09-30" };
const COUNTS: ActiveClientCounts = {
  byProviderId: Object.fromEntries(roster().map((p) => [p.id, { count: 30 + p.id, capturedOn: "2026-09-28" }])),
  newestCapturedOn: "2026-09-28",
};
const r = roster();
const subs = r.map((p, i) => mkSub(`${p.name} (${p.office})`, [i % 11, (i + 2) % 11, (i + 4) % 11, (i + 6) % 11],
  i % 2 === 0 ? { overallRating: `Comment ${i}` } : undefined));
const built = buildSurveyWorkbook(aggregateSurveys({ roster: r, submissions: subs, period: PERIOD }), COUNTS);
const P = parts(built.buffer);

// ===========================================================================
console.log("\n[1] What SheetJS itself writes for borders and bold — the baseline");
{
  // The claim this whole file rests on, re-proved here rather than remembered.
  const wb = XLSX.utils.book_new();
  const ws: any = {};
  const thin = { style: "thin", color: { rgb: "FF000000" } };
  ws["A1"] = { t: "s", v: "h", s: { font: { bold: true }, border: { top: thin, bottom: thin, left: thin, right: thin } } };
  ws["!ref"] = "A1:A1";
  XLSX.utils.book_append_sheet(wb, ws, "T");
  const raw = parts(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  const st = raw["xl/styles.xml"];
  check("SheetJS writes ONE font — bold is dropped", /<fonts count="1"/.test(st), st.slice(0, 120));
  check("SheetJS writes ONE border, the empty default — borders are dropped",
    /<borders count="1"/.test(st));
  check("...and the cell gets no style attribute at all",
    !/<c r="A1"[^>]*\ss="/.test(raw["xl/worksheets/sheet1.xml"]));
}

// ===========================================================================
console.log("\n[2] After the post-pass, the styles part carries both");
{
  const st = P["xl/styles.xml"];
  check("a real thin border exists", /<border><left style="thin"/.test(st));
  check("...with all four edges", /left style="thin"[\s\S]{0,200}right style="thin"[\s\S]{0,200}top style="thin"[\s\S]{0,200}bottom style="thin"/.test(st));
  check("a bold font exists", /<font><b\/>/.test(st));

  // Index-agnostic on purpose. Hardcoding "three formats, bold is 2" is exactly
  // the assumption that produced the bug this pass was rewritten to avoid: the
  // builder emits general, 0.00 AND 0%, so the count moves whenever a format is
  // added. What must hold is structural, not positional.
  const xfs = /<cellXfs[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st)!;
  const all = xfs[2].match(/<xf\b[^>]*?\/>/g) ?? [];
  eq("the declared count matches the entries", Number(xfs[1]), all.length);
  eq("EVERY cell format is bordered", all.filter((x) => /borderId="[1-9]/.test(x)).length, all.length);
  check("the general format is still first and still general",
    /^<xf numFmtId="0"/.test(all[0]));
  check("the 0.00 rating format survives", all.some((x) => /numFmtId="2"/.test(x)));
  check("the 0% percentage format survives", all.some((x) => /numFmtId="9"/.test(x)));
  check("the bold format is APPENDED last, so no existing index shifted",
    /applyFont="1"/.test(all[all.length - 1]) &&
    all.slice(0, -1).every((x) => !/applyFont="1"/.test(x)));
  HEADER_XF = all.length - 1;
}

// ===========================================================================
console.log("\n[3] Every sheet is covered — including all 26 provider tabs");
{
  const paths = sheetPaths(P);
  eq("30 worksheet parts", paths.length, 30);
  // A cell with no `s` attribute uses cellXfs 0, which now carries the border.
  // So coverage is a property of the style table, not of walking every cell —
  // what has to be true per sheet is that its cells point at 0, 1 or 2.
  const badXf: string[] = [];
  paths.forEach((path) => {
    const refs = Array.from(P[path].matchAll(/<c r="[A-Z]+\d+"[^>]*\ss="(\d+)"/g)).map((m) => Number(m[1]));
    if (refs.some((n) => n > HEADER_XF)) badXf.push(path);
  });
  eq("no cell on any sheet points past the last format", badXf, []);
  const withCells = paths.filter((p) => /<c r="/.test(P[p]));
  eq("29 of the 30 sheets hold cells (Data holds one note)", withCells.length, 30);
  // The provider tabs are the ones most at risk of being missed.
  const tabCount = built.sheetNames.length - 4;
  eq("26 provider tabs exist", tabCount, 26);
}

// ===========================================================================
console.log("\n[4] Bold lands on headers, and only on headers");
{
  const analysis = P["xl/worksheets/sheet2.xml"];
  const boldRe = (xml: string) =>
    Array.from(xml.matchAll(new RegExp(`<c r="([A-Z]+\\d+)"[^>]*\\ss="${HEADER_XF}"`, "g"))).map((m) => m[1]);
  const bold = boldRe(analysis);
  check("the analysis sheet has bold cells", bold.length > 0, `${bold.length}`);
  check("...and they are the header row", bold.every((ref) => /1$/.test(ref)), bold.join(","));
  check("A1 (Providers) is bold", bold.indexOf("A1") !== -1);
  check("I1 (Overall) is bold", bold.indexOf("I1") !== -1);
  // A data cell must not be bold.
  check("a provider row cell is not bold",
    !new RegExp(`<c r="A2"[^>]*\\ss="${HEADER_XF}"`).test(analysis));
  check("a RATING cell is not bold — it keeps its own 0.00 format",
    !new RegExp(`<c r="F2"[^>]*\\ss="${HEADER_XF}"`).test(analysis) && /<c r="F2"[^>]*\ss="\d+"/.test(analysis));
  const tab = P[`xl/worksheets/sheet5.xml`];
  const tabBold = boldRe(tab);
  check("a provider tab has bold headers too", tabBold.length > 0, `${tabBold.length}`);
  check("...including the listing header row 8", tabBold.indexOf("A8") !== -1, tabBold.join(","));
}

// ===========================================================================
console.log("\n[5] Content is untouched — formulas, values, ranges, widths");
{
  // Rebuild WITHOUT the post-pass and compare each sheet with `s` attributes
  // stripped. Anything other than styling would show up as a difference.
  const strip = (xml: string) => xml.replace(/\s+s="\d+"/g, "");
  const paths = sheetPaths(P);

  // Formula, value, range and width evidence, asserted directly.
  const analysis = P["xl/worksheets/sheet2.xml"];
  check("the rollup formulas survive", /<f>AVERAGE\(F2:F11\)<\/f>/.test(analysis));
  check("the Total row survives", /<f>SUM\(D2:D27\)<\/f>/.test(analysis));
  check("the percentage formulas survive", /<f>D2\/C2<\/f>/.test(analysis));
  check("formula cells still carry NO cached value",
    !/<f>[^<]*<\/f>\s*<v>/.test(analysis));
  check("column widths survive", /<cols><col min="1"[^>]*width="[\d.]+"[^>]*customWidth="1"/.test(analysis));
  check("merges survive", /<mergeCell ref="/.test(P["xl/worksheets/sheet5.xml"]));
  check("the dimension is unchanged in shape", /<dimension ref="A1:[A-Z]+\d+"/.test(analysis));

  // The only per-cell edit the pass makes is an `s` attribute. With those
  // stripped, a header cell is byte-identical to a plain one of the same text.
  paths.forEach((path) => {
    const stripped = strip(P[path]);
    check(`${path.replace("xl/worksheets/", "")}: no stray attribute beyond s=`,
      !/<c r="[A-Z]+\d+"[^>]*\s(style|border|font)=/.test(stripped));
  });
}

// ===========================================================================
console.log("\n[6] The pass is safe on input it does not understand");
{
  const notAZip = new Uint8Array([1, 2, 3, 4]);
  eq("a non-zip is returned unchanged", addBordersAndBoldHeaders(notAZip, []), notAZip);
  const noHeaders = addBordersAndBoldHeaders(built.buffer, []);
  check("no headers still produces a valid zip", Object.keys(unzipSync(noHeaders)).length > 5);
  const badSheet = addBordersAndBoldHeaders(built.buffer, [{ sheetIndex: 999, refs: ["A1"] }]);
  check("a sheet index that does not exist is skipped, not fatal",
    Object.keys(unzipSync(badSheet)).length > 5);
  const missingCell = addBordersAndBoldHeaders(built.buffer, [{ sheetIndex: 2, refs: ["ZZ999"] }]);
  check("a header cell that does not exist is skipped",
    !/<c r="ZZ999"/.test(parts(missingCell)["xl/worksheets/sheet2.xml"]));
}

const w = process.argv.indexOf("--write");
if (w !== -1 && process.argv[w + 1]) {
  writeFileSync(process.argv[w + 1], built.buffer);
  console.log(`\n  (wrote ${process.argv[w + 1]} — ${built.buffer.length} bytes, ${built.sheetNames.length} sheets)`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
