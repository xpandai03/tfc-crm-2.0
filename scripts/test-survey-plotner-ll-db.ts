/**
 * Amanda Plotner under Los Lunas, against a real database (2026-10-15): her
 * survey offices become {LL} once; her ABQ-labelled surveys are relabelled LL
 * with one activity line each, and a second run is a no-op; new surveys of
 * hers are stored LL; the single-office rule is general (any one office);
 * adding ABQ back is never undone by a reboot and restores labels-as-sent.
 *
 * Writes rows. Run ONLY against a throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55441/tfc_plotnertest \
 *     npx tsx --tsconfig tsconfig.test.json scripts/test-survey-plotner-ll-db.ts
 *
 * NO PHI: provider names are staff names; every client is a ZZTEST name with an
 * example.invalid address and invented dates.
 */

import { readFileSync } from "fs";

const url = process.env.DATABASE_URL ?? "";
if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_plotnertest/.test(url))) {
  console.error("REFUSING TO RUN: point DATABASE_URL at the throwaway local database (127.0.0.1/localhost, tfc_plotnertest).");
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
const normalizeSql = (sql: string) =>
  sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/\s+/g, " ").trim();

async function main() {
  const { getPool } = await import("../server/db/pool");
  const db = await import("../server/sync/db");
  const { initActivityTable } = await import("../server/activity/db");
  const { initRemindersTable } = await import("../server/reminders/db");
  const plotner = await import("../server/survey/plotner-ll");
  const corp = await import("../server/survey/corp-labels");

  await initRemindersTable();
  await db.initSyncTables();
  await initActivityTable();

  const pool = getPool();
  const PROVIDERS = ["Sandra Rivera", "Amanda Plotner", "Zztest Kennedy", "Zztest Rio"];
  await pool.query(`DELETE FROM form_submissions WHERE name LIKE 'ZZTEST%'`);
  await pool.query(`DELETE FROM activity_log WHERE type IN ('survey_relabelled', 'provider_survey_offices_set')`);
  await pool.query(`DELETE FROM crm_providers WHERE name = ANY($1)`, [PROVIDERS]);
  await pool.query(
    `INSERT INTO crm_providers (name, short_name, location, survey_locations, is_active) VALUES
       ('Sandra Rivera', 'Sandra', 'ABQ', ARRAY['CORP'], true),
       ('Amanda Plotner', 'Amanda P', 'LL', ARRAY['LL','ABQ'], true),
       ('Zztest Kennedy', 'Kennedy', 'ABQ', NULL, true),
       ('Zztest Rio', 'Rio', 'ABQ', ARRAY['RR'], true)`,
  );

  console.log("\n[0] The boot statement is the migration file");
  eq("PLOTNER_BACKFILL_SQL matches migrations/backfill-plotner-ll.sql",
    normalizeSql(plotner.PLOTNER_BACKFILL_SQL), normalizeSql(readFileSync("migrations/backfill-plotner-ll.sql", "utf8")));

  let n = 0;
  const survey = (therapist: string, day: string) => ({
    surveyVersion: 3, formVariant: "in-person", modality: "In Person", language: "en",
    submittedAt: `${day}T16:00:00.000Z`,
    client: { name: `ZZTEST Person ${++n}`, dateOfBirth: "1985-06-15", email: "zz@example.invalid", phone: "5055550142" },
    answers: { therapist, overallRating: 9 },
  });
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
  const offices = async () =>
    (await pool.query(`SELECT survey_locations FROM crm_providers WHERE name = 'Amanda Plotner'`)).rows[0]?.survey_locations;
  const lines = async (type: string) =>
    (await pool.query(`SELECT entity_id, entity_name, metadata FROM activity_log WHERE type = $1 ORDER BY id`, [type])).rows;
  const write = (therapist: string) => db.insertSubmission({
    formType: "survey", source: "client_survey", submittedAt: "2026-10-15T16:00:00.000Z",
    contactId: null, name: "ZZTEST Writer", data: survey(therapist, "2026-10-15"),
  });

  const pAbq1 = await insertRaw("Amanda Plotner (ABQ)", "2026-10-06");
  const pAbq2 = await insertRaw("amanda  plotner (abq)", "2026-10-10");
  const pLl = await insertRaw("Amanda Plotner (LL)", "2026-09-20");
  const pBare = await insertRaw("Amanda Plotner", "2026-10-08");
  const kAbq = await insertRaw("Zztest Kennedy (ABQ)", "2026-10-08");
  const intakeLike = await insertRaw("Amanda Plotner (ABQ)", "2026-10-09", "intake");

  console.log("\n[1] First boot: offices {LL} once; ABQ surveys -> LL; counts; activity");
  eq("before: her surveys by office", await plotner.countPlotnerLabels(),
    [{ office: "", n: 1 }, { office: "ABQ", n: 2 }, { office: "LL", n: 1 }]);
  const changed = await plotner.applyPlotnerLosLunas();
  eq("her offices are now {LL}", await offices(), ["LL"]);
  eq("changed exactly her two ABQ rows", changed, [pAbq1, pAbq2].sort((a, b) => a - b));
  eq("relabelled LL under her own name", [await label(pAbq1), await label(pAbq2)], ["Amanda Plotner (LL)", "Amanda Plotner (LL)"]);
  eq("LL, bare and other providers' rows untouched", [await label(pLl), await label(pBare), await label(kAbq)],
    ["Amanda Plotner (LL)", "Amanda Plotner", "Zztest Kennedy (ABQ)"]);
  eq("a non-survey row is never touched", await label(intakeLike), "Amanda Plotner (ABQ)");
  eq("after: her surveys by office", await plotner.countPlotnerLabels(), [{ office: "", n: 1 }, { office: "LL", n: 3 }]);
  const rel = await lines("survey_relabelled");
  eq("one survey_relabelled line per changed row", rel.map((l) => Number(l.entity_id)).sort((a, b) => a - b), changed);
  ok("…carrying no client name", rel.every((l) => l.entity_name === "Client survey" && !String(l.metadata).includes("ZZTEST")));
  const meta = JSON.parse(rel[0].metadata);
  eq("…with provider, offices and reason", [meta.provider, meta.from, meta.to, meta.reason],
    ["Amanda Plotner", "ABQ", "LL", "plotner-ll-only-2026-10-15"]);
  const marker = await lines("provider_survey_offices_set");
  eq("one office-set marker line", marker.length, 1);
  eq("…from {LL,ABQ} to {LL}", [JSON.parse(marker[0].metadata).from, JSON.parse(marker[0].metadata).to], [["LL", "ABQ"], ["LL"]]);

  console.log("\n[2] Second boot: nothing changes");
  eq("no rows changed", await plotner.applyPlotnerLosLunas(), []);
  eq("no new activity lines", [(await lines("survey_relabelled")).length, (await lines("provider_survey_offices_set")).length], [2, 1]);

  console.log("\n[3] New surveys: the single-office rule");
  const newP = await write("Amanda Plotner (ABQ)");
  const newS = await write("Sandra Rivera (ABQ)");
  const newR = await write("Zztest Rio (ABQ)");
  const newK = await write("Zztest Kennedy (ABQ)");
  eq("Plotner (ABQ) from the form is stored LL", await label(newP), "Amanda Plotner (LL)");
  eq("Corp-only still stored CORP", await label(newS), "Sandra Rivera (CORP)");
  eq("ANY single office applies (RR)", await label(newR), "Zztest Rio (RR)");
  eq("a provider with no survey offices set keeps the label as sent", await label(newK), "Zztest Kennedy (ABQ)");
  eq("singleSurveyOffice: {LL}", corp.singleSurveyOffice("LL", ["LL"]), "LL");
  eq("singleSurveyOffice: {LL,ABQ} -> none", corp.singleSurveyOffice("LL", ["LL", "ABQ"]), null);
  eq("singleSurveyOffice: unset, location ABQ -> none", corp.singleSurveyOffice("ABQ", null), null);
  eq("singleSurveyOffice: unset, location CORP -> CORP (as before)", corp.singleSurveyOffice("CORP", null), "CORP");

  console.log("\n[4] ABQ added back later: never undone, labels as sent again");
  await pool.query(`UPDATE crm_providers SET survey_locations = ARRAY['LL','ABQ'] WHERE name = 'Amanda Plotner'`);
  const realAbq = await insertRaw("Amanda Plotner (ABQ)", "2026-11-02");
  eq("a reboot changes nothing", await plotner.applyPlotnerLosLunas(), []);
  eq("her offices stay {LL,ABQ}", await offices(), ["LL", "ABQ"]);
  eq("a genuine ABQ survey keeps its label", await label(realAbq), "Amanda Plotner (ABQ)");
  const laterP = await write("Amanda Plotner (ABQ)");
  eq("a new ABQ survey is stored ABQ (two-row behaviour back)", await label(laterP), "Amanda Plotner (ABQ)");

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) failures.forEach((f) => console.log("  - " + f));
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
