/**
 * Aug 26 review self-checks: scoped cross-tabs + the new Card 5.
 * Runs the REAL pivot and the REAL chart builders against production rows.
 */
import { readFileSync } from "fs";
import { pivotDashboard } from "../server/dashboard/db";
import {
  buildStatusChart, buildServiceTypeChart, buildInsuranceChart,
  buildOriginChart, buildServiceTypeInsuranceChart,
} from "../client/src/lib/dashboard-charts";
import type { DashboardSummary, CardScope } from "../client/src/lib/dashboard-api";

const rows = JSON.parse(readFileSync(process.argv[2], "utf8"));
let fail = 0;
const chk = (l: string, a: unknown, e: unknown) => {
  const ok = a === e; if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}: ${a}${ok ? "" : ` (expected ${e})`}`);
};
const ok = (l: string, c: boolean, d = "") => {
  if (!c) fail++; console.log(`${c ? "PASS" : "FAIL"}  ${l}${!c && d ? ` — ${d}` : ""}`);
};

const summary = pivotDashboard(rows, "active") as unknown as DashboardSummary;

// Expectations are DERIVED from the payload, not hardcoded: production data
// moves between runs (staff work the waitlist), and a check pinned to a stale
// snapshot fails for the wrong reason. The byte-identical hash of the existing
// keys is what proves the pivot itself is unchanged.
console.log("=== totals (relational) ===");
chk("pipeline + otherActive == active",
  summary.totals.pipeline + summary.totals.otherActive, summary.totals.active);
console.log(`  active=${summary.totals.active} pipeline=${summary.totals.pipeline} ` +
  `otherActive=${summary.totals.otherActive} all=${summary.totals.all}`);

for (const scope of ["pipeline", "waitlist"] as CardScope[]) {
  const set = summary.scopes[scope];
  console.log(`\n=== scope=${scope}  counted=${set.counted} ===`);
  // The scope must count exactly what Card 1 says that scope contains.
  const expected = scope === "pipeline"
    ? summary.byStatus.totals.pipeline
    : summary.byStatus.totals.waitlist;
  chk(`  counted == byStatus ${scope}`, set.counted, expected);

  for (const [name, tot] of [
    ["byServiceType", set.byServiceType.totals],
    ["byInsurance", set.byInsurance.totals],
  ] as const) {
    chk(`  ${name} total == counted`, tot.total, set.counted);
  }
  chk("  byOrigin total == counted", set.byOrigin.totals.total, set.counted);
  chk("  byServiceTypeInsurance total == counted",
    set.byServiceTypeInsurance.totals.total, set.counted);

  // Card 5 row reconciliation
  const sti = set.byServiceTypeInsurance;
  for (const r of sti.rows) {
    const sum = sti.columns.reduce((a, c) => a + (r.counts[c] ?? 0), 0) + r.other + r.unknown;
    ok(`  Card5 "${r.label}" segments sum to row total`, sum === r.total,
      `cells=${sum} total=${r.total}`);
  }
  console.log(`  Card5 rows: ${sti.rows.map((r) => `${r.label}=${r.total}`).join("  ")}`);
  console.log(`  Card5 other=${sti.totals.other} unknown=${sti.totals.unknown}`);

  // Every chart spec reconciles against its own rows
  const specs = {
    Card2: buildServiceTypeChart(summary, set),
    Card3: buildInsuranceChart(summary, set),
    Card4: buildOriginChart(summary, set),
    Card5: buildServiceTypeInsuranceChart(set),
  };
  for (const [label, spec] of Object.entries(specs)) {
    let bad = 0;
    for (const row of spec.rows) {
      const sum = spec.series.reduce((a, s) => a + Number(row[s.key] ?? 0), 0);
      if (sum !== row.__total) bad++;
    }
    ok(`  ${label} every chart row sums to its total`, bad === 0, `${bad} row(s) off`);
  }
}

// Card 1 chart (status-stacked)
console.log("\n=== Card 1 (stacked by status) ===");
const c1 = buildStatusChart(summary);
console.log(`  series: ${c1.series.map((s) => s.label).join(" | ")}`);
for (const row of c1.rows) {
  const sum = c1.series.reduce((a, s) => a + Number(row[s.key] ?? 0), 0);
  ok(`  "${row.full}" segments sum to active total`, sum === row.__total,
    `cells=${sum} active=${row.__total}`);
}
chk("  Card1 rows sum to active",
  c1.rows.reduce((a, r) => a + r.__total, 0), summary.totals.active);

// PHI: nothing but canonical labels may reach a chart surface
console.log("\n=== PHI: chart surfaces carry no stored value ===");
const CANON = new Set(summary.byInsurance.columns);
const allowed = new Set<string>([
  "Other / Unmapped", "Not recorded",
  ...summary.locations.map((l) => l.label),
  ...Object.values(summary.byServiceType.labels),
  ...Object.values(summary.byOrigin.labels),
  ...Object.values(summary.byStatus.labels),
]);
const set = summary.scopes.pipeline;
const rendered = [
  ...buildServiceTypeChart(summary, set).rows.map((r) => r.full),
  ...buildServiceTypeChart(summary, set).series.map((s) => s.label),
  ...buildInsuranceChart(summary, set).rows.map((r) => r.full),
  ...buildInsuranceChart(summary, set).series.map((s) => s.label),
  ...buildOriginChart(summary, set).rows.map((r) => r.full),
  ...buildOriginChart(summary, set).series.map((s) => s.label),
  ...buildServiceTypeInsuranceChart(set).rows.map((r) => r.full),
  ...buildServiceTypeInsuranceChart(set).series.map((s) => s.label),
  ...c1.rows.map((r) => r.full), ...c1.series.map((s) => s.label),
];
const strays = rendered.filter((v) => !CANON.has(v) && !allowed.has(v));
ok("  no non-canonical string on any chart surface", strays.length === 0, strays.join(" | "));
ok("  no PHI-shaped string on any chart surface",
  !rendered.some((v) => /\bDOB\b|\d{1,2}\/\d{1,2}\/(19|20)\d{2}|@/.test(v)));

console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
