/**
 * Survey export fixture — seed, aggregate, report, remove.
 *
 * Run against a throwaway local Postgres, NEVER production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55432/tfc_exporttest \
 *     npx tsx scripts/fixture-survey-export.ts
 *
 * Add --keep to leave the rows in place for manual poking; the default is to
 * remove them and assert that the removal worked.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 32 stored survey submissions are synthetic, predate several form changes
 * and carry no `comments` object at all. Since a provider tab shows only
 * commented responses, a run against them produces 26 empty tabs — so the
 * workbook builder cannot be checked against anything. This seeds a set that
 * exercises every sheet, every table and every edge the export has to handle,
 * and it is what that builder gets verified against.
 *
 * DESIGNED FOR COVERAGE, NOT FOR PLAUSIBILITY. Volumes are deliberately
 * lopsided so the office rollups are distinguishable rather than symmetric, one
 * provider scores consistently low so the negative listings have something real
 * in them, and every option of every non-rating question appears at least once —
 * including N/A, which the template has no column for and the aggregation counts
 * anyway.
 *
 * REFUSES TO RUN ANYWHERE BUT THE NAMED TEST DATABASE. It writes providers and
 * submissions, and the content below is deliberately negative feedback attached
 * to named providers. That does not belong in a table staff read. See
 * assertLocalDatabase(), which mirrors scripts/test-survey-matching-run.ts:41.
 *
 * NO PHI. Every client identity is invented for this file, on the reserved
 * example.invalid domain and the reserved 555-01xx/555-02xx phone range, using
 * the same conventions as the matching fixture. Provider names are staff names
 * and are real on purpose: resolution, short names and offices are what is
 * being exercised.
 */
import { getPool } from "../server/db/pool";
import { initSyncTables } from "../server/sync/db";
import { initRemindersTable } from "../server/reminders/db";
import { aggregateSurveys, type RosterEntry, type SubmissionInput } from "../server/survey/aggregate";
import { providerShortName } from "@shared/provider-short-name";

const KEEP = process.argv.indexOf("--keep") !== -1;

/** One rule removes the whole fixture. */
const ID_MIN = 990200;
const ID_MAX = 990299;
const PROVIDER_ID_MIN = 990900;
const PROVIDER_ID_MAX = 990999;

const PERIOD = { from: "2026-07-01", to: "2026-09-30" };

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const isLocal = /@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_exporttest/.test(url);
  if (!isLocal) {
    console.error(
      "REFUSING TO RUN. This script writes providers and survey submissions,\n" +
      "including negative feedback against named providers, and must only point\n" +
      "at the throwaway local database. Expected a DATABASE_URL on\n" +
      "127.0.0.1/localhost naming tfc_exporttest.",
    );
    process.exit(2);
  }
}

// ===========================================================================
// Providers
// ===========================================================================

interface FixtureProvider { id: number; name: string; short: string; office: string; active: boolean }

const PROVIDERS: FixtureProvider[] = [
  { id: 990900, name: "Anna Aldridge",    short: "Anna",     office: "ABQ", active: true },
  { id: 990901, name: "Amanda Davison",   short: "Amanda D", office: "ABQ", active: true },
  { id: 990902, name: "Krista Luna",      short: "Krista",   office: "ABQ", active: true },
  { id: 990903, name: "Bentley Carbone",  short: "Bentley",  office: "ABQ", active: true }, // no submissions
  { id: 990904, name: "Jill Nantze",      short: "Jill",     office: "LL",  active: true },
  { id: 990905, name: "Amber Lute",       short: "Amber L",  office: "LL",  active: true },
  { id: 990906, name: "Kristi Simmons",   short: "Kristi",   office: "LL",  active: true }, // only row is out of range
  { id: 990907, name: "Renee Singletary", short: "Renee",    office: "RR",  active: true },
  { id: 990908, name: "Ginger Rippey",    short: "Ginger",   office: "RR",  active: true }, // consistently low
  { id: 990909, name: "Amber Merritt",    short: "Amber M",  office: "RR",  active: false }, // departed
];

// ===========================================================================
// Comment shapes the builder has to survive
// ===========================================================================

/** Exactly COMMENT_MAX (1000) characters. */
const AT_CAP = ("The waiting room chairs are past their best and the magazines are from another decade. " +
  "I have mentioned it at reception twice. ").repeat(9).slice(0, 1000);
const WITH_APOSTROPHE = "It's been up and down, honestly.";
const WITH_NON_ASCII = "Lobby was a bit tired — carpets need a clean, and the café sign is crooked.";
const WITH_LINE_BREAK = "Bathroom ran out of soap twice.\nOtherwise fine.\nStaff were kind.";
const EMPTY = "";

/** A comment on every commentable question, for the eleven-comment edge case. */
const EVERY_QUESTION_TH: Record<string, string> = {
  therapist: "Picked the right name, I think.",
  platformSatisfaction: "The platform is the worst part of this.",
  techDifficultyResponse: "Nobody rang back.",
  seenWithinTenMinutes: "Started late again.",
  privacyRespected: "I could hear another conversation.",
  endedFeelingValued: "Did not feel like a priority.",
  connectionRating: "We have not clicked.",
  goalsRating: "We have never written down a goal.",
  approachRating: "The approach is not for me.",
  overallRating: "I am considering other options.",
  followUpRequested: "Yes please, someone call me.",
};

// ===========================================================================
// Submissions
// ===========================================================================

type Choices = [string, string, string, string, string];

interface FixtureSub {
  id: number;
  date: string;
  variant: "in-person" | "telehealth";
  /** The therapist ANSWER exactly as stored — label form, office included. */
  label: string;
  client: string;
  choices: Choices;
  ratings: [number, number, number, number];
  comments?: Record<string, string>;
  note?: string;
}

const IP_KEYS = ["facilityClean", "greetedOnArrival", "seenWithinTenMinutes", "privacyRespected", "endedFeelingValued"];
const TH_KEYS = ["platformSatisfaction", "techDifficultyResponse", "seenWithinTenMinutes", "privacyRespected", "endedFeelingValued"];
const RATING_KEYS = ["connectionRating", "goalsRating", "approachRating", "overallRating"];

const SUBS: FixtureSub[] = [
  // ---- IN PERSON ------------------------------------------------------
  { id: 990201, date: "2026-07-01", variant: "in-person", label: "Anna Aldridge (ABQ)", client: "Wendell Puffin",
    choices: ["Excellent", "Yes", "Yes", "Yes", "Yes"], ratings: [10, 10, 9, 10],
    note: "period start boundary; every optional field blank" },
  { id: 990202, date: "2026-07-14", variant: "in-person", label: "Anna Aldridge (ABQ)", client: "Marigold Thistleby",
    choices: ["Satisfied", "No", "N/A", "Yes", "No"], ratings: [8, 7, 8, 9],
    comments: { greetedOnArrival: "No one at the desk when I arrived.", overallRating: "Very happy overall." } },
  { id: 990203, date: "2026-08-03", variant: "in-person", label: "Anna Aldridge (ABQ)", client: "Barnaby Quillfeather",
    choices: ["Neutral", "N/A", "No", "No", "N/A"], ratings: [5, 4, 6, 5],
    comments: { facilityClean: WITH_NON_ASCII, connectionRating: WITH_APOSTROPHE },
    note: "non-ASCII and apostrophe" },
  { id: 990204, date: "2026-09-20", variant: "in-person", label: "Anna Aldridge (ABQ)", client: "Odette Marchbanks",
    choices: ["Could be better", "Yes", "Yes", "Yes", "Yes"], ratings: [7, 6, 7, 8],
    comments: { facilityClean: WITH_LINE_BREAK }, note: "embedded line breaks" },
  // Stale office in the label: this provider is ABQ today.
  { id: 990205, date: "2026-08-11", variant: "in-person", label: "Amanda Davison (Corp)", client: "Casimir Underhill",
    choices: ["Needs improvement immediately", "No", "No", "N/A", "No"], ratings: [2, 3, 2, 1],
    comments: { facilityClean: AT_CAP }, note: "stale office in label; comment at the 1000-char cap" },
  { id: 990206, date: "2026-09-02", variant: "in-person", label: "Amanda Davison (ABQ)", client: "Perpetua Glimmerwick",
    choices: ["Excellent", "Yes", "Yes", "Yes", "Yes"], ratings: [9, 9, 10, 9] },
  { id: 990207, date: "2026-07-22", variant: "in-person", label: "Krista Luna (ABQ)", client: "Ignatius Fernwhistle",
    choices: ["Satisfied", "N/A", "Yes", "N/A", "Yes"], ratings: [6, 7, 6, 7] },
  { id: 990208, date: "2026-08-28", variant: "in-person", label: "Jill Nantze (LL)", client: "Clementine Roswold",
    choices: ["Neutral", "Yes", "N/A", "Yes", "Yes"], ratings: [8, 8, 7, 8],
    comments: { facilityClean: EMPTY }, note: "an empty comment must produce no listing row" },
  { id: 990209, date: "2026-09-10", variant: "in-person", label: "Jill Nantze (LL)", client: "Horatio Pennyquick",
    choices: ["Could be better", "No", "Yes", "No", "N/A"], ratings: [4, 5, 4, 3],
    comments: { endedFeelingValued: "Felt rushed at checkout." }, note: "comment on a NON-rated question" },
  { id: 990210, date: "2026-07-30", variant: "in-person", label: "Amber Lute (LL)", client: "Seraphina Dunwoody",
    choices: ["Excellent", "Yes", "Yes", "Yes", "Yes"], ratings: [10, 9, 10, 10] },
  { id: 990211, date: "2026-08-18", variant: "in-person", label: "Ginger Rippey (RR)", client: "Bartholomew Kettleby",
    choices: ["Needs improvement immediately", "No", "No", "No", "No"], ratings: [0, 1, 0, 0],
    comments: { facilityClean: "Waiting room was not clean.", connectionRating: "I did not feel heard at all.", overallRating: "Considering going elsewhere." },
    note: "the low scorer" },
  { id: 990212, date: "2026-09-05", variant: "in-person", label: "Ginger Rippey (RR)", client: "Lavinia Crowhurst",
    choices: ["Could be better", "No", "N/A", "No", "No"], ratings: [1, 0, 2, 1],
    comments: { approachRating: "The approach has not worked for me." } },
  { id: 990213, date: "2026-08-22", variant: "in-person", label: "Amber Merritt (RR)", client: "Percival Oakhame",
    choices: ["Neutral", "N/A", "No", "Yes", "Yes"], ratings: [5, 5, 5, 5],
    comments: { seenWithinTenMinutes: "Waited about 25 minutes." }, note: "departed provider" },
  { id: 990214, date: "2026-09-12", variant: "in-person", label: "Fenwick Marlowe (ABQ)", client: "Rosamund Ellerby",
    choices: ["Satisfied", "Yes", "Yes", "Yes", "Yes"], ratings: [7, 7, 7, 7],
    note: "UNRESOLVABLE therapist label" },

  // ---- TELEHEALTH -----------------------------------------------------
  { id: 990220, date: "2026-07-08", variant: "telehealth", label: "Anna Aldridge (ABQ)", client: "Thaddeus Ravensworth",
    choices: ["Excellent", "Yes", "Yes", "Yes", "Yes"], ratings: [9, 9, 9, 10] },
  { id: 990221, date: "2026-08-15", variant: "telehealth", label: "Amanda Davison (ABQ)", client: "Millicent Farrowgate",
    choices: ["Satisfied", "No", "Yes", "Yes", "Yes"], ratings: [8, 8, 8, 8],
    comments: { techDifficultyResponse: "No call back when the video dropped." } },
  { id: 990222, date: "2026-09-18", variant: "telehealth", label: "Krista Luna (ABQ)", client: "Aurelius Binswick",
    choices: ["Neutral", "N/A", "N/A", "N/A", "N/A"], ratings: [6, 6, 5, 6],
    comments: { platformSatisfaction: "Audio kept cutting out." }, note: "N/A on all four telehealth Y/N questions" },
  { id: 990223, date: "2026-07-19", variant: "telehealth", label: "Jill Nantze (LL)", client: "Drusilla Hobbleton",
    choices: ["Could be better", "Yes", "No", "Yes", "No"], ratings: [4, 4, 3, 4] },
  { id: 990224, date: "2026-08-06", variant: "telehealth", label: "Renee Singletary (RR)", client: "Cornelius Wrenfield",
    choices: ["Needs improvement immediately", "No", "No", "No", "No"], ratings: [1, 2, 1, 1],
    comments: { platformSatisfaction: "Could never get the link to work.", overallRating: "Frustrating." } },
  { id: 990225, date: "2026-09-25", variant: "telehealth", label: "Renee Singletary (RR)", client: "Evangeline Portbury",
    choices: ["Excellent", "Yes", "Yes", "Yes", "Yes"], ratings: [10, 10, 10, 10] },
  { id: 990226, date: "2026-08-30", variant: "telehealth", label: "Ginger Rippey (RR)", client: "Ambrose Fitchett",
    choices: ["Could be better", "No", "No", "No", "No"], ratings: [0, 0, 1, 0],
    comments: EVERY_QUESTION_TH, note: "a comment on every commentable question" },
  { id: 990227, date: "2026-09-08", variant: "telehealth", label: "Amber Merritt (RR)", client: "Hyacinth Blenkinsop",
    choices: ["Satisfied", "Yes", "N/A", "Yes", "N/A"], ratings: [6, 5, 6, 6],
    note: "departed provider, telehealth" },

  // ---- OUTSIDE THE PERIOD ---------------------------------------------
  { id: 990230, date: "2026-06-15", variant: "in-person", label: "Kristi Simmons (LL)", client: "Leopold Ashcombe",
    choices: ["Excellent", "Yes", "Yes", "Yes", "Yes"], ratings: [10, 10, 10, 10],
    note: "BEFORE the period; Kristi's only submission" },
  { id: 990231, date: "2026-10-05", variant: "in-person", label: "Anna Aldridge (ABQ)", client: "Gwendolyn Straithe",
    choices: ["Excellent", "Yes", "Yes", "Yes", "Yes"], ratings: [10, 10, 10, 10],
    note: "AFTER the period" },
];

function payloadFor(s: FixtureSub): Record<string, unknown> {
  const keys = s.variant === "in-person" ? IP_KEYS : TH_KEYS;
  const answers: Record<string, unknown> = { therapist: s.label };
  keys.forEach((k, i) => { answers[k] = s.choices[i]; });
  RATING_KEYS.forEach((k, i) => { answers[k] = s.ratings[i]; });
  answers.followUpRequested = s.ratings[3] <= 3 ? "Yes" : "No";
  const payload: Record<string, unknown> = {
    surveyVersion: 1,
    formVariant: s.variant,
    modality: s.variant === "in-person" ? "In Person" : "Telehealth",
    submittedAt: `${s.date}T16:00:00.000Z`,
    client: {
      name: s.client,
      dateOfBirth: "1988-04-12",
      email: `${s.client.toLowerCase().replace(/[^a-z]+/g, ".")}@example.invalid`,
      phone: `(505) 555-02${String(s.id % 100).padStart(2, "0")}`,
    },
    answers,
  };
  if (s.comments) payload.comments = s.comments;
  return payload;
}

// ===========================================================================
// Seed / cleanup
// ===========================================================================

async function cleanup(): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM form_submissions WHERE id BETWEEN $1 AND $2`, [ID_MIN, ID_MAX]);
  await pool.query(`DELETE FROM crm_providers WHERE id BETWEEN $1 AND $2`, [PROVIDER_ID_MIN, PROVIDER_ID_MAX]);
}

async function seed(): Promise<void> {
  const pool = getPool();
  for (const p of PROVIDERS) {
    await pool.query(
      `INSERT INTO crm_providers (id, name, credentials, location, short_name, is_active)
       VALUES ($1, $2, '', $3, $4, $5)`,
      [p.id, p.name, p.office, p.short, p.active],
    );
  }
  for (const s of SUBS) {
    await pool.query(
      // submitted_at is TEXT and created_at is TIMESTAMPTZ, so the same value
      // has to be bound twice — one parameter for both makes Postgres refuse to
      // deduce a type ("inconsistent types deduced for parameter").
      `INSERT INTO form_submissions (id, form_type, source, submitted_at, name, payload, created_at)
       VALUES ($1, 'survey', 'client_survey_v1', $2, $3, $4, $5::timestamptz)`,
      [s.id, `${s.date}T16:00:00.000Z`, s.client, JSON.stringify(payloadFor(s)), `${s.date}T16:00:00.000Z`],
    );
  }
}

async function readBack(): Promise<{ roster: RosterEntry[]; submissions: SubmissionInput[] }> {
  const pool = getPool();
  const pr = await pool.query(
    `SELECT id, name, location, short_name, is_active FROM crm_providers ORDER BY name`,
  );
  const roster: RosterEntry[] = pr.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    shortName: providerShortName({ name: row.name, shortName: row.short_name }),
    office: row.location ?? "",
    isActive: row.is_active === true,
  }));
  const sr = await pool.query(
    `SELECT id, submitted_at, created_at, payload FROM form_submissions WHERE form_type = 'survey' ORDER BY id`,
  );
  const submissions: SubmissionInput[] = sr.rows.map((row: any) => ({
    id: row.id,
    submittedAt: row.submitted_at,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
  }));
  return { roster, submissions };
}

// ===========================================================================
// Report
// ===========================================================================

function n(v: number | null): string {
  return v === null ? "  —  " : v.toFixed(2).padStart(5);
}

async function main(): Promise<void> {
  assertLocalDatabase();
  await initSyncTables();
  await initRemindersTable();
  const pool = getPool();

  await cleanup();
  const before = (await pool.query(
    `SELECT (SELECT count(*)::int FROM form_submissions) s, (SELECT count(*)::int FROM crm_providers) p`,
  )).rows[0];
  console.log(`\nSTARTING COUNTS  form_submissions=${before.s}  crm_providers=${before.p}`);

  await seed();
  const seeded = (await pool.query(
    `SELECT (SELECT count(*)::int FROM form_submissions) s, (SELECT count(*)::int FROM crm_providers) p`,
  )).rows[0];
  console.log(`SEEDED           form_submissions=${seeded.s}  crm_providers=${seeded.p}`);

  const { roster, submissions } = await readBack();
  const r = aggregateSurveys({ roster, submissions, period: PERIOD });

  console.log(`\n=== AGGREGATION OVER THE FIXTURE (${PERIOD.from} .. ${PERIOD.to}) ===`);
  console.log(`submissions seeded      : ${SUBS.length}`);
  console.log(`counted in period       : ${r.submissionsInPeriod}`);
  console.log(`offices present         : ${JSON.stringify(r.offices)}`);
  console.log(`warnings                : ${r.warnings.length}`);

  console.log(`\n--- providers (active) ---`);
  console.log(`  office  short       n   conn  goals  appr  ovrl   rows`);
  r.providers.forEach((p) => {
    console.log(
      `  ${(p.office || "??").padEnd(7)} ${p.shortName.padEnd(10)} ${String(p.surveyCount).padStart(2)}  ` +
      `${n(p.averages.connectionRating)} ${n(p.averages.goalsRating)} ${n(p.averages.approachRating)} ${n(p.averages.overallRating)}   ` +
      `${String(p.listingRows.length).padStart(2)}`,
    );
  });

  console.log(`\n--- departed (counted, no tab) ---`);
  r.departed.forEach((p) => {
    console.log(`  ${(p.office || "??").padEnd(7)} ${p.shortName.padEnd(10)} ${String(p.surveyCount).padStart(2)}  ` +
      `${n(p.averages.connectionRating)} ${n(p.averages.goalsRating)} ${n(p.averages.approachRating)} ${n(p.averages.overallRating)}   ` +
      `${String(p.listingRows.length).padStart(2)}`);
  });

  console.log(`\n--- unresolved therapist labels ---`);
  r.unresolved.forEach((u) => console.log(`  ${u.reason.padEnd(10)} x${u.count}  ${JSON.stringify(u.label)}  ids=${JSON.stringify(u.submissionIds)}`));
  if (r.unresolved.length === 0) console.log("  (none)");

  console.log(`\n--- ratings breakdown ---`);
  r.ratings.forEach((b) => {
    const buckets = Object.keys(b.byBucket).sort();
    const total = buckets.reduce((t, k) => t + Object.keys(b.byBucket[k]).reduce((x, o) => x + b.byBucket[k][o], 0), 0);
    const missing = b.options.filter((o) => !buckets.some((k) => b.byBucket[k][o]));
    console.log(`  ${b.modality.padEnd(10)} ${b.key.padEnd(22)} n=${String(total).padStart(2)}  buckets=${JSON.stringify(buckets)}` +
      (missing.length ? `  UNCOVERED OPTIONS: ${JSON.stringify(missing)}` : "  all options covered"));
  });

  console.log(`\n--- negative listings ---`);
  r.negatives.forEach((l) => {
    const withComment = l.rows.filter((row) => row.comment !== "").length;
    console.log(`  ${l.modality.padEnd(10)} ${l.key.padEnd(22)} rows=${String(l.rows.length).padStart(2)} ` +
      `(${withComment} commented)  counts=${JSON.stringify(l.counts)}`);
  });

  if (r.warnings.length > 0) {
    console.log(`\n--- warnings ---`);
    r.warnings.forEach((w) => console.log(`  #${w.submissionId} ${w.code}: ${w.detail}`));
  }

  // ---- removal -------------------------------------------------------
  if (KEEP) {
    console.log(`\n--keep given; fixture left in place. Remove with:`);
    console.log(`  DELETE FROM form_submissions WHERE id BETWEEN ${ID_MIN} AND ${ID_MAX};`);
    console.log(`  DELETE FROM crm_providers    WHERE id BETWEEN ${PROVIDER_ID_MIN} AND ${PROVIDER_ID_MAX};`);
    await pool.end();
    return;
  }

  await cleanup();
  const after = (await pool.query(
    `SELECT (SELECT count(*)::int FROM form_submissions) s, (SELECT count(*)::int FROM crm_providers) p`,
  )).rows[0];
  const left = (await pool.query(
    `SELECT (SELECT count(*)::int FROM form_submissions WHERE id BETWEEN $1 AND $2) s,
            (SELECT count(*)::int FROM crm_providers   WHERE id BETWEEN $3 AND $4) p`,
    [ID_MIN, ID_MAX, PROVIDER_ID_MIN, PROVIDER_ID_MAX],
  )).rows[0];

  console.log(`\nAFTER REMOVAL    form_submissions=${after.s}  crm_providers=${after.p}`);
  console.log(`fixture rows left: submissions=${left.s} providers=${left.p}`);
  const clean = after.s === before.s && after.p === before.p && left.s === 0 && left.p === 0;
  console.log(clean ? "REMOVAL VERIFIED — counts returned to their starting values" : "REMOVAL FAILED");
  await pool.end();
  if (!clean) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});
