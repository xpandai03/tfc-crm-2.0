/**
 * "Show on survey" against a real database (2026-10-21): the column is added
 * at boot defaulting to shown; Angelica Villicana is hidden once with one
 * activity line; a second boot is a no-op; re-ticking her in the UI is never
 * undone by a reboot; the migration file does the same as boot; the public
 * roster and the period data the snapshot/export share respect the flag.
 *
 * Writes rows. Run ONLY against a throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55442/tfc_visibilitytest \
 *     npx tsx --tsconfig tsconfig.test.json scripts/test-survey-visibility-db.ts
 *
 * NO PHI: provider names are staff names; every client is a ZZTEST name.
 */

import { readFileSync } from "fs";

const url = process.env.DATABASE_URL ?? "";
if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_visibilitytest/.test(url))) {
  console.error("REFUSING TO RUN: point DATABASE_URL at the throwaway local database (127.0.0.1/localhost, tfc_visibilitytest).");
  process.exit(2);
}

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

async function main() {
  const { getPool } = await import("../server/db/pool");
  const db = await import("../server/sync/db");
  const { initActivityTable } = await import("../server/activity/db");
  const { initRemindersTable, getAllCrmProviders, updateCrmProvider } = await import("../server/reminders/db");
  const { applyVillicanaHidden } = await import("../server/survey/villicana-hidden");
  const { getPublicProviderRoster } = await import("../server/survey/roster");
  const { loadSurveyPeriodData } = await import("../server/survey/export");
  const { initActiveCountsTable } = await import("../server/therapy-notes/active-counts-db");
  const { initActiveCountOverridesTable } = await import("../server/survey/active-count-overrides-db");

  const pool = getPool();
  const PROVIDERS = ["Angelica Villicana", "Kennedy Hull", "Angelica Chavez"];
  await initActivityTable();
  await db.initSyncTables();
  await initActiveCountsTable();
  await initActiveCountOverridesTable();
  // A database from before the flag: the column must be added by boot.
  await pool.query(`ALTER TABLE IF EXISTS crm_providers DROP COLUMN IF EXISTS show_on_survey`);
  await initRemindersTable();

  await pool.query(`DELETE FROM form_submissions WHERE name LIKE 'ZZTEST%'`);
  await pool.query(`DELETE FROM activity_log WHERE type = 'provider_survey_visibility_set'`);
  await pool.query(`DELETE FROM crm_providers WHERE name = ANY($1)`, [PROVIDERS]);
  await pool.query(
    `INSERT INTO crm_providers (name, credentials, location, is_active) VALUES
       ('Angelica Villicana', 'LCSW', 'RR', true),
       ('Kennedy Hull', 'LPCC', 'ABQ', true),
       ('Angelica Chavez', 'LCSW', 'ABQ', true)`,
  );
  const flag = async (name: string) =>
    (await pool.query(`SELECT show_on_survey FROM crm_providers WHERE name = $1`, [name])).rows[0]?.show_on_survey;
  const markers = async () =>
    Number((await pool.query(`SELECT COUNT(*)::int n FROM activity_log WHERE type = 'provider_survey_visibility_set'`)).rows[0].n);

  console.log("\n[1] the column, added at boot");
  eq("existing providers default to shown", await flag("Kennedy Hull"), true);
  eq("…Villicana too, before the one-shot", await flag("Angelica Villicana"), true);

  console.log("\n[2] the one-shot");
  eq("first boot hides her", await applyVillicanaHidden(), "set");
  eq("flag is false", await flag("Angelica Villicana"), false);
  eq("one activity line", await markers(), 1);
  const line = (await pool.query(`SELECT entity_name, metadata FROM activity_log WHERE type = 'provider_survey_visibility_set'`)).rows[0];
  eq("…naming her, from true to false, with the reason",
    [line.entity_name, JSON.parse(line.metadata)], ["Angelica Villicana", { from: true, to: false, reason: "villicana-hidden-2026-10-21" }]);
  eq("everyone else untouched", [await flag("Kennedy Hull"), await flag("Angelica Chavez")], [true, true]);
  eq("second boot: already", await applyVillicanaHidden(), "already");
  eq("…no second line", await markers(), 1);

  console.log("\n[3] the client re-ticks her; a reboot never flips it back");
  const id = (await pool.query(`SELECT id FROM crm_providers WHERE name = 'Angelica Villicana'`)).rows[0].id;
  ok("the edit dialog's save path writes the flag", await updateCrmProvider(id, { showOnSurvey: true }));
  eq("shown again", await flag("Angelica Villicana"), true);
  eq("reboot: already", await applyVillicanaHidden(), "already");
  eq("…she stays shown", await flag("Angelica Villicana"), true);
  ok("…and she is still an active provider everywhere else", (await getAllCrmProviders()).some((p) => p.name === "Angelica Villicana"));

  console.log("\n[4] the migration file does what boot does, once");
  await pool.query(`DELETE FROM activity_log WHERE type = 'provider_survey_visibility_set'`);
  const sql = readFileSync("migrations/add-provider-show-on-survey.sql", "utf8");
  await pool.query(sql);
  eq("hidden by the file", await flag("Angelica Villicana"), false);
  eq("one line", await markers(), 1);
  await updateCrmProvider(id, { showOnSurvey: true });
  await pool.query(sql);
  eq("a second run leaves a re-tick alone", await flag("Angelica Villicana"), true);
  eq("boot after the file: already", await applyVillicanaHidden(), "already");
  await updateCrmProvider(id, { showOnSurvey: false });

  console.log("\n[5] the surfaces read the flag");
  const roster = (await getPublicProviderRoster()).map((e) => e.label);
  ok("survey dropdown: no Villicana", !roster.some((l) => l.startsWith("Angelica Villicana")), JSON.stringify(roster));
  ok("survey dropdown: Hull and Chavez offered", roster.includes("Kennedy Hull (ABQ)") && roster.includes("Angelica Chavez (ABQ)"));
  const nov = await loadSurveyPeriodData({ from: "2031-11-01", to: "2031-11-30" });
  ok("report period with none of her surveys: no row", !nov.aggregate.providers.some((p) => p.name === "Angelica Villicana"));
  const payload = {
    surveyVersion: 3, formVariant: "in-person", modality: "In Person", language: "en",
    submittedAt: "2031-10-02T16:00:00.000Z",
    client: { name: "ZZTEST Person 1" }, answers: { therapist: "Angelica Villicana (RR)", overallRating: 9 },
  };
  await pool.query(
    `INSERT INTO form_submissions (form_type, source, submitted_at, contact_id, name, payload)
     VALUES ('survey', 'client_survey', $1, NULL, $2, $3)`,
    [payload.submittedAt, payload.client.name, JSON.stringify(payload)],
  );
  const oct = await loadSurveyPeriodData({ from: "2031-10-01", to: "2031-10-31" });
  const row = oct.aggregate.providers.find((p) => p.name === "Angelica Villicana");
  ok("report period with her survey: her row and count survive", !!row && row.surveyCount === 1, JSON.stringify(row));

  await pool.query(`DELETE FROM form_submissions WHERE name LIKE 'ZZTEST%'`);
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log(`FAILED: ${failures.join("; ")}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
