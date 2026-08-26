/**
 * Monthly report self-checks.
 *
 * Runs the REAL pivotDashboard(), assembleMonthlyReport() and both renderers
 * against a snapshot of real production rows — production code, not a
 * reimplementation.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/verify-monthly-report.ts fixture.json
 *
 * Read-only. Touches no database and sends no email.
 */

import { readFileSync, writeFileSync } from "fs";
import { pivotDashboard } from "../server/dashboard/db";
import { assembleMonthlyReport, resolvePeriod, previousPeriod } from "../server/reports/monthly";
import {
  renderMonthlyReportHtml, renderMonthlyReportSubject, renderMonthlyReportXlsx,
} from "../server/reports/render";
import * as XLSX from "xlsx";

const path = process.argv[2];
const outDir = process.argv[3] ?? ".";
if (!path) {
  console.error("usage: tsx scripts/verify-monthly-report.ts <fixture.json> [outDir]");
  process.exit(1);
}
const fx = JSON.parse(readFileSync(path, "utf8"));

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
};
const assertTrue = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail && !cond ? ` — ${detail}` : ""}`);
};

const snapshot = pivotDashboard(fx.dashboard, "active");

// ============================================================================
console.log("=".repeat(72) + "\n1 + 2. SNAPSHOT reconciles with the dashboard\n" + "=".repeat(72));
check("snapshot active", snapshot.totals.active, 217);
check("snapshot pipeline", snapshot.totals.pipeline, 212);
check("snapshot otherActive", snapshot.totals.otherActive, 5);
check("snapshot all", snapshot.totals.all, 1222);
console.log("  per-location active:", snapshot.byStatus.rows
  .map((r) => `${r.location}=${r.active}`).join(" "));

// ============================================================================
console.log("\n" + "=".repeat(72) + "\n3. COHORT is a genuinely different population\n" + "=".repeat(72));

const reports: Record<string, ReturnType<typeof assembleMonthlyReport>> = {};
for (const period of Object.keys(fx.cohorts)) {
  reports[period] = assembleMonthlyReport(period, snapshot, fx.cohorts[period], fx.undated);
}

for (const [period, r] of Object.entries(reports)) {
  const c = r.cohort;
  console.log(`\n  ${r.periodLabel} (${r.periodStart} .. ${r.periodEndExclusive})`);
  console.log(`    cohort=${c.size} active=${c.nowActive} inactive=${c.nowInactive} ` +
    `scheduled=${c.currentlyScheduled} completed=${c.initialApptCompleted} reached=${c.reachedScheduling}`);
  console.log(`    byStatusBucket: ${JSON.stringify(c.byStatusBucket.counts)}`);
  console.log(`    byOrigin:       ${JSON.stringify(c.byOrigin.counts)}`);
  console.log(`    byLocation:     ${JSON.stringify(c.byLocation.counts)}`);
  console.log(`    byServiceType:  ${JSON.stringify(c.byServiceType.counts)} other=${c.byServiceType.other} unknown=${c.byServiceType.unknown}`);

  // 4. every breakdown sums to the cohort size
  const sum = (b: { counts: Record<string, number>; other: number; unknown: number }) =>
    Object.values(b.counts).reduce((a, x) => a + x, 0) + b.other + b.unknown;
  check(`  [${period}] byStatusBucket sums`, sum(c.byStatusBucket), c.size);
  check(`  [${period}] byOrigin sums`, sum(c.byOrigin), c.size);
  check(`  [${period}] byServiceType sums`, sum(c.byServiceType), c.size);
  check(`  [${period}] byLocation sums`, sum(c.byLocation), c.size);
  check(`  [${period}] active + inactive == size`, c.nowActive + c.nowInactive, c.size);
  check(`  [${period}] byStatusCode sums`, c.byStatusCode.reduce((a, x) => a + x.n, 0), c.size);
}

// The headline claim: the cohort contains members the snapshot query cannot see.
const aug = reports["2026-08"];
assertTrue("August cohort contains members the snapshot would MISS",
  aug.cohort.nowInactive > 0,
  "nowInactive is 0 — the cohort is not behaving as a retrospective");
console.log(`       → ${aug.cohort.nowInactive} of ${aug.cohort.size} August referrals ` +
  `(${Math.round((aug.cohort.nowInactive / aug.cohort.size) * 100)}%) are already closed ` +
  `and would be invisible to the active-population query.`);

// ============================================================================
console.log("\n" + "=".repeat(72) + "\n4. EMPTY PERIOD renders cleanly\n" + "=".repeat(72));
const empty = reports["2020-01"];
check("empty cohort size", empty.cohort.size, 0);
const emptyHtml = renderMonthlyReportHtml(empty);
assertTrue("empty period renders without throwing", emptyHtml.length > 0);
assertTrue("empty period states it plainly",
  emptyHtml.includes("No referrals were received"));
const emptyXlsx = renderMonthlyReportXlsx(empty);
assertTrue("empty period XLSX builds", emptyXlsx.length > 0);

// ============================================================================
console.log("\n" + "=".repeat(72) + "\n5. PERIOD helpers\n" + "=".repeat(72));
check("resolvePeriod 2026-08 end", resolvePeriod("2026-08").endExclusive, "2026-09-01");
check("resolvePeriod 2026-12 rolls year", resolvePeriod("2026-12").endExclusive, "2027-01-01");
check("previousPeriod(2026-09-01 MT)", previousPeriod(new Date("2026-09-01T14:00:00Z")), "2026-08");
check("previousPeriod(2027-01-01 MT)", previousPeriod(new Date("2027-01-01T14:00:00Z")), "2026-12");
// A cron firing 00:30 MT on Sept 1 is already Sept 1 06:30 UTC — still August.
check("previousPeriod(00:30 MT Sept 1)", previousPeriod(new Date("2026-09-01T06:30:00Z")), "2026-08");

// ============================================================================
console.log("\n" + "=".repeat(72) + "\n6. NO PHI in the rendered output\n" + "=".repeat(72));

const html = renderMonthlyReportHtml(aug);
const xlsxBuf = renderMonthlyReportXlsx(aug);
writeFileSync(`${outDir}/monthly-preview.html`, html);
writeFileSync(`${outDir}/monthly-preview.xlsx`, xlsxBuf);

// Read every cell back out of the workbook and scan it alongside the HTML.
const wb = XLSX.read(xlsxBuf, { type: "buffer" });
const cells: string[] = [];
for (const name of wb.SheetNames) {
  const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[name], { header: 1 });
  for (const row of aoa) for (const cell of row) cells.push(String(cell ?? ""));
}
const xlsxText = cells.join("\n");

const PHI_PATTERNS: [string, RegExp][] = [
  ["email address", /[A-Za-z0-9._%+-]+@(?!tfc\.health|nmfamilyconnection|hipaacheck)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["phone number", /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/],
  ["date of birth marker", /\bDOB\b|\bdate of birth\b/i],
  ["MM/DD/YYYY date", /\b\d{1,2}\/\d{1,2}\/(19|20)\d{2}\b/],
  ["SSN-like", /\b\d{3}-\d{2}-\d{4}\b/],
];
for (const [label, re] of PHI_PATTERNS) {
  const inHtml = re.test(html);
  const inXlsx = re.test(xlsxText);
  assertTrue(`HTML  clean of ${label}`, !inHtml, inHtml ? `matched ${re}` : "");
  assertTrue(`XLSX  clean of ${label}`, !inXlsx, inXlsx ? `matched ${re}` : "");
}
// Structural guarantee: the report type carries counts only, so there is no
// field a name COULD come from. Assert the sheet count is what we expect.
check("XLSX sheet count", wb.SheetNames.length, 7);
console.log("  sheets:", wb.SheetNames.join(" | "));
console.log(`  subject: ${renderMonthlyReportSubject(aug)}`);
console.log(`  wrote ${outDir}/monthly-preview.html (${html.length} bytes) and .xlsx (${xlsxBuf.length} bytes)`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
