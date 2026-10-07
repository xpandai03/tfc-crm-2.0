/**
 * Three strikes against a real database: the activity-log history, the move to
 * review, the rows it must leave alone, and the 03:00 re-match not undoing it.
 *
 * Writes rows. Run ONLY against a throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55435/tfc_strikestest \
 *     npx tsx --tsconfig tsconfig.test.json scripts/test-attach-strikes-db.ts
 *
 * NO PHI: submission ids and codes only.
 */
const url = process.env.DATABASE_URL ?? "";
if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_strikestest/.test(url))) {
  console.error("REFUSING TO RUN: point DATABASE_URL at the throwaway local database (tfc_strikestest).");
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
  const { getPool, closePool } = await import("../server/db/pool");
  const sync = await import("../server/sync/db");
  const activity = await import("../server/activity/db");
  const matchDb = await import("../server/survey/match-db");
  const attachDb = await import("../server/survey/attach-db");
  const strikes = await import("../server/survey/attach-strikes");
  const pool = getPool();
  await sync.initSyncTables();
  await activity.initActivityTable();
  await matchDb.initSurveyMatchTable();
  await attachDb.initSurveyAttachTable();
  await (await import("../server/therapy-notes/tn-patients-db")).initTnPatientsTable(); // adds matched_chart_id

  const IDS = [990501, 990502, 990503, 990504, 990505, 990506];
  await pool.query(`DELETE FROM survey_match_reviews WHERE submission_id = ANY($1)`, [IDS]);
  await pool.query(`DELETE FROM survey_attach_attempts WHERE submission_id = ANY($1)`, [IDS]);
  await pool.query(`DELETE FROM activity_log WHERE entity_type = 'submission' AND entity_id = ANY($1)`, [IDS.map(String)]);

  // One night's attempt, as attachOne records it: the attempt row + an activity row.
  let day = 0;
  async function night(id: number, code: string | null, trigger = "scheduled") {
    day += 1;
    await pool.query(
      `INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata, created_at)
       VALUES ($1, 'system', 'submission', $2, 'Client survey', $3, NOW() - make_interval(days => $4))`,
      [code === null ? "survey_attach_completed" : "survey_attach_failed", String(id),
       JSON.stringify({ submissionId: id, trigger, ...(code ? { failureReason: code } : {}) }), 100 - day],
    );
    await pool.query(
      `INSERT INTO survey_attach_attempts (submission_id, status, reason, trigger)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (submission_id) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason`,
      [id, code === null ? "attached" : "failed", code, trigger],
    );
  }
  const matched = (id: number) => matchDb.markAutoMatchResult({ submissionId: id, status: "matched", reason: "name_dob", contactId: null, candidateIds: [] });

  const [FIVE, TWO, OUTAGES, STAFF, INREVIEW, RESET] = IDS;
  for (const id of [FIVE, TWO, OUTAGES, INREVIEW, RESET]) await matched(id);
  await matchDb.recordHumanResolution({ submissionId: STAFF, contactId: 12345, actorEmail: "zztest.staff@example.invalid" });

  for (let i = 0; i < 5; i++) await night(FIVE, "patient_not_found");
  for (let i = 0; i < 2; i++) await night(TWO, "patient_not_found");
  for (const c of ["patient_not_found", "agent_unreachable", "patient_not_found", "unknown_error", "login_failed", "patient_not_found"]) await night(OUTAGES, c);
  for (let i = 0; i < 3; i++) await night(STAFF, "patient_not_found");
  for (let i = 0; i < 4; i++) await night(INREVIEW, "patient_not_found");
  await matchDb.markAttachRefusalForReview({ submissionId: INREVIEW, reason: "attach_dob_implausible" });
  for (const c of ["patient_not_found", "patient_not_found", "field_unreadable", "patient_not_found", "patient_not_found"]) await night(RESET, c);

  console.log("\n[1] History from the activity log, newest first");
  eq("five nights read back", (await strikes.getAttachHistory(FIVE)).map((e) => e.code), Array(5).fill("patient_not_found"));

  console.log("\n[2] The sweep");
  const sweep = await strikes.sweepStrikes();
  eq("moves exactly the rows at three or more", sweep.moved.sort(), [FIVE, OUTAGES, STAFF].sort());
  const state = async (id: number) => {
    const s = await matchDb.getMatchState(id);
    return [s?.status, s?.reason];
  };
  eq("5 nights -> review, attach_repeated_patient_not_found", await state(FIVE), ["review", "attach_repeated_patient_not_found"]);
  eq("2 nights -> still matched (tried again tonight)", await state(TWO), ["matched", "name_dob"]);
  eq("3 strikes with outage nights between them -> review", await state(OUTAGES), ["review", "attach_repeated_patient_not_found"]);
  eq("a staff-confirmed match refused 3 nights -> review too", await state(STAFF), ["review", "attach_repeated_patient_not_found"]);
  eq("a row already in review keeps its own reason", await state(INREVIEW), ["review", "attach_dob_implausible"]);
  eq("a different code in between resets: 2 nights -> still matched", await state(RESET), ["matched", "name_dob"]);

  console.log("\n[3] It sticks");
  await matched(FIVE);
  eq("the 03:00 re-match cannot flip it back to matched", await state(FIVE), ["review", "attach_repeated_patient_not_found"]);
  const again = await strikes.sweepStrikes();
  eq("a second sweep moves nothing more", again.moved, []);

  console.log("\n[4] A third night tonight");
  await night(TWO, "patient_not_found");
  eq("applyStrikeRule after tonight's refusal moves it", (await strikes.applyStrikeRule(TWO))?.reason, "attach_repeated_patient_not_found");
  eq("…and it is in review", await state(TWO), ["review", "attach_repeated_patient_not_found"]);

  console.log("\n[5] Clearing a stale review row, with a note");
  await matchDb.markAttachRefusalForReview({ submissionId: RESET, reason: "attach_chart_not_in_search" });
  await matchDb.recordHumanResolution({ submissionId: RESET, contactId: null, actorEmail: "ops (sync key)", note: "filed Oct 1; review cleared" });
  const cleared = await matchDb.getMatchState(RESET);
  eq("out of review, as no contact, with the note", [cleared?.status, cleared?.reason],
    ["no_contact", "Confirmed by staff: no matching contact; filed Oct 1; review cleared"]);
  await matched(RESET);
  eq("the 03:00 re-match leaves a human resolution alone", (await matchDb.getMatchState(RESET))?.status, "no_contact");

  await pool.query(`DELETE FROM survey_match_reviews WHERE submission_id = ANY($1)`, [IDS]);
  await pool.query(`DELETE FROM survey_attach_attempts WHERE submission_id = ANY($1)`, [IDS]);
  await pool.query(`DELETE FROM activity_log WHERE entity_type = 'submission' AND entity_id = ANY($1)`, [IDS.map(String)]);
  await closePool();
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
