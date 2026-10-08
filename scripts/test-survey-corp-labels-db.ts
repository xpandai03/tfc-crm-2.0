/**
 * Corp-only providers, against a real database: the backfill relabels Sandra
 * Rivera's and Amanda Davison's non-Corp surveys CORP with one activity line
 * each and is a no-op the second time; a new survey for a Corp-only provider is
 * stored CORP whatever office it names; Amanda Plotner's two offices are left
 * alone; the snapshot and the export show one Corp row each for the two.
 *
 * Writes rows. Run ONLY against a throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55441/tfc_corplabeltest \
 *     npx tsx --tsconfig tsconfig.test.json scripts/test-survey-corp-labels-db.ts
 *
 * NO PHI: provider names are staff names (the backfill names them); every
 * client is a ZZTEST name with an example.invalid address and invented dates.
 */

import { readFileSync } from "fs";
import { unzipSync, strFromU8 } from "fflate";

const url = process.env.DATABASE_URL ?? "";
if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_corplabeltest/.test(url))) {
  console.error(
    "REFUSING TO RUN. This script writes submissions and providers and must only\n" +
      "point at the throwaway local database (127.0.0.1/localhost, tfc_corplabeltest).",
  );
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

/** The migration file's statement, comments and whitespace aside. */
const normalizeSql = (sql: string) =>
  sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/\s+/g, " ").trim();

async function main() {
  const { getPool } = await import("../server/db/pool");
  const db = await import("../server/sync/db");
  const { initActivityTable } = await import("../server/activity/db");
  const { initRemindersTable } = await import("../server/reminders/db");
  const { initSurveyMatchTable } = await import("../server/survey/match-db");
  const { initActiveCountsTable } = await import("../server/therapy-notes/active-counts-db");
  const { initActiveCountOverridesTable } = await import("../server/survey/active-count-overrides-db");
  const { initTnPatientsTable } = await import("../server/therapy-notes/tn-patients-db");
  const { loadSurveyPeriodData, buildSurveyExport } = await import("../server/survey/export");
  const { renderSurveySnapshot } = await import("../server/survey/snapshot");
  const corp = await import("../server/survey/corp-labels");

  await initRemindersTable();
  await db.initSyncTables();
  await initActivityTable();
  await initSurveyMatchTable();
  await initActiveCountsTable();
  await initActiveCountOverridesTable();
  await initTnPatientsTable();

  const pool = getPool();
  const PROVIDERS = ["Sandra Rivera", "Amanda Davison", "Amanda Plotner", "Zztest Kennedy"];
  await pool.query(`DELETE FROM form_submissions WHERE name LIKE 'ZZTEST%'`);
  await pool.query(`DELETE FROM activity_log WHERE entity_name = 'Client survey'`);
  await pool.query(`DELETE FROM crm_providers WHERE name = ANY($1)`, [PROVIDERS]);
  await pool.query(
    `INSERT INTO crm_providers (name, short_name, location, survey_locations, is_active) VALUES
       ('Sandra Rivera', 'Sandra', 'ABQ', ARRAY['CORP'], true),
       ('Amanda Davison', 'Amanda D', 'ABQ', ARRAY['CORP'], true),
       ('Amanda Plotner', 'Amanda P', 'LL', ARRAY['LL','ABQ'], true),
       ('Zztest Kennedy', 'Kennedy', 'ABQ', NULL, true)`,
  );

  // -------------------------------------------------------------------------
  console.log("\n[0] The boot statement is the migration file");
  eq("CORP_BACKFILL_SQL matches migrations/backfill-corp-survey-labels.sql",
    normalizeSql(corp.CORP_BACKFILL_SQL), normalizeSql(readFileSync("migrations/backfill-corp-survey-labels.sql", "utf8")));

  let n = 0;
  const survey = (therapist: string, day: string) => ({
    surveyVersion: 3, formVariant: "in-person", modality: "In Person", language: "en",
    submittedAt: `${day}T16:00:00.000Z`,
    client: { name: `ZZTEST Person ${++n}`, dateOfBirth: "1985-06-15", email: "zz@example.invalid", phone: "5055550142" },
    answers: { therapist, overallRating: 9, connectionRating: 8 },
  });
  // Historical rows go in AS THEY WERE: straight into the table, past the
  // write-time rule, the way surveys stored before it exist in production.
  const insertRaw = async (therapist: string, day: string, formType = "survey") => {
    const payload = survey(therapist, day);
    const { rows } = await pool.query(
      `INSERT INTO form_submissions (form_type, source, submitted_at, contact_id, name, payload)
       VALUES ($1, 'client_survey', $2, NULL, $3, $4) RETURNING id`,
      [formType, payload.submittedAt, payload.client.name, JSON.stringify(payload)],
    );
    return rows[0].id as number;
  };
  const label = async (id: number) =>
    (await pool.query(`SELECT payload::jsonb->'answers'->>'therapist' AS t FROM form_submissions WHERE id = $1`, [id])).rows[0]?.t;
  const relabelLines = async () =>
    (await pool.query(`SELECT entity_id, entity_name, metadata FROM activity_log WHERE type = 'survey_relabelled' ORDER BY id`)).rows;

  const sAbq1 = await insertRaw("Sandra Rivera (ABQ)", "2026-09-10");
  const sAbq2 = await insertRaw("Sandra Rivera (ABQ)", "2026-10-02");
  const sBare = await insertRaw("Sandra Rivera", "2026-10-03");
  const sCorp = await insertRaw("Sandra Rivera (CORP)", "2026-10-04");
  const dAbq = await insertRaw("amanda  davison (ABQ)", "2026-09-12");
  const dCorpLower = await insertRaw("Amanda Davison (Corp)", "2026-10-05");
  const pAbq = await insertRaw("Amanda Plotner (ABQ)", "2026-10-06");
  const pLl = await insertRaw("Amanda Plotner (LL)", "2026-10-06");
  const kAbq = await insertRaw("Zztest Kennedy (ABQ)", "2026-10-06");
  const intakeLookalike = await insertRaw("Sandra Rivera (ABQ)", "2026-10-06", "intake");

  // -------------------------------------------------------------------------
  console.log("\n[1] Backfill: counts, ids, labels, activity");
  const before = await corp.countCorpProviderLabels();
  eq("before: by provider and office", before, [
    { name: "Amanda Davison", office: "ABQ", n: 1 },
    { name: "Amanda Davison", office: "CORP", n: 1 },
    { name: "Sandra Rivera", office: "", n: 1 },
    { name: "Sandra Rivera", office: "ABQ", n: 2 },
    { name: "Sandra Rivera", office: "CORP", n: 1 },
  ]);
  const changed = await corp.applyCorpSurveyLabelBackfill();
  eq("changed exactly the four non-Corp rows", changed, [sAbq1, sAbq2, sBare, dAbq].sort((a, b) => a - b));
  eq("labels now CORP, under the provider's own name",
    [await label(sAbq1), await label(sAbq2), await label(sBare), await label(dAbq)],
    ["Sandra Rivera (CORP)", "Sandra Rivera (CORP)", "Sandra Rivera (CORP)", "Amanda Davison (CORP)"]);
  eq("already-Corp rows untouched (any case)", [await label(sCorp), await label(dCorpLower)], ["Sandra Rivera (CORP)", "Amanda Davison (Corp)"]);
  eq("Plotner and an unmoved provider untouched", [await label(pAbq), await label(pLl), await label(kAbq)],
    ["Amanda Plotner (ABQ)", "Amanda Plotner (LL)", "Zztest Kennedy (ABQ)"]);
  eq("a non-survey row is never touched", await label(intakeLookalike), "Sandra Rivera (ABQ)");
  const other = (await pool.query(`SELECT payload::jsonb->'answers'->>'overallRating' AS r, payload::jsonb->'client'->>'email' AS e FROM form_submissions WHERE id = $1`, [sAbq1])).rows[0];
  eq("the rest of the payload is kept", [other.r, other.e], ["9", "zz@example.invalid"]);

  const lines = await relabelLines();
  eq("one activity line per changed row", lines.map((l) => Number(l.entity_id)).sort((a, b) => a - b), changed);
  ok("activity lines carry no client name", lines.every((l) => l.entity_name === "Client survey" && !String(l.metadata).includes("ZZTEST")));
  const meta = JSON.parse(lines.find((l) => Number(l.entity_id) === sBare).metadata);
  eq("activity metadata: provider and offices", [meta.submissionId, meta.provider, meta.from, meta.to], [sBare, "Sandra Rivera", "", "CORP"]);
  const after = await corp.countCorpProviderLabels();
  eq("after: nothing left outside CORP", after.filter((c) => c.office !== "CORP"), []);

  // -------------------------------------------------------------------------
  console.log("\n[2] Backfill is idempotent");
  eq("a second run changes nothing", await corp.applyCorpSurveyLabelBackfill(), []);
  eq("…and logs nothing more", (await relabelLines()).length, lines.length);

  // -------------------------------------------------------------------------
  console.log("\n[3] Write time: a new survey for a Corp-only provider is stored CORP");
  const write = (therapist: string) => db.insertSubmission({
    formType: "survey", source: "client_survey", submittedAt: "2026-10-07T16:00:00.000Z",
    contactId: null, name: "ZZTEST Writer", data: survey(therapist, "2026-10-07"),
  });
  const newS = await write("Sandra Rivera (ABQ)");
  const newD = await write("Amanda Davison");
  const newP = await write("Amanda Plotner (ABQ)");
  const newK = await write("Zztest Kennedy (ABQ)");
  eq("Sandra (ABQ) from an old form → CORP", await label(newS), "Sandra Rivera (CORP)");
  eq("Amanda D with no office → CORP", await label(newD), "Amanda Davison (CORP)");
  eq("Plotner (ABQ) stays ABQ", await label(newP), "Amanda Plotner (ABQ)");
  eq("an unmoved provider stays as submitted", await label(newK), "Zztest Kennedy (ABQ)");
  const nonSurvey = await db.insertSubmission({
    formType: "feedback", source: "zz", contactId: null, name: "ZZTEST Other", data: { answers: { therapist: "Sandra Rivera (ABQ)" } },
  });
  eq("only surveys are relabelled", await label(nonSurvey), "Sandra Rivera (ABQ)");
  eq("new rows leave nothing for the backfill", await corp.applyCorpSurveyLabelBackfill(), []);

  // -------------------------------------------------------------------------
  console.log("\n[4] Snapshot and export: one Corp row each, no ABQ row");
  const range = { from: "2026-09-01", to: "2026-10-31" };
  const data = await loadSurveyPeriodData(range);
  const snap = renderSurveySnapshot(range, data, null);
  const theTwo = (name: string) => name === "Sandra Rivera" || name === "Amanda Davison";
  eq("snapshot: one row each, CORP",
    snap.providers.filter((p) => theTwo(p.name)).map((p) => [p.name, p.office, p.surveys]),
    [["Amanda Davison", "CORP", 3], ["Sandra Rivera", "CORP", 5]]);
  const office = (o: string) => snap.offices.find((x) => x.office === o)?.surveys;
  eq("per-location totals: CORP has all of theirs, ABQ only Plotner (ABQ) + Kennedy",
    [office("CORP"), office("ABQ"), office("LL")], [8, 4, 1]);

  const exp = await buildSurveyExport(range);
  const zip = unzipSync(new Uint8Array(exp.buffer));
  const wb = strFromU8(zip["xl/workbook.xml"]);
  const sheets = Array.from(wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)).map((m) => m[1]);
  ok("export: Sandra and Amanda D have one tab each", sheets.filter((s) => /^(Sandra|Amanda D)\b/.test(s)).length === 2, JSON.stringify(sheets));
  ok("export: no ABQ tab for them", !sheets.some((s) => /^(Sandra|Amanda D) \(/.test(s)), JSON.stringify(sheets));
  eq("export: their Data rows all say CORP",
    data.aggregate.dataRows.filter((r) => theTwo(r.provider)).map((r) => r.office).filter((o) => o !== "CORP"), []);
  eq("export: their analysis rows (aggregate buckets) are CORP only",
    data.aggregate.providers.filter((p) => theTwo(p.name)).map((p) => p.office), ["CORP", "CORP"]);

  await pool.query(`DELETE FROM form_submissions WHERE name LIKE 'ZZTEST%'`);
  await pool.query(`DELETE FROM activity_log WHERE entity_name = 'Client survey'`);
  await pool.query(`DELETE FROM crm_providers WHERE name = ANY($1)`, [PROVIDERS]);
  await pool.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exit(1); }
  console.log("PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
