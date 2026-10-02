/**
 * The monthly email's "referrals received" and the Insights "Referrals in
 * [month]" card count the same rows, on a fixture that straddles two month
 * boundaries in Mountain time and carries test rows.
 *
 * September 2026 read 150 by email against 144 on Insights. The gap was 6
 * ZZTEST submissions: Insights dropped them and the monthly report had no
 * test-row rule. A second, latent gap: date_added was stamped as the UTC day,
 * so an evening referral on the last day of a month fell into the next month's
 * email while Insights (Mountain-bounded) kept it in this one.
 *
 * Part 1 needs no database. Part 2 writes rows. Run it ONLY against a
 * throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55436/tfc_reportstest RUN_MIGRATIONS=true \
 *     npx tsx --tsconfig tsconfig.test.json scripts/test-referral-count-agreement.ts
 *
 * NO PHI: ZZTEST and "Example" names only.
 */

import { referralDateFor } from "../server/sync/db";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// ===========================================================================
console.log("\n[1] date_added is the Mountain day, not the UTC day");
eq("Sept 30 11pm MDT is Sept 30 (the UTC day is Oct 1)",
  referralDateFor(new Date("2026-10-01T05:00:00Z")), "2026-09-30");
eq("Oct 31 11:30pm MDT is Oct 31 (the UTC day is Nov 1)",
  referralDateFor(new Date("2026-10-31T23:30:00-06:00")), "2026-10-31");
eq("Nov 30 10pm MST is Nov 30 (after DST ends)",
  referralDateFor(new Date("2026-12-01T05:00:00Z")), "2026-11-30");
eq("Oct 1 00:30 MDT is Oct 1",
  referralDateFor(new Date("2026-10-01T06:30:00Z")), "2026-10-01");

// ===========================================================================
interface Row {
  id: number; at: string; submitted: string; contactName: string;
  source: "rfs_v2" | "uploaded_referral"; status: number;
}
// Instants are written in Mountain wall-clock with their offset.
const FIXTURE: Row[] = [
  // Sept 30, 11pm MT: September on both. The old UTC stamp said October.
  { id: 990301, at: "2026-09-30T23:00:00-06:00", submitted: "Example One", contactName: "Example One", source: "rfs_v2", status: 100 },
  // A test row in September. History: the email still counts it (see [3]).
  { id: 990302, at: "2026-09-10T12:00:00-06:00", submitted: "ZZTEST Sept", contactName: "ZZTEST Sept", source: "rfs_v2", status: 100 },
  { id: 990303, at: "2026-10-01T00:30:00-06:00", submitted: "Example Two", contactName: "Example Two", source: "rfs_v2", status: 101 },
  // Staff-uploaded, since closed: in on both.
  { id: 990304, at: "2026-10-15T12:00:00-06:00", submitted: "Example Three", contactName: "Example Three", source: "uploaded_referral", status: 500 },
  // Oct 31, 11:30pm MT: October on both. The old UTC stamp said November.
  { id: 990305, at: "2026-10-31T23:30:00-06:00", submitted: "Example Four", contactName: "Example Four", source: "rfs_v2", status: 100 },
  { id: 990306, at: "2026-10-20T09:00:00-06:00", submitted: "ZZTEST Oct", contactName: "ZZTEST Oct", source: "rfs_v2", status: 100 },
  // Submitted as ZZTEST, then renamed by staff: still a test row.
  { id: 990307, at: "2026-10-21T09:00:00-06:00", submitted: "ZZTEST Renamed", contactName: "Example Renamed test", source: "rfs_v2", status: 204 },
  // A test row on the Oct/Nov boundary.
  { id: 990308, at: "2026-10-31T22:00:00-06:00", submitted: "ZZTEST Boundary", contactName: "ZZTEST Boundary", source: "rfs_v2", status: 100 },
  { id: 990309, at: "2026-11-01T00:30:00-06:00", submitted: "Example Five", contactName: "Example Five", source: "rfs_v2", status: 100 },
];

async function dbPart() {
  const url = process.env.DATABASE_URL ?? "";
  if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_reportstest/.test(url))) {
    console.log("\n[2-3] SKIPPED: set DATABASE_URL to the throwaway local tfc_reportstest database to run them.");
    return;
  }
  const { getPool } = await import("../server/db/pool");
  const db = await import("../server/sync/db");
  const { buildMonthlyReport, resolvePeriod } = await import("../server/reports/monthly");

  await db.initSyncTables();
  const pool = getPool();
  const IDS = FIXTURE.map((r) => r.id);
  const wipe = async () => {
    await pool.query(`DELETE FROM form_submissions WHERE contact_id = ANY($1)`, [IDS]);
    await pool.query(`DELETE FROM sync_contacts WHERE contact_id = ANY($1)`, [IDS]);
  };
  await wipe();

  // As /api/intake writes them: the submission, then the contact pointing at it.
  for (const r of FIXTURE) {
    const at = new Date(r.at);
    const sub = await pool.query(
      `INSERT INTO form_submissions (source, form_type, contact_id, name, payload, created_at)
       VALUES ($1, 'intake', $2, $3, '{}', $4) RETURNING id`,
      [r.source, r.id, r.submitted, at.toISOString()],
    );
    await pool.query(
      `INSERT INTO sync_contacts (contact_id, name, status_code, date_added, intake_source, source_submission_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.id, r.contactName, r.status, referralDateFor(at),
        r.source === "uploaded_referral" ? "uploaded_referral" : "website_form", sub.rows[0].id],
    );
  }

  const insights = async (period: string) => {
    const { start, endExclusive } = resolvePeriod(period);
    return db.getReferralsCount(start, endExclusive);
  };
  const email = async (period: string) => (await buildMonthlyReport(period)).cohort.size;

  console.log("\n[2] From October 2026 the email and Insights count the same rows");
  for (const [period, expected] of [["2026-10", 3], ["2026-11", 1]] as const) {
    const [i, e] = [await insights(period), await email(period)];
    eq(`${period}: Insights counts ${expected}`, i, expected);
    eq(`${period}: the email agrees with Insights`, e, i);
  }

  console.log("\n[3] A report already sent does not change");
  eq("2026-09: Insights leaves out the September test row", await insights("2026-09"), 1);
  eq("2026-09: the email still counts it, as it did when it was sent", await email("2026-09"), 2);

  await wipe();
  await pool.end();
}

dbPart()
  .then(() => {
    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
    if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
  })
  .catch((e) => { console.error(e); process.exit(1); });
