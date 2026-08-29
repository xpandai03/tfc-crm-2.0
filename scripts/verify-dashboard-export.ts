/**
 * Dashboard Excel export self-checks.
 *
 * Builds a REAL workbook from real production rows, then reads every cell back
 * out and checks it against the pivot the dashboard renders. Also verifies the
 * embedded picture plumbing and scans every sheet for PHI.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/verify-dashboard-export.ts groups.json [outDir]
 *
 * Read-only: no database, no network, no writes outside outDir.
 */

import { readFileSync, writeFileSync } from "fs";
import * as XLSX from "xlsx";
import { unzipSync, strFromU8 } from "fflate";
import { pivotDashboard } from "../server/dashboard/db";
import { embedImages } from "../server/dashboard/xlsx-images";
import type { DashboardSummary, CardScope } from "../client/src/lib/dashboard-api";

const rows = JSON.parse(readFileSync(process.argv[2], "utf8"));
const outDir = process.argv[3] ?? ".";

let fail = 0;
const ok = (l: string, c: boolean, d = "") => {
  if (!c) fail++;
  console.log(`${c ? "PASS" : "FAIL"}  ${l}${!c && d ? ` — ${d}` : ""}`);
};
const eq = (l: string, a: unknown, e: unknown) => ok(`${l}: ${a}`, a === e, `expected ${e}`);

// The export module calls getDashboardSummary (which hits the DB), so for the
// harness we stub that boundary and drive buildDashboardWorkbook's pure logic
// through the same pivot the server would have produced.
const summary = pivotDashboard(rows, "active") as unknown as DashboardSummary;

// ---------------------------------------------------------------------------
// 1 + 2: the workbook's tables must equal the pivot, and reconcile
// ---------------------------------------------------------------------------
// Rebuild the sheets exactly as export.ts does, then read them back.
// (buildDashboardWorkbook is exercised end-to-end on the server; here we assert
// the invariants the sheets must satisfy whatever the data happens to be.)

function sheetToAoa(wb: XLSX.WorkBook, name: string): (string | number)[][] {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }) as (string | number)[][];
}

console.log("=== building a real workbook from production rows ===");
// buildWorkbookFromSummary is the PURE half: no database, exact production code.
const { buildWorkbookFromSummary } = await import("../server/dashboard/export");
const build = (req: Parameters<typeof buildWorkbookFromSummary>[1]) =>
  buildWorkbookFromSummary(summary as never, req);

for (const scope of ["pipeline", "waitlist"] as CardScope[]) {
  console.log(`\n${"=".repeat(70)}\nscope=${scope}\n${"=".repeat(70)}`);

  const { buffer, filename, imagesEmbedded, warnings } = build({
    population: "active",
    scopes: {
      serviceType: scope, insurance: scope,
      serviceTypeInsurance: scope, origin: scope,
    },
    images: [],
  });
  ok(`  workbook built (${filename}, ${buffer.length} bytes)`, buffer.length > 0);
  eq("  images embedded when none supplied", imagesEmbedded, 0);
  eq("  no warnings", warnings.length, 0);

  const wb = XLSX.read(buffer, { type: "buffer" });
  console.log(`  sheets: ${wb.SheetNames.join(" | ")}`);
  eq("  sheet count", wb.SheetNames.length, 6);

  const set = summary.scopes[scope];

  // --- Card 1 (always active-population, never scoped) ---------------------
  const s1 = sheetToAoa(wb, wb.SheetNames[1]);
  const totalRow1 = s1.find((r) => r[0] === "All locations")!;
  ok("  Card1 total row present", !!totalRow1);
  // columns: Location, 4 buckets, Pipeline, Active, Inactive, Total
  eq("  Card1 Active total matches pivot", totalRow1[6], summary.totals.active);
  eq("  Card1 Pipeline total matches pivot", totalRow1[5], summary.totals.pipeline);
  const bucketSum = [1, 2, 3, 4].reduce((a, i) => a + Number(totalRow1[i] ?? 0), 0);
  eq("  Card1 buckets sum to Active", bucketSum, summary.totals.active);

  // --- Cards 2/3/5: location cross-tabs reconcile --------------------------
  const checkLocationSheet = (
    sheetIdx: number, label: string, expectTotal: number, expectOther = true,
  ) => {
    const aoa = sheetToAoa(wb, wb.SheetNames[sheetIdx]);
    const header = aoa.find((r) => r[0] === "Location")!;
    const totalRow = aoa.find((r) => r[0] === "All locations")!;
    ok(`  ${label} header + total row present`, !!header && !!totalRow);
    const totalCol = header.length - 1;
    // every data cell except the first (label) and last (total) must sum to it
    const cells = totalRow.slice(1, totalCol).reduce((a, v) => a + Number(v ?? 0), 0);
    eq(`  ${label} columns reconcile to row total`, cells, Number(totalRow[totalCol]));
    eq(`  ${label} row total matches scope count`, Number(totalRow[totalCol]), expectTotal);
    // Origin is a TOTAL partition — every contact lands in exactly one of three
    // channels — so it correctly has no residual column to keep.
    if (expectOther) {
      ok(`  ${label} keeps an Other / Unmapped column`, header.includes("Other / Unmapped"));
    } else {
      ok(`  ${label} needs no residual column (total partition)`,
        !header.includes("Other / Unmapped"));
    }
    // Scope must be stated on the sheet.
    ok(`  ${label} states its scope`,
      aoa.some((r) => typeof r[0] === "string" && r[0].startsWith("Scope:")));
  };
  checkLocationSheet(2, "Card2 ServiceType", set.byServiceType.totals.total);
  checkLocationSheet(3, "Card3 Insurance", set.byInsurance.totals.total);
  checkLocationSheet(5, "Card5 Origin", set.byOrigin.totals.total, false);

  // --- Card 4: service-type keyed ------------------------------------------
  const s4 = sheetToAoa(wb, wb.SheetNames[4]);
  const hdr4 = s4.find((r) => r[0] === "Service type")!;
  const tot4 = s4.find((r) => r[0] === "All service types")!;
  ok("  Card4 header + total row present", !!hdr4 && !!tot4);
  const c4 = tot4.slice(1, hdr4.length - 1).reduce((a, v) => a + Number(v ?? 0), 0);
  eq("  Card4 columns reconcile to row total", c4, Number(tot4[hdr4.length - 1]));
  eq("  Card4 total matches scope count",
    Number(tot4[hdr4.length - 1]), set.byServiceTypeInsurance.totals.total);
  ok("  Card4 keeps an Other / Unmapped column", hdr4.includes("Other / Unmapped"));

  // --- 5: header block ------------------------------------------------------
  const ov = sheetToAoa(wb, wb.SheetNames[0]).map((r) => String(r[0] ?? "") + " " + String(r[1] ?? ""));
  ok("  Overview states the population", ov.some((l) => l.startsWith("Population")));
  ok("  Overview states the pipeline definition", ov.some((l) => l.includes("Pipeline =")));
  ok("  Overview states the counting rule",
    ov.some((l) => l.includes("first-choice modality")));
  ok("  Overview states the export time", ov.some((l) => l.startsWith("Exported (UTC)")));
  ok("  Overview records each card's scope",
    ov.some((l) => l.includes(scope === "waitlist" ? "Waitlist only" : "Pipeline (")));

  // --- 3: PHI scan across every sheet --------------------------------------
  const allText: string[] = [];
  for (const name of wb.SheetNames) {
    for (const row of sheetToAoa(wb, name)) {
      for (const cell of row) allText.push(String(cell ?? ""));
    }
  }
  const CANON = new Set<string>(summary.byInsurance.columns);
  const PHI: [string, RegExp][] = [
    ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
    ["phone number", /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/],
    ["DOB marker", /\bDOB\b|\bdate of birth\b/i],
    ["MM/DD/YYYY date", /\b\d{1,2}\/\d{1,2}\/(19|20)\d{2}\b/],
    ["SSN-like", /\b\d{3}-\d{2}-\d{4}\b/],
  ];
  for (const [label, re] of PHI) {
    const hits = allText.filter((t) => re.test(t));
    ok(`  workbook clean of ${label}`, hits.length === 0, hits.slice(0, 2).join(" | "));
  }
  // Any insurance string present must be one of the 16 canonical names.
  const insuranceLike = allText.filter((t) =>
    /insurance|tricare|bcbs|blue ?cross|molina|presbyterian|uhc|united/i.test(t));
  // Sheet names and headings legitimately contain the word "Insurance"; only a
  // non-canonical PAYER VALUE would be a leak.
  const strayInsurance = insuranceLike.filter((t) =>
    !CANON.has(t)
    && !/insurance/i.test(t.replace(/[A-Za-z]+ Insurance|Insurance[A-Za-z ]*/g, ""))
    && !/^\d+\s|^(Location|Service Type)/.test(t)
    && !t.includes("approved payers") && !t.startsWith("Other / Unmapped"));
  ok("  no raw (non-canonical) insurance value anywhere in the workbook",
    strayInsurance.length === 0, strayInsurance.slice(0, 3).join(" | "));

  if (scope === "pipeline") {
    writeFileSync(`${outDir}/dashboard-export-sample.xlsx`, buffer);
    console.log(`  wrote ${outDir}/dashboard-export-sample.xlsx`);
  }
}

// ---------------------------------------------------------------------------
// 4: the picture plumbing — static image, no chart part, no formulas
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(70)}\nimage embedding\n${"=".repeat(70)}`);

// A 1x1 red PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const withImages = build({
  population: "active",
  scopes: { serviceType: "pipeline", insurance: "pipeline", serviceTypeInsurance: "pipeline", origin: "pipeline" },
  images: [
    { card: "status", base64: TINY_PNG.toString("base64"), widthPx: 720, heightPx: 280 },
    { card: "insurance", base64: TINY_PNG.toString("base64"), widthPx: 720, heightPx: 480 },
  ],
});
eq("  images embedded", withImages.imagesEmbedded, 2);
eq("  no warnings", withImages.warnings.length, 0);

const zip = unzipSync(new Uint8Array(withImages.buffer));
const names = Object.keys(zip);
ok("  media parts written", names.filter((n) => n.startsWith("xl/media/")).length === 2,
  names.filter((n) => n.startsWith("xl/media/")).join(","));
ok("  drawing parts written", names.filter((n) => n.startsWith("xl/drawings/drawing")).length === 2);
ok("  drawing rels written", names.filter((n) => n.includes("drawings/_rels")).length === 2);
ok("  worksheet rels written", names.some((n) => n.startsWith("xl/worksheets/_rels/")));
ok("  png content-type declared",
  strFromU8(zip["[Content_Types].xml"]).includes('Extension="png"'));
ok("  drawing content-type declared",
  strFromU8(zip["[Content_Types].xml"]).includes("drawing+xml"));

// The critical claim: pictures, not charts. No chart part, no cached series.
ok("  NO chart part exists (nothing can recalculate)",
  !names.some((n) => n.startsWith("xl/charts/")), names.filter((n) => n.includes("chart")).join(","));
const sheetXmls = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
const anyFormula = sheetXmls.some((n) => strFromU8(zip[n]).includes("<f>"));
ok("  NO formulas in any worksheet", !anyFormula);
ok("  drawing element referenced by a sheet",
  sheetXmls.some((n) => strFromU8(zip[n]).includes("<drawing r:id=")));

// A corrupt image must not cost the client the numbers.
const badImage = build({
  population: "active",
  scopes: {},
  images: [{ card: "status", base64: "!!!not-base64!!!", widthPx: 100, heightPx: 100 }],
});
ok("  workbook still produced when an image is unusable", badImage.buffer.length > 0);
console.log(`  (warnings: ${badImage.warnings.length ? badImage.warnings.join("; ") : "none"})`);

console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
