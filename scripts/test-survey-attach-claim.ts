/**
 * The one guarantee that needs a real database: an attach cannot run twice.
 *
 * Run against a throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55433/tfc_attachtest \
 *     npx tsx scripts/test-survey-attach-claim.ts
 *
 * An attach is not idempotent — running it twice puts two copies of the same
 * survey on a patient's chart. The button being disabled is an affordance; the
 * claim is the guarantee, and a guarantee expressed in SQL has to be tested in
 * SQL. Everything else is covered by scripts/test-survey-attach.ts.
 *
 * NO PHI. Only submission ids and statuses are written.
 */
import {
  claimAttach, getAttachRow, getAttachedOrRunningIds,
  initSurveyAttachTable, recordAttachOutcome,
} from "../server/survey/attach-db";
import { getPool } from "../server/db/pool";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_attachtest/.test(url))) {
    console.error(
      "REFUSING TO RUN. This script writes attach rows and must only point at\n" +
      "the throwaway local database (127.0.0.1/localhost, tfc_attachtest).",
    );
    process.exit(2);
  }
}

const ID = 991001;

async function main() {
  assertLocalDatabase();
  const pool = getPool();
  await initSurveyAttachTable();
  await pool.query(`DELETE FROM survey_attach_attempts WHERE submission_id >= 991000`);

  const claim = (trigger: "manual" | "scheduled" = "manual", who = "a@example.invalid") =>
    claimAttach({ submissionId: ID, contactId: 1, trigger, actorEmail: who });

  console.log("\n[claim] A first claim wins; a second, concurrent one loses");
  ok("the first claim wins", (await claim()) === true);
  ok("a second claim while running LOSES", (await claim("manual", "b@example.invalid")) === false);
  eq("the row is running and owned by the first caller",
    [(await getAttachRow(ID))?.status, (await getAttachRow(ID))?.actorEmail],
    ["running", "a@example.invalid"]);

  console.log("\n[race] Ten simultaneous presses — exactly one wins");
  await pool.query(`DELETE FROM survey_attach_attempts WHERE submission_id = $1`, [ID]);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    claimAttach({ submissionId: ID, contactId: 1, trigger: "manual", actorEmail: `s${i}@example.invalid` })));
  eq("exactly one of ten concurrent claims succeeds", results.filter(Boolean).length, 1);

  console.log("\n[attached] Once filed, nothing may claim it again");
  await recordAttachOutcome({ submissionId: ID, status: "attached", reason: null, durationMs: 51234 });
  eq("the row is terminal", (await getAttachRow(ID))?.status, "attached");
  ok("a manual claim is refused", (await claim()) === false);
  ok("a scheduled claim is refused", (await claim("scheduled", "system")) === false);
  const again = await Promise.all(Array.from({ length: 5 }, () => claim()));
  eq("five more concurrent presses all lose", again.filter(Boolean).length, 0);
  ok("it is excluded from the batch's candidate set", (await getAttachedOrRunningIds()).has(ID));

  console.log("\n[failed] A failure may be deliberately retried");
  await recordAttachOutcome({ submissionId: ID, status: "failed", reason: "phone_mismatch", durationMs: 40000 });
  eq("the reason code is stored, not a sentence", (await getAttachRow(ID))?.reason, "phone_mismatch");
  ok("a failed row CAN be re-claimed by a human", (await claim()) === true);
  ok("...and is running again", (await getAttachRow(ID))?.status === "running");
  ok("...but only once", (await claim()) === false);

  console.log("\n[stale] A crashed run unlocks, but only after the window");
  ok("a fresh running row does not unlock", (await claim()) === false);
  await pool.query(
    `UPDATE survey_attach_attempts SET started_at = NOW() - interval '11 minutes' WHERE submission_id = $1`,
    [ID],
  );
  ok("a running row older than the window unlocks", (await claim("scheduled", "system")) === true);
  // An ATTACHED row must never unlock, however old — the chart already has it.
  await recordAttachOutcome({ submissionId: ID, status: "attached", reason: null, durationMs: 1 });
  await pool.query(
    `UPDATE survey_attach_attempts SET started_at = NOW() - interval '30 days' WHERE submission_id = $1`,
    [ID],
  );
  ok("an attached row never unlocks, however old", (await claim()) === false);

  console.log("\n[shape] The row records what the report needs and nothing more");
  const row = await getAttachRow(ID);
  eq("the stored fields", Object.keys(row ?? {}).sort(),
    ["actorEmail", "contactId", "durationMs", "finishedAt", "reason", "startedAt",
     "status", "submissionId", "trigger", "updatedAt"]);
  ok("a duration is recorded", typeof row?.durationMs === "number");
  ok("a finish time is recorded", !!row?.finishedAt);

  await pool.query(`DELETE FROM survey_attach_attempts WHERE submission_id >= 991000`);
  const left = (await pool.query(
    `SELECT count(*)::int n FROM survey_attach_attempts WHERE submission_id >= 991000`)).rows[0].n;
  eq("test rows removed", left, 0);

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
  await pool.end();
}

main().catch((e) => {
  console.error("FAIL — threw:", e instanceof Error ? e.message : e);
  process.exit(1);
});
