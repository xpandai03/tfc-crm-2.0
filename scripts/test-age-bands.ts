/**
 * Self-checks — the Minor / Adolescent split.
 *
 * Run: npx tsx scripts/test-age-bands.ts
 *
 * NO PHI. Every date of birth below is invented for this file.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import {
  AGE_BANDS, AGE_BAND_ADOLESCENT, AGE_BAND_ADULT, AGE_BAND_MINOR, AGE_BAND_UNKNOWN,
  AGE_BASIS_NOTE, ageAsOf, ageBandAsOf, bandForAge, bandedServiceType,
  canonicalDobIso, isChildServiceType,
} from "../shared/age-bands";
import { SERVICE_TYPES } from "../shared/service-types";
import {
  DASHBOARD_GROUP_SQL, SERVICE_TYPE_COLUMNS, SERVICE_TYPE_LABELS, pivotDashboard,
} from "../server/dashboard/db";
import { assembleMonthlyReport, COHORT_SQL, type CohortRow } from "../server/reports/monthly";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// ===========================================================================
console.log("\n[1] The duplicate service-type list now reads from the shared constant");
const rbSrc = readFileSync(join(process.cwd(), "client", "src", "components", "report-builder-modal.tsx"), "utf8");
ok("it imports the shared constant", rbSrc.includes('import { SERVICE_TYPES } from "@shared/service-types"'));
ok("it defines no local copy", !/const SERVICE_TYPES = \[/.test(rbSrc));
ok("no literal service-type strings remain in it",
  !/"My Child"|"My Partner & Myself"|"My Family"/.test(rbSrc));
eq("the shared constant is unchanged — still the same five, in order",
  [...SERVICE_TYPES],
  ["Myself", "My Child", "My Partner & Myself", "My Family", "Other"]);

// ===========================================================================
console.log("\n[2] Boundaries: 13 Minor, 14 Adolescent, 17 Adolescent, 18 is 18+");
for (const [age, want] of [
  [0, AGE_BAND_MINOR], [12, AGE_BAND_MINOR], [13, AGE_BAND_MINOR],
  [14, AGE_BAND_ADOLESCENT], [16, AGE_BAND_ADOLESCENT], [17, AGE_BAND_ADOLESCENT],
  [18, AGE_BAND_ADULT], [19, AGE_BAND_ADULT], [64, AGE_BAND_ADULT],
] as [number, string][]) {
  eq(`  age ${age} -> ${want}`, bandForAge(age), want);
}
eq("  a null age is unknown", bandForAge(null), AGE_BAND_UNKNOWN);
// The client's wording: "It's 14 until they turn 18."
ok("every age 14..17 is Adolescent and nothing else is",
  [14, 15, 16, 17].every((a) => bandForAge(a) === AGE_BAND_ADOLESCENT)
  && [13, 18].every((a) => bandForAge(a) !== AGE_BAND_ADOLESCENT));

console.log("\n[2b] The reference date is a parameter, and dates are compared as dates");
eq("age at a reference date, before the birthday", ageAsOf("2012-07-01", "2026-06-30"), 13);
eq("age ON the birthday counts the year", ageAsOf("2012-07-01", "2026-07-01"), 14);
eq("age the day after", ageAsOf("2012-07-01", "2026-07-02"), 14);
eq("...and the band flips exactly there",
  [ageBandAsOf("2012-07-01", "2026-06-30"), ageBandAsOf("2012-07-01", "2026-07-01")],
  [AGE_BAND_MINOR, AGE_BAND_ADOLESCENT]);
// EDGE CASE from the brief: a birthday falling exactly on the referral date.
eq("a child turning 14 ON their referral date is an Adolescent in that report",
  ageBandAsOf("2012-03-15", "2026-03-15"), AGE_BAND_ADOLESCENT);
eq("a child turning 18 ON their referral date is 18+",
  ageBandAsOf("2008-03-15", "2026-03-15"), AGE_BAND_ADULT);
// A timestamp is truncated to its calendar date, so a reader's clock time
// cannot move a child across a boundary.
eq("a timestamp on the birthday still counts the year",
  ageAsOf("2012-07-01", "2026-07-01T23:59:59Z"), ageAsOf("2012-07-01", "2026-07-01T00:00:01Z"));
eq("a Date object works too", ageAsOf("2012-07-01", new Date(2026, 6, 1)), 14);
eq("omitting the reference date means today",
  ageAsOf("2012-07-01"), ageAsOf("2012-07-01", new Date()));
// Formats actually present in patient_dob.
eq("ISO", canonicalDobIso("2012-07-01"), "2012-07-01");
eq("ISO with a time", canonicalDobIso("2012-07-01T00:00:00Z"), "2012-07-01");
eq("M/D/YYYY", canonicalDobIso("7/1/2012"), "2012-07-01");
eq("M-D-YYYY", canonicalDobIso("7-1-2012"), "2012-07-01");
eq("YYYY/MM/DD", canonicalDobIso("2012/07/01"), "2012-07-01");
for (const bad of ["", "   ", "not a date", "13/45/2012", "12-07-01", "2012-02-30"]) {
  eq(`  ${JSON.stringify(bad)} is unreadable`, canonicalDobIso(bad), null);
}
eq("an unreadable DOB gives an unknown band", ageBandAsOf("nope"), AGE_BAND_UNKNOWN);

console.log("\n[2c] Only 'My Child' is banded — every other service type passes through");
for (const st of ["Myself", "My Partner & Myself", "My Family", "Other", "Some Legacy Value"]) {
  eq(`  ${st} unchanged`, bandedServiceType(st, "2012-07-01", "2026-08-15"), st);
}
eq("My Child bands", bandedServiceType("My Child", "2012-07-01", "2026-08-15"), AGE_BAND_ADOLESCENT);
ok("the stray spellings already in the data band too",
  isChildServiceType("My-Child") && isChildServiceType("my child") && isChildServiceType("My  Child"));
eq("a child row with no readable DOB keeps its stored value, so totals still reconcile",
  bandedServiceType("My Child", null), "My Child");

// ===========================================================================
console.log("\n[3] A past month's report is identical when re-run later");
// A cohort of one child, referred in August aged 13, who turns 14 in September.
const AUG_ROWS: CohortRow[] = [{
  modality_p1: "Telehealth", modality: "Telehealth", status_code: 102,
  requesting_for: "My Child", intake_source: "rfs_form",
  patient_dob: "2012-09-20", date_added: "2026-08-15",
  legacy_sheet: false, n: 1,
}];
const emptySnapshot = pivotDashboard([], "active", 0);
const runAug = () => assembleMonthlyReport("2026-08", emptySnapshot, AUG_ROWS, 0);

const realNow = Date.now;
const inAugust = runAug();
// Simulate re-running the SAME period months later, after the child's birthday.
// Date.now is moved so anything reading "today" would notice; the report must not.
(Date as unknown as { now: () => number }).now = () => new Date("2026-12-20T12:00:00Z").getTime();
const globalDate = globalThis.Date;
class FrozenDate extends globalDate {
  constructor(...args: unknown[]) {
    // @ts-expect-error - forwarding a variadic Date constructor
    if (args.length === 0) super("2026-12-20T12:00:00Z"); else super(...args);
  }
  static now() { return new globalDate("2026-12-20T12:00:00Z").getTime(); }
}
(globalThis as unknown as { Date: unknown }).Date = FrozenDate;
const inDecember = runAug();
(globalThis as unknown as { Date: unknown }).Date = globalDate;
(Date as unknown as { now: () => number }).now = realNow;

ok("the simulated clock really did move",
  new FrozenDate().getUTCFullYear() === 2026 && FrozenDate.now() > new globalDate("2026-11-01").getTime());
eq("the child counted as a Minor in August, run in August",
  inAugust.cohort.byServiceType.counts[AGE_BAND_MINOR], 1);
eq("...and STILL a Minor when August is re-run in December",
  inDecember.cohort.byServiceType.counts[AGE_BAND_MINOR], 1);
eq("...never reclassified as an Adolescent",
  inDecember.cohort.byServiceType.counts[AGE_BAND_ADOLESCENT], 0);
eq("the whole service-type breakdown is byte-identical across the two runs",
  inAugust.cohort.byServiceType, inDecember.cohort.byServiceType);
// And the control: banding by TODAY would have moved it, which is what this proves.
eq("(control) the same child banded by today's date IS an Adolescent now",
  ageBandAsOf("2012-09-20", "2026-12-20"), AGE_BAND_ADOLESCENT);
ok("the cohort query carries both stored inputs",
  COHORT_SQL.includes("patient_dob") && COHORT_SQL.includes("date_added"));

// ===========================================================================
console.log("\n[4] The dashboard's reconciliation invariant holds with three new columns");
eq("Child is gone; Minor / Adolescent / 18+ took its place, order preserved",
  [...SERVICE_TYPE_COLUMNS],
  ["Myself", AGE_BAND_MINOR, AGE_BAND_ADOLESCENT, AGE_BAND_ADULT, "My Partner & Myself", "My Family"]);
ok("every column has a label", SERVICE_TYPE_COLUMNS.every((c) => !!SERVICE_TYPE_LABELS[c]));
ok("the untouched service types keep their labels",
  SERVICE_TYPE_LABELS["Myself"] === "Individual"
  && SERVICE_TYPE_LABELS["My Partner & Myself"] === "Couple"
  && SERVICE_TYPE_LABELS["My Family"] === "Family");
ok("the dashboard query carries the date of birth", DASHBOARD_GROUP_SQL.includes("patient_dob"));

// Rows exercising every band plus the residual paths, through the REAL pivot.
const gr = (over: Partial<Record<string, unknown>>) => ({
  modality_p1: "Telehealth", modality: "Telehealth", status_code: 102,
  requesting_for: "Myself", insurance_payer: "Aetna", intake_source: "rfs_form",
  patient_dob: null, legacy_sheet: false, n: 1, ...over,
}) as never;
const DASH_ROWS = [
  gr({ requesting_for: "My Child", patient_dob: "2015-01-01", n: 5 }),   // Minor
  gr({ requesting_for: "My Child", patient_dob: "2010-01-01", n: 3 }),   // Adolescent
  gr({ requesting_for: "My Child", patient_dob: "2004-01-01", n: 2 }),   // 18+
  gr({ requesting_for: "My Child", patient_dob: "garbage", n: 1 }),      // -> other
  gr({ requesting_for: "Myself", n: 7 }),
  gr({ requesting_for: "My Family", n: 2 }),
  gr({ requesting_for: "Legacy Value", n: 1 }),                          // -> other
  gr({ requesting_for: null, n: 4 }),                                    // -> unknown
];
const summary = pivotDashboard(DASH_ROWS, "all", 0);
eq("the pivot reports no reconciliation failures", summary.diagnostics?.unreconciled ?? [], []);
const svc = summary.byServiceType;
const cellSum = svc.columns.reduce((a, c) => a + (svc.totals.counts[c] ?? 0), 0)
  + svc.totals.other + svc.totals.unknown;
eq("cells + other + unknown === total", cellSum, svc.totals.total);
eq("every row of 25 is accounted for", svc.totals.total, 25);
eq("  Minor", svc.totals.counts[AGE_BAND_MINOR], 5);
eq("  Adolescent", svc.totals.counts[AGE_BAND_ADOLESCENT], 3);
eq("  18+", svc.totals.counts[AGE_BAND_ADULT], 2);
eq("  Individual untouched", svc.totals.counts["Myself"], 7);
eq("  Family untouched", svc.totals.counts["My Family"], 2);
eq("  other = unreadable-DOB child + legacy value", svc.totals.other, 2);
eq("  unknown = blank service type", svc.totals.unknown, 4);
ok("the three bands partition exactly what Child covered",
  (svc.totals.counts[AGE_BAND_MINOR] + svc.totals.counts[AGE_BAND_ADOLESCENT]
    + svc.totals.counts[AGE_BAND_ADULT]) === 10);

// ===========================================================================
console.log("\n[5] The drill-down and the waitlist agree, by construction");
const wlSrc = readFileSync(join(process.cwd(), "client", "src", "components", "waitlist", "waitlist-list-view.tsx"), "utf8");
ok("the waitlist filter compares the BANDED value, not the stored string",
  wlSrc.includes("bandedServiceType(c.requestingFor, c.patientDob) !== serviceTypeFilter"));
ok("it no longer compares requestingFor directly",
  !/requestingFor !== serviceTypeFilter/.test(wlSrc));
ok("both use the same reference date (today) — neither passes one",
  !/bandedServiceType\([^)]*,[^)]*,[^)]*\)/.test(wlSrc));
const wlPage = readFileSync(join(process.cwd(), "client", "src", "pages", "waitlist.tsx"), "utf8");
ok("a saved view holding a band survives a restore",
  wlPage.includes("...SERVICE_TYPES, ...AGE_BANDS"));
// The drill-down builds ?serviceType=<column key>. Every new column key must be
// a value the waitlist filter can actually match.
for (const band of AGE_BANDS) {
  ok(`  the ${band} column key is a filterable value`,
    SERVICE_TYPE_COLUMNS.includes(band) && (AGE_BANDS as readonly string[]).includes(band));
}
const colSrc = readFileSync(join(process.cwd(), "client", "src", "components", "waitlist", "waitlist-columns.tsx"), "utf8");
ok("the waitlist Service column shows the band", colSrc.includes("bandedServiceType(contact.requestingFor, contact.patientDob)"));

// ===========================================================================
console.log("\n[7] Nothing is stored, and no other service type moved");
const dbSrc = readFileSync(join(process.cwd(), "server", "dashboard", "db.ts"), "utf8");
const monthlySrc = readFileSync(join(process.cwd(), "server", "reports", "monthly.ts"), "utf8");
const syncSrc = readFileSync(join(process.cwd(), "server", "sync", "db.ts"), "utf8");
for (const [label, src] of [["dashboard", dbSrc], ["monthly", monthlySrc]] as const) {
  ok(`  ${label} issues no write to sync_contacts`,
    !/(UPDATE|INSERT INTO|DELETE FROM)\s+sync_contacts/i.test(src));
}
ok("no migration file was added",
  execSync("git status --porcelain migrations/", { encoding: "utf8" }).trim() === "");
ok("shared/service-types.ts is untouched",
  execSync("git diff --name-only HEAD -- shared/service-types.ts", { encoding: "utf8" }).trim() === "");
ok("normalizeServiceType is untouched — stored values still fold as before",
  syncSrc.includes('if (req === "my child" || svc === "my child") return "My Child";'));

console.log("\n[9] The referral CSV's existing columns are frozen");
ok("the Age Bucket column keeps its old wording",
  syncSrc.includes('if (age < 14) return "Child (<14)";')
  && syncSrc.includes('return "Adult (18+)";'));
ok("the new banding ships as a SEPARATE column",
  syncSrc.includes('"Service Type (age at referral)"'));
ok("the new column names its basis in its heading",
  /"Service Type \(age at referral\)"/.test(syncSrc));
ok("the plain Service Type column is unchanged", syncSrc.includes('"Service Type": serviceType,'));

console.log("\n[label] Each surface states its basis");
ok("the referral note says numbers do not move", /do not change when this is re-run/.test(AGE_BASIS_NOTE.referral));
ok("the today note says today", /today/.test(AGE_BASIS_NOTE.today));
ok("the dashboard card says 'today'",
  readFileSync(join(process.cwd(), "client", "src", "pages", "dashboard.tsx"), "utf8")
    .includes("worked out from each child's age today"));
ok("the monthly report HTML carries the referral note",
  readFileSync(join(process.cwd(), "server", "reports", "render.ts"), "utf8")
    .includes("AGE_BASIS_NOTE.referral"));
ok("the dashboard export legend carries the today note",
  readFileSync(join(process.cwd(), "server", "dashboard", "export.ts"), "utf8")
    .includes("AGE_BASIS_NOTE.today"));

console.log("\n[10] No PHI anywhere new");
for (const [label, src] of [["age-bands", readFileSync(join(process.cwd(), "shared", "age-bands.ts"), "utf8")]] as const) {
  ok(`  ${label} performs no I/O and logs nothing`, !/console\.|fetch\(|getPool/.test(src));
}
for (const [label, src] of [["dashboard", dbSrc], ["monthly", monthlySrc], ["sync", syncSrc]] as const) {
  const added = execSync(`git diff HEAD -- ${label === "dashboard" ? "server/dashboard/db.ts" : label === "monthly" ? "server/reports/monthly.ts" : "server/sync/db.ts"}`, { encoding: "utf8" })
    .split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const logs = added.filter((l) => /console\.(log|warn|error)/.test(l));
  ok(`  ${label}: no new log line at all (${logs.length} added)`, logs.length === 0);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
