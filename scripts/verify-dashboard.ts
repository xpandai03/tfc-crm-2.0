/**
 * Dashboard reconciliation self-checks.
 *
 * Runs the REAL pivotDashboard() from server/dashboard/db.ts against a snapshot
 * of real grouped production rows, so the checks exercise production code rather
 * than a reimplementation that could agree with itself while both are wrong.
 *
 *   fly ssh console -a tfc-crm-2-0 -C "node -e '<the DASHBOARD_GROUP_SQL query>'"  > groups.json
 *   npx tsx scripts/verify-dashboard.ts groups.json
 *
 * Read-only. Touches no database.
 */

import { readFileSync } from "fs";
import { pivotDashboard } from "../server/dashboard/db";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/verify-dashboard.ts <grouped-rows.json>");
  process.exit(1);
}
const rows = JSON.parse(readFileSync(path, "utf8"));

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
};

for (const population of ["active", "all"] as const) {
  const s = pivotDashboard(rows, population);
  console.log(`\n${"=".repeat(72)}\npopulation=${population}\n${"=".repeat(72)}`);

  // --- 1 + 2: reference reconciliation -------------------------------------
  check("totals.all", s.totals.all, 1222);
  check("totals.active", s.totals.active, 217);
  check("totals.pipeline", s.totals.pipeline, 212);
  check("totals.otherActive", s.totals.otherActive, 5);
  check("pipeline + otherActive == active", s.totals.pipeline + s.totals.otherActive, s.totals.active);
  check("totals.counted", s.totals.counted, population === "active" ? 217 : 1222);

  // --- 1: every row reconciles ---------------------------------------------
  check("dataQuality.unreconciledRows", s.dataQuality.unreconciledRows.length, 0);
  if (s.dataQuality.unreconciledRows.length) console.log(s.dataQuality.unreconciledRows);

  // Column totals equal the sum of their rows, for every card.
  const sumBy = <T>(arr: T[], f: (t: T) => number) => arr.reduce((a, x) => a + f(x), 0);
  check("byStatus col pipeline == sum(rows)", s.byStatus.totals.pipeline, sumBy(s.byStatus.rows, (r) => r.pipeline));
  check("byServiceType col total == sum(rows)", s.byServiceType.totals.total, sumBy(s.byServiceType.rows, (r) => r.total));
  check("byInsurance col total == sum(rows)", s.byInsurance.totals.total, sumBy(s.byInsurance.rows, (r) => r.total));
  check("byOrigin col total == sum(rows)", s.byOrigin.totals.total, sumBy(s.byOrigin.rows, (r) => r.total));

  // Each card counts exactly the selected population.
  const counted = population === "active" ? 217 : 1222;
  check("byServiceType counts population", s.byServiceType.totals.total, counted);
  check("byInsurance counts population", s.byInsurance.totals.total, counted);
  check("byOrigin counts population", s.byOrigin.totals.total, counted);

  // --- 3: byOrigin per-location distribution -------------------------------
  console.log("\n  byOrigin rows:");
  for (const r of s.byOrigin.rows) {
    console.log(
      `    ${r.location.padEnd(5)} rfs=${String(r.rfs_form).padStart(4)} ` +
      `fax=${String(r.fax_referral).padStart(3)} legacy=${String(r.legacy_sheet).padStart(4)} total=${String(r.total).padStart(5)}`,
    );
  }
  check("byOrigin totals sum to counted",
    s.byOrigin.totals.rfs_form + s.byOrigin.totals.fax_referral + s.byOrigin.totals.legacy_sheet, counted);

  // --- 6: residual location row --------------------------------------------
  //
  // 260, not the 261 you get by grouping the raw modality_p1 column.
  //
  // getPrimaryModality() falls back to PARSING the legacy `modality` string when
  // p1 is NULL, and exactly one of the 72 null-p1 records carries
  // "In Person - Albuquerque, In Person - Los Lunas" — which resolves to
  // In Person ABQ (first in-person token wins). So that contact is correctly
  // recovered into Albuquerque instead of being dumped in the residual.
  // 292 + 1 = 293 Albuquerque, 261 - 1 = 260 residual, 1,222 overall unchanged.
  // The fallback doing its job is the whole reason it exists.
  const none = s.byStatus.rows.find((r) => r.location === "none")!;
  check("none-location active", none.active, 0);
  check("none-location total (1 recovered by legacy fallback)", none.total, 260);
  check("abq total (includes the recovered record)",
    s.byStatus.rows.find((r) => r.location === "abq")!.total, 293);

  // --- Card detail ----------------------------------------------------------
  console.log("\n  byStatus rows:");
  for (const r of s.byStatus.rows) {
    console.log(
      `    ${r.location.padEnd(5)} wl=${String(r.waitlist).padStart(4)} pend=${String(r.pending).padStart(3)} ` +
      `sch=${String(r.scheduled).padStart(3)} other=${String(r.otherActive).padStart(3)} ` +
      `pipe=${String(r.pipeline).padStart(4)} active=${String(r.active).padStart(4)} ` +
      `inact=${String(r.inactive).padStart(4)} total=${String(r.total).padStart(5)}`,
    );
  }

  console.log("\n  dataQuality:", JSON.stringify({
    nonCanonicalInsurance: s.dataQuality.nonCanonicalInsurance,
    nonCanonicalServiceType: s.dataQuality.nonCanonicalServiceType,
    nullModalityP1: s.dataQuality.nullModalityP1,
  }));
  console.log("  insurance: canonical=" +
    (s.byInsurance.totals.total - s.byInsurance.totals.other - s.byInsurance.totals.unknown) +
    " other=" + s.byInsurance.totals.other + " unknown=" + s.byInsurance.totals.unknown);
  console.log("  serviceType:", JSON.stringify(s.byServiceType.totals.counts),
    "other=" + s.byServiceType.totals.other, "unknown=" + s.byServiceType.totals.unknown);
  if (population === "active") {
    // Count only — never the raw values (free-text field, contains PHI).
    console.log("  insurance distinct unmapped spellings:",
      s.byInsurance.otherSummary.distinctValues);
    const zero = s.byInsurance.columns.filter((c) => s.byInsurance.totals.counts[c] === 0);
    console.log(`  canonical insurance columns with zero records (${zero.length}):`, JSON.stringify(zero));
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
