/**
 * "Change therapist" and the stale-tab guard, against a real database
 * (2026-10-22):
 *   - only active providers shown on the survey are offered, one per office;
 *   - a change rewrites the stored label and writes one survey_relabelled line;
 *   - a hidden or inactive provider, a stale "from", a deleted survey and a
 *     no-op are all refused without writing;
 *   - a survey already filed to a chart is changed in the CRM and flagged;
 *   - the public submit route refuses a survey naming a hidden provider with
 *     the reload message, and still accepts a shown one.
 *
 * Writes rows. Run ONLY against a throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55442/tfc_changetherapisttest \
 *     npx tsx --tsconfig tsconfig.test.json scripts/test-survey-change-therapist-db.ts
 *
 * NO PHI: provider names are staff names; every client is a ZZTEST name.
 */

import express from "express";
import type { AddressInfo } from "net";

const url = process.env.DATABASE_URL ?? "";
if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_changetherapisttest/.test(url))) {
  console.error("REFUSING TO RUN: point DATABASE_URL at the throwaway local database (127.0.0.1/localhost, tfc_changetherapisttest).");
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
  const { initRemindersTable } = await import("../server/reminders/db");
  const { initSurveyAttachTable } = await import("../server/survey/attach-db");
  const { initSurveyMatchTable } = await import("../server/survey/match-db");
  const relabel = await import("../server/survey/relabel");
  const { therapistHiddenFromSurvey, isHiddenOnSurvey } = await import("../server/survey/roster");

  await initActivityTable();
  await db.initSyncTables();
  await initRemindersTable();
  await initSurveyAttachTable();
  await initSurveyMatchTable();

  const pool = getPool();
  const PROVIDERS = ["Angelica Villicana", "Kennedy Hull", "Angelica Chavez", "Amanda Plotner", "Zztest Gone"];
  await pool.query(`DELETE FROM form_submissions WHERE name LIKE 'ZZTEST%'`);
  await pool.query(`DELETE FROM activity_log WHERE type = 'survey_relabelled'`);
  await pool.query(`DELETE FROM crm_providers WHERE name = ANY($1)`, [PROVIDERS]);
  await pool.query(
    `INSERT INTO crm_providers (name, credentials, location, survey_locations, is_active, show_on_survey) VALUES
       ('Angelica Villicana', 'LCSW', 'RR', NULL, true, false),
       ('Kennedy Hull', 'LPCC', 'ABQ', NULL, true, true),
       ('Angelica Chavez', 'LCSW', 'ABQ', NULL, true, true),
       ('Amanda Plotner', 'LPCC', 'LL', ARRAY['LL','ABQ'], true, true),
       ('Zztest Gone', '', 'ABQ', NULL, false, true)`,
  );

  let n = 0;
  const insertSurvey = async (therapist: string) => {
    const payload = {
      surveyVersion: 3, formVariant: "in-person", modality: "In Person", language: "en",
      submittedAt: "2031-10-02T16:00:00.000Z",
      client: { name: `ZZTEST Person ${++n}` }, answers: { therapist, overallRating: 9 },
    };
    const { rows } = await pool.query(
      `INSERT INTO form_submissions (form_type, source, submitted_at, contact_id, name, payload)
       VALUES ('survey', 'client_survey', $1, NULL, $2, $3) RETURNING id`,
      [payload.submittedAt, payload.client.name, JSON.stringify(payload)],
    );
    return rows[0].id as number;
  };
  const labelOf = async (id: number) =>
    (await pool.query(`SELECT payload::jsonb->'answers'->>'therapist' AS t FROM form_submissions WHERE id = $1`, [id])).rows[0]?.t;
  const lines = async (id: number) =>
    (await pool.query(`SELECT actor_email, entity_name, metadata FROM activity_log WHERE type = 'survey_relabelled' AND entity_id = $1`, [String(id)])).rows;

  console.log("\n[1] the options are the survey's own list");
  const options = (await relabel.getTherapistOptions()).map((o) => o.label).filter((l) => PROVIDERS.some((p) => l.startsWith(p)));
  eq("active + shown only, one per survey office", options,
    ["Amanda Plotner (ABQ)", "Amanda Plotner (LL)", "Angelica Chavez (ABQ)", "Kennedy Hull (ABQ)"]);

  console.log("\n[2] a change");
  const a = await insertSurvey("Angelica Villicana (RR)");
  const r = await relabel.relabelSurveyTherapist({ submissionId: a, toLabel: "Kennedy Hull (ABQ)", expectedFrom: "Angelica Villicana (RR)", actor: "staff@example.invalid" });
  ok("ok", r.ok, JSON.stringify(r));
  eq("label rewritten (office travels with it)", await labelOf(a), "Kennedy Hull (ABQ)");
  const l = await lines(a);
  eq("one activity line", l.length, 1);
  const meta = JSON.parse(l[0].metadata);
  eq("…by the staff member, fixed entity name, ids and labels only",
    [l[0].actor_email, l[0].entity_name, meta.submissionId, meta.provider, meta.from, meta.to, meta.toProviderId > 0],
    ["staff@example.invalid", "Client survey", a, "Kennedy Hull", "Angelica Villicana (RR)", "Kennedy Hull (ABQ)", true]);
  ok("not filed, so not flagged", r.ok && r.filedToChart === false);
  const rest = JSON.parse((await pool.query(`SELECT payload FROM form_submissions WHERE id = $1`, [a])).rows[0].payload);
  eq("nothing else in the survey changed", [rest.answers.overallRating, rest.client.name], [9, "ZZTEST Person 1"]);

  console.log("\n[3] refusals write nothing");
  const b = await insertSurvey("Kennedy Hull (ABQ)");
  const refuse = async (name: string, to: string, from: string | null, code: string, id = b) => {
    const before = [await labelOf(id), (await lines(id)).length];
    const res = await relabel.relabelSurveyTherapist({ submissionId: id, toLabel: to, expectedFrom: from, actor: "staff@example.invalid" });
    ok(`${name}: refused (${code})`, !res.ok && res.code === code, JSON.stringify(res));
    eq(`${name}: unchanged`, [await labelOf(id), (await lines(id)).length], before);
  };
  await refuse("a hidden provider", "Angelica Villicana (RR)", "Kennedy Hull (ABQ)", "not_offered");
  await refuse("an inactive provider", "Zztest Gone (ABQ)", "Kennedy Hull (ABQ)", "not_offered");
  await refuse("an office the provider is not offered at", "Kennedy Hull (LL)", "Kennedy Hull (ABQ)", "not_offered");
  await refuse("a stale 'from' (someone changed it first)", "Angelica Chavez (ABQ)", "Angelica Villicana (RR)", "label_changed");
  await refuse("the same therapist", "Kennedy Hull (ABQ)", "Kennedy Hull (ABQ)", "unchanged");
  await pool.query(`UPDATE form_submissions SET deleted_at = NOW() WHERE id = $1`, [b]);
  await refuse("a deleted survey", "Angelica Chavez (ABQ)", "Kennedy Hull (ABQ)", "not_found");

  console.log("\n[4] a survey with no therapist, and one already filed");
  const c = await insertSurvey("");
  await pool.query(`UPDATE form_submissions SET payload = (payload::jsonb #- '{answers,therapist}')::text WHERE id = $1`, [c]);
  const rc = await relabel.relabelSurveyTherapist({ submissionId: c, toLabel: "Angelica Chavez (ABQ)", expectedFrom: null, actor: "staff@example.invalid" });
  ok("no therapist given → one can be set", rc.ok && (await labelOf(c)) === "Angelica Chavez (ABQ)", JSON.stringify(rc));
  const d = await insertSurvey("Angelica Villicana (RR)");
  await pool.query(`INSERT INTO survey_attach_attempts (submission_id, status, started_at, updated_at) VALUES ($1, 'attached', NOW(), NOW())`, [d]);
  const rd = await relabel.relabelSurveyTherapist({ submissionId: d, toLabel: "Amanda Plotner (ABQ)", expectedFrom: "Angelica Villicana (RR)", actor: "staff@example.invalid" });
  ok("filed: changed in the CRM and flagged", rd.ok && rd.filedToChart === true && (await labelOf(d)) === "Amanda Plotner (ABQ)", JSON.stringify(rd));
  ok("…and the attach row is untouched", (await pool.query(`SELECT status FROM survey_attach_attempts WHERE submission_id = $1`, [d])).rows[0].status === "attached");

  console.log("\n[5] the stale-tab guard");
  eq("pure: all hidden → hidden", isHiddenOnSurvey([{ show_on_survey: false }]), true);
  eq("pure: one shown of two → not hidden", isHiddenOnSurvey([{ show_on_survey: false }, { show_on_survey: true }]), false);
  eq("pure: no active provider of that name → not hidden", isHiddenOnSurvey([]), false);
  eq("hidden provider", await therapistHiddenFromSurvey("Angelica Villicana (RR)"), true);
  eq("…case and spacing do not matter", await therapistHiddenFromSurvey("angelica  VILLICANA (RR)"), true);
  eq("shown provider", await therapistHiddenFromSurvey("Kennedy Hull (ABQ)"), false);
  eq("inactive provider: left to review, as before", await therapistHiddenFromSurvey("Zztest Gone (ABQ)"), false);
  eq("unknown name: left to review, as before", await therapistHiddenFromSurvey("Nobody Here (ABQ)"), false);

  // Through the real public route.
  const { registerSurveyPublicRoutes } = await import("../server/survey/routes");
  const { buildSubmitBody } = await import("../client-survey/src/submit-body");
  const { questionsFor } = await import("../shared/survey-questions");
  const app = express();
  app.use(express.json());
  registerSurveyPublicRoutes(app);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const post = async (therapist: string, lang: "en" | "es") => {
    const draft: any = {
      client: { name: "ZZTEST Route Person", dateOfBirth: "1990-04-12", email: "zztest@example.invalid", phone: "(505) 555-0142" },
      answers: {}, comments: {},
    };
    for (const q of questionsFor("in-person") as any[]) {
      if (q.kind === "scale") draft.answers[q.key] = 6;
      else if (q.kind === "choice") draft.answers[q.key] = q.options[1];
      else if (q.kind === "therapist") draft.answers[q.key] = therapist;
      else draft.answers[q.key] = "ZZTEST closing comment";
    }
    const body = buildSubmitBody("in-person", { ...draft, language: lang }, lang, Date.now() - 60_000, "");
    const res = await fetch(`http://127.0.0.1:${port}/api/public/survey/in-person`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) as any };
  };
  const count = async () => Number((await pool.query(`SELECT COUNT(*)::int n FROM form_submissions WHERE name = 'ZZTEST Route Person'`)).rows[0].n);
  const before = await count();
  const rej = await post("Angelica Villicana (RR)", "en");
  eq("a survey naming a hidden provider is refused (409)", rej.status, 409);
  eq("…with the reload message", rej.json.error,
    "The therapist you picked is no longer on this form. Please reload the page and pick your therapist again.");
  const { MESSAGE_COPY } = await import("../shared/survey-copy.es");
  ok("…which has Spanish", !!MESSAGE_COPY[rej.json.error]);
  eq("…and nothing is stored", await count(), before);
  const okRes = await post("Kennedy Hull (ABQ)", "es");
  eq("a shown provider is still accepted", [okRes.status, okRes.json.success], [200, true]);
  eq("…and stored", await count(), before + 1);
  server.close();

  await new Promise((r) => setTimeout(r, 500)); // let the arrival match settle before teardown
  await pool.query(`DELETE FROM form_submissions WHERE name LIKE 'ZZTEST%'`);
  await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log(`FAILED: ${failures.join("; ")}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
