/**
 * Integration self-checks for the survey matching RUNNER.
 *
 * Run against a throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55432/tfc_matchtest \
 *     npx tsx scripts/test-survey-matching-run.ts
 *
 * The pure rules are covered by test-survey-matching.ts. What needs a database
 * is what SQL guarantees rather than TypeScript: that a re-run is idempotent,
 * that it cannot overwrite a human's decision, that the contact index really
 * does return the phone and the assigned provider, and that no contact row is
 * touched. Those are the ones this file exists for.
 *
 * REFUSES TO RUN AGAINST PRODUCTION. It creates and deletes contacts, so the
 * guard below is not a formality — see assertLocalDatabase().
 *
 * NO PHI. Every identity is invented for this file.
 */
import { runSurveyMatching } from "../server/survey/match-runner";
import {
  getContactIdentityIndex, getMatchState, initSurveyMatchTable,
  recordHumanResolution,
} from "../server/survey/match-db";
import { getPool } from "../server/db/pool";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

/**
 * This script writes contacts. Running it against production would put
 * synthetic people into the waitlist, the dashboard and the monthly report's
 * cohort. Refuse anything that is not an explicitly local database.
 */
function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const isLocal = /@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_matchtest/.test(url);
  if (!isLocal) {
    console.error(
      "REFUSING TO RUN. This script creates and deletes contacts and must only\n" +
      "point at the throwaway local database. Expected a DATABASE_URL on\n" +
      "127.0.0.1/localhost naming tfc_matchtest.",
    );
    process.exit(2);
  }
}

const CONTACT_IDS = [990001, 990002, 990003, 990004];
const SUBMISSION_IDS = [990101, 990102, 990103, 990104, 990105];

async function seed() {
  const pool = getPool();
  // Two records for one couple: same legal name, date of birth, phone and
  // email, different providers. Plus an unrelated person and a near miss.
  await pool.query(
    `INSERT INTO sync_contacts (contact_id, name, email, phone, patient_dob) VALUES
       (990001, 'Jeff Powers', 'jeff.powers@example.invalid', '(505) 555-0110', '1979-06-21'),
       (990002, 'Jeff Powers', 'jeff.powers@example.invalid', '505-555-0110',   '1979-06-21'),
       (990003, 'Rosalind Ashgrove', 'rosalind.ashgrove@example.invalid', '5055550181', '1988-03-14'),
       (990004, 'Marcus Trilby', 'marcus.trilby@example.invalid', '5055550175', '1975-11-02')`,
  );
  await pool.query(
    `INSERT INTO contact_provider_assignments (contact_id, provider_name, assigned_at) VALUES
       (990001, 'Anna Aldridge', NOW() - interval '2 days'),
       (990002, 'Amber Lute',    NOW() - interval '2 days'),
       (990003, 'Anna Aldridge', NOW() - interval '2 days')`,
  );

  const sub = (id: number, name: string, dob: string, therapist: string,
               extra: { phone?: string; email?: string } = {}) => ({
    id,
    payload: JSON.stringify({
      surveyVersion: 1, formVariant: "in-person", modality: "In Person",
      submittedAt: "2026-09-08T00:00:00.000Z",
      client: { name, dateOfBirth: dob, email: extra.email ?? "", ...(extra.phone ? { phone: extra.phone } : {}) },
      answers: { therapist, overallRating: 9, additionalComments: "Content that must never reach the queue." },
      comments: { therapist: "A per-question comment that must never reach the queue." },
    }),
    name,
  });
  const rows = [
    // 990101 couples case, names the individual's provider
    sub(990101, "Jeff Powers", "1979-06-21", "Anna Aldridge (ABQ)", { phone: "(505) 555-0110", email: "jeff.powers@example.invalid" }),
    // 990102 couples case, names the couple record's provider
    sub(990102, "Jeff Powers", "1979-06-21", "Amber Lute (LL)", { phone: "505.555.0110", email: "jeff.powers@example.invalid" }),
    // 990103 couples case, names a third provider -> review
    sub(990103, "Jeff Powers", "1979-06-21", "Krista Luna (ABQ)", { phone: "5055550110", email: "jeff.powers@example.invalid" }),
    // 990104 PRE-PHONE shape: no phone key on the client object at all
    sub(990104, "Rosalind Ashgrove", "1988-03-14", "Anna Aldridge (ABQ)", { email: "rosalind.ashgrove@example.invalid" }),
    // 990105 near miss: hyphenated surname -> review
    sub(990105, "Rosalind Ashgrove-Pemberton", "1988-03-14", "Anna Aldridge (ABQ)", { phone: "5055550181", email: "rosalind.ashgrove@example.invalid" }),
  ];
  for (const r of rows) {
    await pool.query(
      `INSERT INTO form_submissions (id, created_at, source, form_type, submitted_at, contact_id, name, payload)
       VALUES ($1, $2, 'client_survey_v1', 'survey', $2, NULL, $3, $4)`,
      [r.id, "2026-09-08T00:00:00.000Z", r.name, r.payload],
    );
  }
}

async function cleanup() {
  const pool = getPool();
  await pool.query(`DELETE FROM survey_match_reviews WHERE submission_id = ANY($1::int[])`, [SUBMISSION_IDS]);
  await pool.query(`DELETE FROM form_submissions WHERE id = ANY($1::int[])`, [SUBMISSION_IDS]);
  await pool.query(`DELETE FROM contact_provider_assignments WHERE contact_id = ANY($1::int[])`, [CONTACT_IDS]);
  await pool.query(`DELETE FROM sync_contacts WHERE contact_id = ANY($1::int[])`, [CONTACT_IDS]);
}

async function main() {
  assertLocalDatabase();
  const pool = getPool();
  await initSurveyMatchTable();
  await cleanup();
  await seed();

  const contactCountBefore = (await pool.query(`SELECT count(*)::int n FROM sync_contacts`)).rows[0].n;
  const contactDigest = (await pool.query(
    `SELECT md5(string_agg(contact_id||'|'||coalesce(name,'')||'|'||coalesce(email,'')||'|'||coalesce(phone,'')||'|'||coalesce(patient_dob,''), ',' ORDER BY contact_id)) d FROM sync_contacts`,
  )).rows[0].d;

  console.log("\n[index] The contact index really carries phone and provider");
  const index = await getContactIdentityIndex();
  const jeff1 = index.find((c) => c.contactId === 990001)!;
  const jeff2 = index.find((c) => c.contactId === 990002)!;
  ok("phone is loaded", jeff1.phone === "(505) 555-0110", String(jeff1.phone));
  eq("the individual record's provider is loaded", jeff1.assignedProvider, "Anna Aldridge");
  eq("the couple record's provider is loaded", jeff2.assignedProvider, "Amber Lute");
  eq("a contact with no assignment has a null provider",
    index.find((c) => c.contactId === 990004)!.assignedProvider, null);

  console.log("\n[2/3] The couples case, end to end through the runner");
  const first = await runSurveyMatching();
  const s = async (id: number) => await getMatchState(id);
  eq("naming the individual's provider matches that record alone",
    [(await s(990101))?.status, (await s(990101))?.reason, (await s(990101))?.matchedContactId],
    ["matched", "name_dob_provider", 990001]);
  eq("naming the couple record's provider matches that one alone",
    [(await s(990102))?.status, (await s(990102))?.reason, (await s(990102))?.matchedContactId],
    ["matched", "name_dob_provider", 990002]);
  eq("naming a third provider routes to review, with a reason",
    [(await s(990103))?.status, (await s(990103))?.reason, (await s(990103))?.matchedContactId],
    ["review", "provider_no_match", null]);
  eq("the review row still offers both candidates", (await s(990103))?.candidateIds.sort(), [990001, 990002]);

  console.log("\n[8] A pre-phone submission matches on the old criteria");
  eq("no phone on the payload -> matched on name, dob and email",
    [(await s(990104))?.status, (await s(990104))?.reason, (await s(990104))?.matchedContactId],
    ["matched", "name_dob_email", 990003]);

  console.log("\n[1] The near miss still routes to review");
  eq("a hyphenated surname -> review, naming the name",
    [(await s(990105))?.status, (await s(990105))?.reason],
    ["review", "no_candidates"]);

  console.log("\n[link] The contact link is mirrored onto the submission");
  const links = (await pool.query(
    `SELECT id, contact_id FROM form_submissions WHERE id = ANY($1::int[]) ORDER BY id`, [SUBMISSION_IDS],
  )).rows;
  eq("matched rows carry the link, reviewed rows carry none",
    links.map((r: { id: number; contact_id: number | null }) => [r.id, r.contact_id]),
    [[990101, 990001], [990102, 990002], [990103, null], [990104, 990003], [990105, null]]);

  console.log("\n[7] Re-running is idempotent and preserves a human decision");
  const second = await runSurveyMatching();
  eq("a second run produces the same counts",
    { m: first.matched, r: first.review }, { m: second.matched, r: second.review });
  const afterTwo = await Promise.all(SUBMISSION_IDS.map((id) => getMatchState(id)));
  const third = await runSurveyMatching();
  const afterThree = await Promise.all(SUBMISSION_IDS.map((id) => getMatchState(id)));
  eq("verdicts are unchanged across runs",
    afterTwo.map((r) => [r?.status, r?.reason, r?.matchedContactId]),
    afterThree.map((r) => [r?.status, r?.reason, r?.matchedContactId]));
  ok("no run reported a skipped human resolution yet", third.skippedHumanResolved === 0);

  // A human overrides the automatic verdict on 990103, and disagrees with the
  // matcher on 990101 — the harder case, since the matcher is confident there.
  await recordHumanResolution({ submissionId: 990103, contactId: 990002, actorEmail: "staff@example.invalid" });
  await recordHumanResolution({ submissionId: 990101, contactId: null, actorEmail: "staff@example.invalid" });
  const fourth = await runSurveyMatching();
  const h1 = await s(990103), h2 = await s(990101);
  eq("a human override survives a re-run",
    [h1?.status, h1?.matchedContactId, h1?.resolvedBy],
    ["matched", 990002, "staff@example.invalid"]);
  eq("a human 'no contact' survives a re-run even against a confident match",
    [h2?.status, h2?.matchedContactId, h2?.resolvedBy],
    ["no_contact", null, "staff@example.invalid"]);
  ok("the run reports it skipped them", fourth.skippedHumanResolved === 2, String(fourth.skippedHumanResolved));
  ok("resolutions record when, not only who", !!h1?.resolvedAt && !!h2?.resolvedAt);

  console.log("\n[10] No contact record was modified");
  const contactCountAfter = (await pool.query(`SELECT count(*)::int n FROM sync_contacts`)).rows[0].n;
  const digestAfter = (await pool.query(
    `SELECT md5(string_agg(contact_id||'|'||coalesce(name,'')||'|'||coalesce(email,'')||'|'||coalesce(phone,'')||'|'||coalesce(patient_dob,''), ',' ORDER BY contact_id)) d FROM sync_contacts`,
  )).rows[0].d;
  eq("the contact count is unchanged", contactCountAfter, contactCountBefore);
  eq("every contact field is byte-identical", digestAfter, contactDigest);
  const assignCount = (await pool.query(`SELECT count(*)::int n FROM contact_provider_assignments`)).rows[0].n;
  eq("no assignment was written", assignCount, 3);

  console.log("\n[11] Test data removed");
  await cleanup();
  const left = (await pool.query(
    `SELECT (SELECT count(*)::int FROM sync_contacts WHERE contact_id = ANY($1::int[])) c,
            (SELECT count(*)::int FROM form_submissions WHERE id = ANY($2::int[])) s,
            (SELECT count(*)::int FROM survey_match_reviews WHERE submission_id = ANY($2::int[])) m,
            (SELECT count(*)::int FROM contact_provider_assignments WHERE contact_id = ANY($1::int[])) a`,
    [CONTACT_IDS, SUBMISSION_IDS],
  )).rows[0];
  eq("no test contact, submission, match row or assignment remains",
    [left.c, left.s, left.m, left.a], [0, 0, 0, 0]);

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
  await pool.end();
}

main().catch(async (e) => {
  console.error("FAIL — the run threw:", e instanceof Error ? e.message : e);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
