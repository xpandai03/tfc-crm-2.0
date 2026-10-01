/**
 * Deleting a survey submission, against a real database: the row is kept with
 * deleted_at / deleted_by, and it leaves every survey surface — both
 * Submissions lists, the review counts, the export and snapshot (the same
 * period data), the provider counts, the date-of-birth review, and the attach
 * batch. An intake row cannot be deleted this way, and the monthly report does
 * not read surveys at all.
 *
 * Writes rows. Run ONLY against a throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55437/tfc_surveydeletetest \
 *     npx tsx --tsconfig tsconfig.test.json scripts/test-survey-delete-db.ts
 *
 * NO PHI: ZZTEST names, example.invalid addresses, invented dates.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const url = process.env.DATABASE_URL ?? "";
if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_surveydeletetest/.test(url))) {
  console.error(
    "REFUSING TO RUN. This script writes submissions and must only point at\n" +
      "the throwaway local database (127.0.0.1/localhost, tfc_surveydeletetest).",
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

async function main() {
  const { getPool } = await import("../server/db/pool");
  const db = await import("../server/sync/db");
  const { initActivityTable, getActivityForContact } = await import("../server/activity/db");
  const { initRemindersTable } = await import("../server/reminders/db");
  const { initSurveyMatchTable, getMatchCounts, markAutoMatchResult } = await import("../server/survey/match-db");
  const { initSurveyAttachTable } = await import("../server/survey/attach-db");
  const { initActiveCountsTable } = await import("../server/therapy-notes/active-counts-db");
  const { initActiveCountOverridesTable } = await import("../server/survey/active-count-overrides-db");
  const { initTnPatientsTable } = await import("../server/therapy-notes/tn-patients-db");
  const { loadSurveyPeriodData } = await import("../server/survey/export");
  const { findImplausibleDobSurveys } = await import("../server/survey/dob-review");
  const { findAttachable, checkIdentityEligibility } = await import("../server/survey/attach-runner");

  await initRemindersTable();
  await db.initSyncTables();
  await initActivityTable();
  await initSurveyMatchTable();
  await initSurveyAttachTable();
  await initActiveCountsTable();
  await initActiveCountOverridesTable();
  await initTnPatientsTable();

  const pool = getPool();
  await pool.query(`DELETE FROM form_submissions WHERE name LIKE 'ZZTEST%'`);
  await pool.query(`DELETE FROM survey_match_reviews WHERE submission_id NOT IN (SELECT id FROM form_submissions)`);
  await pool.query(`DELETE FROM crm_providers WHERE name LIKE 'Zztest%'`);
  await pool.query(`DELETE FROM activity_log WHERE entity_name = 'Client survey'`);
  await pool.query(
    `INSERT INTO crm_providers (name, location, is_active) VALUES ('Zztest Provider', 'ABQ', true)`,
  );

  const CONTACT = 990777;
  const survey = (name: string, dob: string) => ({
    surveyVersion: 3, formVariant: "in-person", modality: "In Person", language: "en",
    submittedAt: "2026-10-01T16:00:00.000Z",
    client: { name, dateOfBirth: dob, email: "zz@example.invalid", phone: "5055550142" },
    answers: { therapist: "Zztest Provider (ABQ)", overallRating: 9 },
  });
  const insert = (name: string, dob: string, contactId: number | null) =>
    db.insertSubmission({
      formType: "survey", source: "client_survey", submittedAt: "2026-10-01T16:00:00.000Z",
      contactId, name, data: survey(name, dob),
    });
  const keep = await insert("ZZTEST Keep Person", "1985-06-15", null);
  const gone = await insert("ZZTEST Gone Person", "2026-06-15", CONTACT); // also an implausible year
  const intake = await db.insertFormSubmission({ source: "rfs_v2", contactId: 990778, name: "ZZTEST Intake", payload: {} });
  // Both surveys matched, so both would be candidates for the attach batch.
  for (const id of [keep, gone]) {
    await markAutoMatchResult({ submissionId: id, status: "matched", reason: "name_dob", contactId: CONTACT, candidateIds: [] });
  }

  const ids = (rows: { id: number }[]) => rows.map((r) => r.id);
  const period = { from: "2026-10-01", to: "2026-10-31" };
  const before = {
    surveys: ids(await db.getRecentSurveySubmissions(1000)),
    all: ids(await db.getRecentSubmissions(50)),
    counts: await getMatchCounts(),
    data: await loadSurveyPeriodData(period),
    dob: (await findImplausibleDobSurveys(new Date("2026-10-01T18:00:00Z"))).map((c) => c.submissionId),
    attach: ids((await findAttachable(12)).ready),
  };
  ok("before: both surveys listed", before.surveys.includes(keep) && before.surveys.includes(gone));
  ok("before: the attach batch would take both", before.attach.includes(keep) && before.attach.includes(gone),
    JSON.stringify(before.attach));
  ok("before: the DOB review sees the 2026 survey", before.dob.includes(gone));

  // -------------------------------------------------------------------------
  console.log("\n[1] Delete writes the audit fields and keeps the row");
  const res = await db.softDeleteSurveySubmission(gone, "zztest.staff@example.invalid");
  ok("delete returned the row", res?.id === gone && res?.contactId === CONTACT, JSON.stringify(res));
  const row = (await pool.query(
    `SELECT deleted_at IS NOT NULL AS d, deleted_by, payload IS NOT NULL AS has_payload FROM form_submissions WHERE id = $1`, [gone],
  )).rows[0];
  ok("deleted_at is set", row.d === true);
  eq("deleted_by is the staff member", row.deleted_by, "zztest.staff@example.invalid");
  ok("the answers are still stored", row.has_payload === true);
  ok("by id it is still readable, flagged", !!(await db.getSubmissionById(gone))?.deletedAt);
  eq("a second delete finds nothing", await db.softDeleteSurveySubmission(gone, "zztest.staff@example.invalid"), null);
  eq("an INTAKE submission cannot be deleted this way",
    await db.softDeleteSurveySubmission(intake, "zztest.staff@example.invalid"), null);

  // -------------------------------------------------------------------------
  console.log("\n[2] The deleted survey leaves every surface");
  const surveys = ids(await db.getRecentSurveySubmissions(1000));
  ok("'All surveys' list: gone, the other kept", !surveys.includes(gone) && surveys.includes(keep));
  const all = ids(await db.getRecentSubmissions(50));
  ok("mixed Submissions list: gone, intake kept", !all.includes(gone) && all.includes(intake) && all.includes(keep));
  const counts = await getMatchCounts();
  eq("review chips: one fewer matched", counts.matched, before.counts.matched - 1);
  const data = await loadSurveyPeriodData(period);
  eq("export and snapshot: one fewer survey in the period",
    data.aggregate.submissionsInPeriod, before.data.aggregate.submissionsInPeriod - 1);
  const provider = (d: typeof data) => d.aggregate.providers.find((p) => p.name === "Zztest Provider")?.surveyCount ?? -1;
  eq("provider counts: one fewer for the provider", provider(data), provider(before.data) - 1);
  const dob = (await findImplausibleDobSurveys(new Date("2026-10-01T18:00:00Z"))).map((c) => c.submissionId);
  ok("date-of-birth review: gone", !dob.includes(gone));
  const attach = ids((await findAttachable(12)).ready);
  ok("attach batch: skips it, still takes the other", !attach.includes(gone) && attach.includes(keep),
    JSON.stringify(attach));
  const byId = await db.getSubmissionById(gone);
  eq("the button refuses it too (eligibility)", byId ? (checkIdentityEligibility(byId) as { code?: string }).code : null, "deleted");

  // -------------------------------------------------------------------------
  console.log("\n[3] The monthly report never reads surveys");
  const reportSrc = readdirSync(join(process.cwd(), "server", "reports"))
    .map((f) => readFileSync(join(process.cwd(), "server", "reports", f), "utf8")).join("\n");
  ok("server/reports has no query on form_submissions and no survey filter",
    !/(FROM|JOIN)\s+form_submissions/i.test(reportSrc) && !/form_type\s*=\s*'survey'/.test(reportSrc));

  // -------------------------------------------------------------------------
  console.log("\n[4] The route: survey only, signed in, and a timeline entry on the contact");
  const routes = readFileSync(join(process.cwd(), "server", "routes.ts"), "utf8");
  const route = routes.slice(routes.indexOf('app.delete("/api/survey/submissions/'));
  ok("the route exists", route.length > 0);
  ok("it requires a signed-in user", /if \(!actorEmail\) return res\.status\(401\)/.test(route.slice(0, 600)));
  ok("it writes a contact timeline entry when matched",
    /entityType: "contact"[\s\S]{0,120}entityId: String\(contactId\)/.test(route.slice(0, 2500)));
  // The same two writes the route makes, so the timeline read is real.
  const { logActivity } = await import("../server/activity/db");
  await logActivity({ type: "survey_deleted", actorEmail: "zztest.staff@example.invalid", entityType: "contact",
    entityId: String(CONTACT), entityName: "Client survey", metadata: { submissionId: gone, contactId: CONTACT } });
  const timeline = await getActivityForContact(CONTACT, 10);
  ok("the contact's timeline shows the deletion", timeline.some((a) => a.type === "survey_deleted"));
  const page = readFileSync(join(process.cwd(), "client", "src", "pages", "submissions.tsx"), "utf8");
  ok("the page offers Delete on SURVEY rows only",
    /isSurveySubmission\(sub\) && \(\s*<Button[\s\S]{0,400}setDeleteTarget\(sub\)/.test(page));
  ok("the confirm dialog names the id and the date",
    /Delete survey #\{deleteTarget\?\.id\}/.test(page) && /formatExactTime\(deleteTarget\.createdAt\)/.test(page));

  await pool.query(`DELETE FROM form_submissions WHERE name LIKE 'ZZTEST%'`);
  await pool.query(`DELETE FROM survey_match_reviews WHERE submission_id IN ($1, $2)`, [keep, gone]);
  await pool.query(`DELETE FROM crm_providers WHERE name LIKE 'Zztest%'`);
  await pool.query(`DELETE FROM activity_log WHERE entity_name = 'Client survey'`);
  await pool.end();

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
