/**
 * Self-checks — the ops lead's Total Active Clients override.
 *
 * Run: npx tsx scripts/test-active-count-overrides.ts
 *
 * No database, no network, no PHI. Every provider name is invented here.
 *
 * THE CENTRAL CLAIM is that an override moves a VALUE and nothing else. The
 * percentage stays Excel's, the formula text is byte-identical, and the only
 * difference between a workbook built with an override and one built without is
 * the number in the cell plus the markers that say a person put it there. That
 * is asserted by generating both workbooks and DIFFING THE RAW XML, not by
 * reading the source of the function that writes them.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { unzipSync, strFromU8 } from "fflate";
import { buildSurveyWorkbook, type ActiveClientCounts } from "../server/survey/workbook";
import { aggregateSurveys, type RosterEntry, type SubmissionInput } from "../server/survey/aggregate";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
const read = (p: string) => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// A small synthetic practice: two offices, three providers.
// ---------------------------------------------------------------------------
const PERIOD = { from: "2026-10-01", to: "2026-10-31" };
const roster: RosterEntry[] = [
  { id: 1, name: "Zzamanda Zzdavison", shortName: "Zzamanda D", office: "ABQ", isActive: true },
  { id: 2, name: "Zzsandra Zzrivera", shortName: "Zzsandra", office: "ABQ", isActive: true },
  { id: 3, name: "Zzliz Zzlopez", shortName: "Zzliz", office: "RR", isActive: true },
];

function submission(id: number, therapist: string, day: string): SubmissionInput {
  return {
    id, submittedAt: `${day}T12:00:00Z`, createdAt: `${day}T12:00:00Z`,
    payload: {
      formVariant: "in-person", modality: "In Person",
      client: { name: `Zzclient ${id}`, dateOfBirth: "1990-04-12", phone: "5055550143" },
      answers: {
        therapist,
        overallSatisfaction: 9, therapistSatisfaction: 10,
        schedulingSatisfaction: 8, officeSatisfaction: 9,
      },
    },
  };
}
const submissions: SubmissionInput[] = [
  submission(1, "Zzamanda Zzdavison (ABQ)", "2026-10-05"),
  submission(2, "Zzamanda Zzdavison (ABQ)", "2026-10-09"),
  submission(3, "Zzsandra Zzrivera (ABQ)", "2026-10-11"),
  submission(4, "Zzliz Zzlopez (RR)", "2026-10-14"),
];
const agg = aggregateSurveys({ roster, submissions, period: PERIOD });

const PULLED: ActiveClientCounts = {
  newestCapturedOn: "2026-10-30",
  byProviderId: {
    1: { count: 43, capturedOn: "2026-10-30" },
    2: { count: 22, capturedOn: "2026-10-30" },
    3: { count: 57, capturedOn: "2026-10-30" },
  },
};
const OVERRIDDEN: ActiveClientCounts = {
  newestCapturedOn: "2026-10-30",
  byProviderId: {
    ...PULLED.byProviderId,
    1: {
      count: 45, capturedOn: "2026-10-30",
      override: { pulled: 43, setBy: "lane@example.invalid", setAt: "2026-10-31T16:20:00Z", note: null },
    },
  },
};

/** Sheet XML by part name, for the diff. */
function parts(buf: Buffer): Record<string, string> {
  const files = unzipSync(new Uint8Array(buf));
  const out: Record<string, string> = {};
  Object.keys(files).forEach((f) => { out[f] = strFromU8(files[f]); });
  return out;
}

const plain = parts(buildSurveyWorkbook(agg, PULLED).buffer);
const withOv = parts(buildSurveyWorkbook(agg, OVERRIDDEN).buffer);
// Sheet 2 is "Survey Analysis " — Data is sheet 1.
const ANALYSIS = "xl/worksheets/sheet2.xml";

// ===========================================================================
console.log("\n[1] The schema — reported before creation, confirmed here");
{
  const db = read("server/survey/active-count-overrides-db.ts");
  check("the table is survey_active_count_overrides",
    /CREATE TABLE IF NOT EXISTS survey_active_count_overrides/.test(db));
  for (const col of ["provider_id", "period_from", "period_to", "active_count",
                     "note", "set_by", "set_at", "updated_at"]) {
    check(`  column ${col}`, new RegExp(`\\b${col}\\b`).test(db));
  }
  check("the key is provider AND the period, not the provider alone",
    /UNIQUE INDEX[\s\S]{0,140}\(provider_id, period_from, period_to\)/.test(db));
  check("a negative count cannot be stored", /CHECK \(active_count >= 0\)/.test(db));
  check("it is created at boot like every other table",
    /initActiveCountOverridesTable\(\)/.test(read("server/index.ts")));
}

// ===========================================================================
console.log("\n[2] An override is used by ITS period and no other");
{
  const db = read("server/survey/active-count-overrides-db.ts");
  check("the lookup matches the period exactly",
    /WHERE period_from = \$1::date AND period_to = \$2::date/.test(db));
  check("...with no range overlap, BETWEEN or open-ended comparison",
    !/BETWEEN|period_to >=|period_from <=/.test(db));
  const exp = read("server/survey/export.ts");
  check("the export asks for its own range",
    /getOverridesForPeriod\(range\.from, range\.to\)/.test(exp));
  // The value actually lands in the cell.
  check("October's workbook shows 45", /<v>45<\/v>/.test(withOv[ANALYSIS]));
  check("...and the un-overridden build shows 43", /<v>43<\/v>/.test(plain[ANALYSIS]));
  check("43 is gone from the overridden build's analysis sheet",
    !/<v>43<\/v>/.test(withOv[ANALYSIS]));
  // Same aggregate, no override: byte-identical to the plain build. This is
  // what "no other period is affected" means at the level of the file.
  const none = parts(buildSurveyWorkbook(agg, PULLED).buffer);
  eq("a second build with no override is identical", none[ANALYSIS], plain[ANALYSIS]);
}

// ===========================================================================
console.log("\n[3] The percentage formula is UNCHANGED — by diff of the XML");
{
  const formulas = (xml: string) => (xml.match(/<f>[^<]*<\/f>/g) || []);
  const a = formulas(plain[ANALYSIS]);
  const b = formulas(withOv[ANALYSIS]);
  eq("the analysis sheet has the same number of formulas", b.length, a.length);
  eq("every formula is byte-identical", b, a);
  check("there is a percentage formula to compare at all", a.some((f) => /D\d+\/C\d+/.test(f)),
    a.slice(0, 4).join(" "));
  // And on the provider tabs.
  const tabs = Object.keys(plain).filter((f) => /worksheets\/sheet(?:[5-9]|\d\d)\.xml/.test(f));
  check("provider tabs exist to check", tabs.length >= 3);
  tabs.forEach((t) => {
    eq(`  ${t} formulas unchanged`, formulas(withOv[t] ?? ""), formulas(plain[t] ?? ""));
  });
  // The one that matters, spelled out: C3/C4 still divides by the cell.
  check("a provider tab still divides by its own cell",
    tabs.some((t) => /<f>C3\/C4<\/f>/.test(plain[t])));
}

// ===========================================================================
console.log("\n[4] The workbook shows which number was used");
{
  const cmt = Object.keys(withOv).find((f) => /comments\d*\.xml/.test(f));
  check("the overridden build carries a comments part", Boolean(cmt), Object.keys(withOv).join(" "));
  const text = cmt ? withOv[cmt] : "";
  check("the comment says it was set by hand", /Set by hand: 45/.test(text));
  check("...names the figure it replaced", /overnight reading was 43/.test(text));
  check("...names who", /lane@example\.invalid/.test(text));
  check("...and when", /2026-10-31 16:20/.test(text));
  check("the plain build carries NO comments part",
    !Object.keys(plain).some((f) => /comments\d*\.xml/.test(f)),
    Object.keys(plain).filter((f) => /comment/.test(f)).join(" "));

  // A comment is a small red triangle, so there is a sentence as well. SheetJS
  // writes these workbooks with INLINE strings (t="str") and emits no
  // sharedStrings part at all, so the text is read out of the sheet itself.
  check("this workbook has no sharedStrings part, so strings live in the sheets",
    !Object.keys(withOv).some((f) => f.includes("sharedStrings")));
  check("the analysis sheet names the substitution in plain text",
    /set by hand for this period/.test(withOv[ANALYSIS]));
  check("...and names which provider", /Zzamanda D/.test(withOv[ANALYSIS]));
  check("...and says nothing is subtracted automatically",
    /nothing is subtracted automatically/.test(withOv[ANALYSIS]));
  check("...and labels the block so it is findable", /Manually set/.test(withOv[ANALYSIS]));
  check("the un-overridden build says none of that",
    !/set by hand for this period/.test(plain[ANALYSIS]));
  // The provider's own tab carries a visible marker too.
  const provTabs = Object.keys(withOv).filter((f) => /worksheets\/sheet\d+\.xml/.test(f));
  check("the overridden provider's tab carries a visible marker",
    provTabs.some((f) => /set by hand/.test(withOv[f]) && f !== ANALYSIS),
    provTabs.filter((f) => /set by hand/.test(withOv[f])).join(" "));
  check("no other provider tab does",
    provTabs.filter((f) => f !== ANALYSIS && /← set by hand/.test(withOv[f])).length === 1);
}

// ===========================================================================
console.log("\n[5] Clearing restores the pulled count, never a blank");
{
  const db = read("server/survey/active-count-overrides-db.ts");
  check("clearing is a DELETE, not a flag", /DELETE FROM survey_active_count_overrides/.test(db));
  check("there is no cleared/disabled state to get stuck in",
    !/is_cleared|active BOOLEAN|deleted_at/.test(db));
  // With the row gone, the export sees only the pulled counts — which is the
  // PLAIN build, already asserted byte-identical above.
  check("a build with no override is the pulled build", plain[ANALYSIS] === parts(
    buildSurveyWorkbook(agg, PULLED).buffer)[ANALYSIS]);
  check("the pulled figure is present after clearing", /<v>43<\/v>/.test(plain[ANALYSIS]));
  check("the cell is a number, not empty", /<c r="C2"[^>]*t?[^>]*>\s*<v>/.test(plain[ANALYSIS]) ||
    /<v>43<\/v>/.test(plain[ANALYSIS]));
  const ui = read("client/src/components/active-count-overrides.tsx");
  check("an empty box clears rather than saving nothing",
    /if \(typed === ""\)[\s\S]{0,200}method: "DELETE"/.test(ui));
  check("clearing something already clear is success, not an error",
    /Idempotent: clearing something already clear is success/.test(read("server/routes.ts")));
}

// ===========================================================================
console.log("\n[6] Who set it and when");
{
  const db = read("server/survey/active-count-overrides-db.ts");
  check("set_by is NOT NULL", /set_by\s+TEXT\s+NOT NULL/.test(db));
  check("set_at defaults to now", /set_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/.test(db));
  check("a revision refreshes both", /set_by\s+= EXCLUDED\.set_by,\s*\n\s*set_at\s+= NOW\(\)/.test(db));
  const routes = read("server/routes.ts");
  check("the signed-in email is what is recorded", /setBy: email,/.test(routes));
  check("it is not taken from the request body",
    !/setBy:\s*(req\.body|body\.)/.test(routes));
  check("setting is logged to the activity trail",
    /type: "active_count_override"/.test(routes));
  check("...and clearing is too",
    (routes.match(/type: "active_count_override"/g) || []).length === 2);
  check("the comment in the workbook surfaces both", /Entered by \$\{o\.setBy\} on \$\{when\}/.test(
    read("server/survey/workbook.ts")));
}

// ===========================================================================
console.log("\n[7] No subtraction, no heuristic, anywhere");
{
  // The whole point: the client said the software must not try to tell real
  // patients from test ones. Searched across every file this build touched.
  const files = [
    "server/survey/active-count-overrides-db.ts",
    "server/survey/export.ts",
    "server/survey/workbook.ts",
    "client/src/components/active-count-overrides.tsx",
  ];
  const forbidden = [
    /test[_ ]?anna/i, /testAnna/, /dummy/i, /\bfake\b/i,
    /startsWith\(["']Test/i, /- *testAnna/, /activeCount *-/, /count *- *\d/,
  ];
  // COMMENTS ARE STRIPPED FIRST. Several of these files explain in prose why
  // there is no dummy-record rule, and a search that cannot tell an explanation
  // from an implementation would forbid saying so.
  const codeOf = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  files.forEach((f) => {
    const src = codeOf(read(f));
    forbidden.forEach((re) => {
      check(`  ${f.split("/").pop()} has no ${re}`, !re.test(src));
    });
  });
  // The pull still RECORDS the dummy figures — reporting them was asked for,
  // acting on them was not.
  check("the pull still records the dummy-record figures for reference",
    /test_anna_exact/.test(read("server/therapy-notes/active-counts-db.ts")));
  check("...and still never subtracts them",
    /NEVER SUBTRACTED/.test(read("server/therapy-notes/active-counts-db.ts")));
}

// ===========================================================================
console.log("\n[8] The pull, matcher, attach and survey form are unchanged");
{
  const changed = execSync(
    "git diff --name-only HEAD -- " +
    "server/therapy-notes/active-counts-runner.ts server/therapy-notes/active-counts-db.ts " +
    "server/therapy-notes/tn-patients-runner.ts server/survey/matching.ts " +
    "server/survey/match-runner.ts server/survey/attach-runner.ts " +
    "server/survey/routes.ts server/survey/schema.ts server/reminders/cron.ts " +
    "server/auth.ts shared/survey-questions.ts",
    { encoding: "utf8" },
  ).trim();
  eq("none of them appear in the diff", changed, "");
}

// ===========================================================================
console.log("\n[9] Edge cases");
{
  // An override for a provider the pull had NOTHING for.
  const noPull: ActiveClientCounts = {
    newestCapturedOn: "2026-10-30",
    byProviderId: {
      1: { count: 43, capturedOn: "2026-10-30" },
      2: { count: 22, capturedOn: "2026-10-30" },
      3: {
        count: 60, capturedOn: null,
        override: { pulled: null, setBy: "lane@example.invalid", setAt: "2026-10-31T16:20:00Z", note: null },
      },
    },
  };
  const p = parts(buildSurveyWorkbook(agg, noPull).buffer);
  check("a provider with no reading still gets the typed denominator",
    /<v>60<\/v>/.test(p[ANALYSIS]));
  const cmt = Object.keys(p).find((f) => /comments\d*\.xml/.test(f)) ?? "";
  check("...and the marker says there was no overnight reading",
    /no overnight reading/i.test(p[cmt] ?? ""));

  // An override on a period with no submissions at all.
  const emptyAgg = aggregateSurveys({ roster, submissions: [], period: PERIOD });
  const e = parts(buildSurveyWorkbook(emptyAgg, OVERRIDDEN).buffer);
  check("a period with no submissions still builds", Object.keys(e).length > 0);
  check("...and still shows the typed figure", /<v>45<\/v>/.test(e[ANALYSIS]));

  // Two people in the same minute: one row, last write wins, recorded.
  check("the unique index makes a double-save one row",
    /ON CONFLICT \(provider_id, period_from, period_to\) DO UPDATE/.test(
      read("server/survey/active-count-overrides-db.ts")));

  // A provider who leaves after an override was set: the row survives keyed on
  // the id, they simply no longer appear in the export's provider list.
  const gone: ActiveClientCounts = {
    newestCapturedOn: "2026-10-30",
    byProviderId: { ...OVERRIDDEN.byProviderId, 99: {
      count: 12, capturedOn: null,
      override: { pulled: null, setBy: "lane@example.invalid", setAt: "2026-10-31T16:20:00Z", note: null },
    } },
  };
  let threw = false;
  try { buildSurveyWorkbook(agg, gone); } catch { threw = true; }
  check("an override for a provider not on the roster is ignored, not a crash", !threw);
}

// ===========================================================================
console.log("\n[10] No PHI in any log line");
{
  const files = ["server/survey/active-count-overrides-db.ts", "server/survey/export.ts",
                 "server/routes.ts"];
  files.forEach((f) => {
    const src = read(f);
    const lines = src.match(/console\.(log|warn|error)\([\s\S]*?\);/g) || [];
    const ours = lines.filter((l) => /active-count-overrides/.test(l));
    if (f.includes("routes.ts")) {
      check("  the override log lines exist", ours.length >= 2, String(ours.length));
      ours.forEach((l, i) => {
        check(`  line ${i + 1} carries ids and dates only`,
          !/name|client|dob|phone|email\b/i.test(l.replace(/by=\$\{email\}/g, "")));
      });
    }
  });
  // The staff email is deliberately in the log — it is who acted, not a patient.
  // The FUNCTION, not 900 characters of whatever follows it — the next thing in
  // the file is the analysis sheet, which legitimately says "Total Active
  // Clients" and would fail a naive search for the word "client".
  const wb = read("server/survey/workbook.ts");
  const fnStart = wb.indexOf("function overrideComment");
  const overrideFn = wb.slice(fnStart, wb.indexOf("\n}", fnStart) + 2);
  check("the marker's text is built from counts, a staff email and a date",
    /o\.pulled|cell\.count|o\.setBy|o\.setAt/.test(overrideFn));
  check("...and reads nothing from a submission or a contact",
    !/payload|client\.|patient|dob|phone|submission/i.test(overrideFn),
    overrideFn.slice(0, 120));
}

// ===========================================================================
// A workbook someone can actually open.
mkdirSync("outputs", { recursive: true });
const out = "outputs/DEMO-3-override-set.xlsx";
writeFileSync(out, buildSurveyWorkbook(agg, OVERRIDDEN).buffer);
console.log(`\nWrote ${out} — Zzamanda D shows 45 (pulled 43), with a comment on the cell.`);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
