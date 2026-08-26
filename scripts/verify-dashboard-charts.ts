/**
 * Dashboard chart reconciliation self-checks.
 *
 * THE check: every chart segment set must sum to the same total the table shows
 * beside it. A chart that disagrees with its own table destroys trust in the
 * whole page, and it is the one defect a reviewer cannot spot by reading.
 *
 * Runs the REAL builders from client/src/lib/dashboard-charts.ts against the
 * REAL pivot output, so this exercises the code the page runs.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/verify-dashboard-charts.ts groups.json
 *
 * Read-only. No database, no network.
 */

import { readFileSync } from "fs";
import { pivotDashboard } from "../server/dashboard/db";
import {
  buildServiceTypeChart, buildInsuranceChart, buildOriginChart,
  insuranceChartHeight, type ChartSpec,
} from "../client/src/lib/dashboard-charts";
import type { DashboardSummary } from "../client/src/lib/dashboard-api";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/verify-dashboard-charts.ts <grouped-rows.json>");
  process.exit(1);
}
const groups = JSON.parse(readFileSync(path, "utf8"));

let failures = 0;
const pass = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Sum every series segment of a row and compare with the row's stated total. */
function checkSpec(label: string, spec: ChartSpec, expectedGrand: number) {
  let grand = 0;
  for (const row of spec.rows) {
    const summed = spec.series.reduce((a, s) => a + Number(row[s.key] ?? 0), 0);
    pass(`  ${label} / "${row.full}" segments sum to row total`,
      summed === row.__total, `segments=${summed} rowTotal=${row.__total}`);
    grand += row.__total;
  }
  pass(`  ${label} rows sum to the card total`,
    grand === expectedGrand, `rows=${grand} card=${expectedGrand}`);
}

for (const population of ["active", "all"] as const) {
  const summary = pivotDashboard(groups, population) as unknown as DashboardSummary;
  console.log("\n" + "=".repeat(72));
  console.log(`population=${population}  (counted ${summary.totals.counted})`);
  console.log("=".repeat(72));

  // --- Card 2 ---------------------------------------------------------------
  const svc = buildServiceTypeChart(summary);
  console.log(`\nCard 2 — Location x Service Type: ${svc.rows.length} rows, ${svc.series.length} series`);
  console.log(`  series: ${svc.series.map((s) => s.label).join(" | ")}`);
  checkSpec("Card2", svc, summary.byServiceType.totals.total);
  // every table row must have a chart row, including all-zero locations
  pass("  Card2 renders every location (no location omitted)",
    svc.rows.length === summary.locations.length,
    `chartRows=${svc.rows.length} locations=${summary.locations.length}`);

  // --- Card 3 ---------------------------------------------------------------
  const ins = buildInsuranceChart(summary);
  console.log(`\nCard 3 — Insurance x Location (INVERTED): ${ins.rows.length} rows, ${ins.series.length} series`);
  console.log(`  series: ${ins.series.map((s) => s.label).join(" | ")}`);
  checkSpec("Card3", ins, summary.byInsurance.totals.total);

  // ordering: descending by total, with residuals pinned last
  const residualNames = ["Other / Unmapped", "Not recorded"];
  const payerPart = ins.rows.filter((r) => !residualNames.includes(r.full));
  const residualPart = ins.rows.filter((r) => residualNames.includes(r.full));
  pass("  Card3 payer rows are ordered by total, descending",
    payerPart.every((r, i) => i === 0 || payerPart[i - 1].__total >= r.__total));
  pass("  Card3 residuals are pinned last",
    ins.rows.slice(payerPart.length).every((r) => residualNames.includes(r.full)),
    `tail=${ins.rows.slice(payerPart.length).map((r) => r.full).join(",")}`);
  pass("  Card3 drops only zero-record payers",
    ins.rows.every((r) => r.__total > 0));

  const suppressed = summary.byInsurance.columns
    .filter((c) => (summary.byInsurance.totals.counts[c] ?? 0) === 0);
  console.log(`  suppressed (zero records everywhere), ${suppressed.length}: ${suppressed.join(", ") || "none"}`);
  console.log(`  row order: ${ins.rows.map((r) => `${r.name}(${r.__total})`).join(" > ")}`);
  console.log(`  chart height: ${insuranceChartHeight(ins.rows.length)}px`);

  // --- Card 4 ---------------------------------------------------------------
  const org = buildOriginChart(summary);
  console.log(`\nCard 4 — Location x Origin: ${org.rows.length} rows, ${org.series.length} series`);
  console.log(`  series: ${org.series.map((s) => s.label).join(" | ")}`);
  checkSpec("Card4", org, summary.byOrigin.totals.total);
  pass("  Card4 renders every location (no location omitted)",
    org.rows.length === summary.locations.length);

  // --- PHI: no raw stored value may reach an axis label, legend or tooltip ---
  const CANON = new Set<string>(summary.byInsurance.columns);
  const allowed = new Set<string>([
    ...residualNames, ...summary.locations.map((l) => l.label),
  ]);
  const rendered = [
    ...ins.rows.map((r) => r.full), ...ins.series.map((s) => s.label),
    ...svc.rows.map((r) => r.full), ...svc.series.map((s) => s.label),
    ...org.rows.map((r) => r.full), ...org.series.map((s) => s.label),
  ];
  const serviceLabels = new Set(Object.values(summary.byServiceType.labels));
  const originLabels = new Set(Object.values(summary.byOrigin.labels));
  const strays = rendered.filter((v) =>
    !CANON.has(v) && !allowed.has(v) && !serviceLabels.has(v) && !originLabels.has(v));
  pass("  no non-canonical string reaches an axis label, legend or tooltip title",
    strays.length === 0, strays.join(" | "));
  const phi = rendered.filter((v) => /\bDOB\b|\d{1,2}\/\d{1,2}\/(19|20)\d{2}|@/.test(v));
  pass("  no PHI-shaped string in any rendered chart label", phi.length === 0, phi.join(" | "));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
