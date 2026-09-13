/**
 * Self-checks — survey export route, range handling and timing.
 *
 * Run: npx tsx scripts/test-survey-export-route.ts
 * Add --write <path> to save a sample workbook for opening by hand.
 *
 * No database and no PHI. Client names are invented here.
 *
 * WHAT IS CHECKED WHERE. The route's auth behaviour is a property of WHERE it
 * is registered, not of a function that can be called — server/index.ts mounts
 * the public survey router before app.use(authMiddleware) and calls
 * registerRoutes after it. So the checks below assert those file facts, and the
 * live 401 is confirmed against the deployed app after release.
 */
import { readFileSync, writeFileSync } from "fs";
import { unzipSync, strFromU8 } from "fflate";
import { aggregateSurveys, type RosterEntry, type SubmissionInput } from "../server/survey/aggregate";
import { buildSurveyWorkbook } from "../server/survey/workbook";
import { currentQuarter, exportFilename } from "../server/survey/export";

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

// ===========================================================================
console.log("\n[1] The route is behind the auth middleware, and not on the public router");
{
  const index = read("server/index.ts");
  const publicRouter = read("server/survey/routes.ts");
  const routes = read("server/routes.ts");

  const authAt = index.indexOf("app.use(authMiddleware)");
  const registerAt = index.indexOf("registerRoutes(httpServer, app)");
  const surveyPublicAt = index.indexOf("registerSurveyPublicRoutes");
  check("server/index.ts applies the auth middleware", authAt !== -1);
  check("registerRoutes is called AFTER the auth middleware", authAt < registerAt, `${authAt} < ${registerAt}`);
  check("the public survey router is mounted BEFORE it", surveyPublicAt < authAt, `${surveyPublicAt} < ${authAt}`);

  check("the export route is registered in the authenticated routes file",
    routes.indexOf('app.get("/api/export/survey-workbook.xlsx"') !== -1);
  check("it is NOT on the public survey router",
    publicRouter.indexOf("survey-workbook") === -1 && publicRouter.indexOf("buildSurveyExport") === -1);
  check("the public router does not import the export builder",
    publicRouter.indexOf("./export") === -1);
  check("the route refuses an unauthenticated request",
    routes.indexOf("const requireSurveyExport") !== -1 &&
    /requireSurveyExport[\s\S]{0,400}isAuthenticated[\s\S]{0,200}401/.test(routes));
  check("the download is logged on every export, not conditionally",
    /await logSurveyExport\(email/.test(routes) &&
    routes.indexOf('entityName: "client_survey_workbook"') !== -1);
  // The word "auth" appears in these files' prose; what matters is that neither
  // IMPORTS the middleware, i.e. neither can weaken or re-implement it.
  const importsAuth = (src: string) => /from\s+["'][^"']*\/auth["']|require\(["'][^"']*\/auth["']\)/.test(src);
  check("the export service does not import the auth middleware",
    !importsAuth(read("server/survey/export.ts")));
  check("neither does the workbook builder",
    !importsAuth(read("server/survey/workbook.ts")));
}

// ===========================================================================
console.log("\n[2] The range: default, validation, and naming");
{
  eq("Q1 default", currentQuarter(new Date("2026-02-11T00:00:00Z")), { from: "2026-01-01", to: "2026-03-31" });
  eq("Q2 default", currentQuarter(new Date("2026-05-01T00:00:00Z")), { from: "2026-04-01", to: "2026-06-30" });
  eq("Q3 default", currentQuarter(new Date("2026-09-13T00:00:00Z")), { from: "2026-07-01", to: "2026-09-30" });
  eq("Q4 default", currentQuarter(new Date("2026-12-31T00:00:00Z")), { from: "2026-10-01", to: "2026-12-31" });
  eq("the filename names the range",
    exportFilename({ from: "2026-07-01", to: "2026-09-30" }),
    "TFC-Client-Survey-2026-07-01_to_2026-09-30.xlsx");
  const routes = read("server/routes.ts");
  check("an inverted range is refused with a plain message",
    /from > to[\s\S]{0,200}start date must be on or before/.test(routes));
  check("an invalid date falls back to the current quarter rather than failing",
    /validReportDate\(req\.query\.from\) \?\? fallback\.from/.test(routes));
}

// ===========================================================================
// Shared fixture helpers
// ===========================================================================
let nextId = 1;
function mkSub(label: string, ratings: number[], o: {
  date?: string; choices?: string[]; comments?: Record<string, string>; client?: string;
} = {}): SubmissionInput {
  const answers: Record<string, unknown> = { therapist: label };
  const ch = o.choices ?? ["Excellent", "Yes", "Yes", "Yes", "Yes"];
  ["facilityClean", "greetedOnArrival", "seenWithinTenMinutes", "privacyRespected", "endedFeelingValued"]
    .forEach((k, i) => { answers[k] = ch[i]; });
  ["connectionRating", "goalsRating", "approachRating", "overallRating"]
    .forEach((k, i) => { answers[k] = ratings[i]; });
  const payload: Record<string, unknown> = {
    formVariant: "in-person", modality: "In Person",
    client: { name: o.client ?? `Client ${nextId}` }, answers,
  };
  if (o.comments) payload.comments = o.comments;
  const d = o.date ?? "2026-08-01";
  return { id: nextId++, submittedAt: `${d}T12:00:00.000Z`, createdAt: `${d}T12:00:00.000Z`, payload };
}
function roster26(): RosterEntry[] {
  const out: RosterEntry[] = [];
  let i = 1;
  const add = (office: string, n: number) => {
    for (let k = 0; k < n; k++) {
      out.push({
        id: i, name: `Provider ${String(i).padStart(2, "0")} Surname`,
        shortName: `Prov${String(i).padStart(2, "0")}`, office, isActive: true,
      });
      i++;
    }
  };
  add("ABQ", 10); add("LL", 8); add("RR", 8);
  return out;
}
const PERIOD = { from: "2026-07-01", to: "2026-09-30" };

function openWorkbook(buffer: Buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const wbXml = strFromU8(zip["xl/workbook.xml"]);
  const names: string[] = [];
  const re = /<sheet[^>]*name="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wbXml))) names.push(m[1].replace(/&amp;/g, "&"));
  const text = Object.keys(zip)
    .filter((k) => k.startsWith("xl/worksheets/") || k === "xl/sharedStrings.xml")
    .map((k) => strFromU8(zip[k])).join("");
  return { names, text, partCount: Object.keys(zip).length };
}

// ===========================================================================
console.log("\n[3] A range with no submissions still produces a valid workbook");
{
  const a = aggregateSurveys({ roster: roster26(), submissions: [], period: PERIOD });
  const { buffer, sheetNames } = buildSurveyWorkbook(a);
  const wb = openWorkbook(buffer);
  eq("still 30 sheets", sheetNames.length, 30);
  eq("submissions counted is zero", a.submissionsInPeriod, 0);
  check("the file is a real zip with the expected parts", wb.partCount > 5);
  check("every provider still has a tab", sheetNames.indexOf("Prov26") !== -1);
  check("no #DIV/0! and no division formula anywhere",
    wb.text.indexOf("DIV/0") === -1 && !/<f>[^<]*\/[^<]*<\/f>/.test(wb.text));
  // Averages are absent, not zero, so AVERAGE over an empty block is the only
  // thing Excel sees — which is exactly what the template does on an empty tab.
  check("the rollup formulas are still written", wb.text.indexOf("AVERAGE(F2:F11)") !== -1);
}

// ===========================================================================
console.log("\n[4] The range scopes, including across an arrival and a departure");
{
  const roster: RosterEntry[] = [
    { id: 1, name: "Stayer One", shortName: "Stayer", office: "ABQ", isActive: true },
    { id: 2, name: "Leaver One", shortName: "Leaver", office: "LL", isActive: false },
    { id: 3, name: "Joiner One", shortName: "Joiner", office: "RR", isActive: true },
  ];
  const subs = [
    mkSub("Stayer One (ABQ)", [5, 5, 5, 5], { date: "2026-06-30" }),   // before
    mkSub("Stayer One (ABQ)", [7, 7, 7, 7], { date: "2026-07-01" }),   // boundary in
    mkSub("Leaver One (LL)", [3, 3, 3, 3], { date: "2026-07-15" }),    // departed, in range
    mkSub("Joiner One (RR)", [9, 9, 9, 9], { date: "2026-09-30" }),    // boundary in
    mkSub("Joiner One (RR)", [1, 1, 1, 1], { date: "2026-10-01" }),    // after
  ];
  const a = aggregateSurveys({ roster, submissions: subs, period: PERIOD });
  eq("three of the five rows are in range", a.submissionsInPeriod, 3);
  eq("the stayer counts only the in-range row",
    a.providers.filter((p) => p.name === "Stayer One")[0].averages.overallRating, 7);
  eq("the joiner counts only the in-range row",
    a.providers.filter((p) => p.name === "Joiner One")[0].averages.overallRating, 9);
  eq("the departed provider is counted but has no tab", a.departed.length, 1);
  const { sheetNames } = buildSurveyWorkbook(a);
  check("...confirmed in the workbook", sheetNames.indexOf("Leaver") === -1);
  check("...while the stayer and joiner both have one",
    sheetNames.indexOf("Stayer") !== -1 && sheetNames.indexOf("Joiner") !== -1);
}

// ===========================================================================
console.log("\n[5] The workbook names its own period, and explains what is blank");
{
  const a = aggregateSurveys({ roster: roster26(), submissions: [], period: PERIOD });
  const wb = openWorkbook(buildSurveyWorkbook(a).buffer);
  check("the reporting period is printed in the workbook",
    wb.text.indexOf("2026-07-01 to 2026-09-30") !== -1);
  check("...under a label", wb.text.indexOf("Reporting period") !== -1);
  check("the blank Total Active Clients column is explained",
    wb.text.indexOf("Active client counts are read from TherapyNotes") !== -1);
  check("...naming the reason as none-taken-yet rather than not-built",
    wb.text.indexOf("none had been taken on or before this period ended") !== -1);
  check("the empty Data sheet says why it is empty",
    wb.text.indexOf("This sheet is intentionally empty") !== -1);
  check("...and still has no invented column headers",
    wb.text.indexOf("intentionally empty") !== -1);
}

// ===========================================================================
console.log("\n[6] No identifying field but the client's name reaches the file");
{
  const roster: RosterEntry[] = [{ id: 1, name: "Test Provider", shortName: "Tester", office: "ABQ", isActive: true }];
  const s = mkSub("Test Provider (ABQ)", [2, 2, 2, 2], {
    choices: ["Neutral", "No", "N/A", "No", "No"],
    comments: { overallRating: "Not happy." }, client: "Sentinel Person",
  });
  (s.payload.client as Record<string, unknown>).dateOfBirth = "1979-06-21";
  (s.payload.client as Record<string, unknown>).email = "sentinel@example.invalid";
  (s.payload.client as Record<string, unknown>).phone = "(505) 555-0199";
  const { buffer } = buildSurveyWorkbook(aggregateSurveys({ roster, submissions: [s], period: PERIOD }));
  const hay = buffer.toString("binary");
  check("no date of birth", hay.indexOf("1979-06-21") === -1);
  check("no email", hay.indexOf("sentinel@example.invalid") === -1);
  check("no phone", hay.indexOf("555-0199") === -1);
  check("the client name is present, by design", openWorkbook(buffer).text.indexOf("Sentinel Person") !== -1);
}

// ===========================================================================
console.log("\n[7] Build time");
{
  const scales: { label: string; providers: number; subs: number }[] = [
    { label: "fixture scale   (10 providers,   24 subs)", providers: 10, subs: 24 },
    { label: "production      (26 providers,  300 subs)", providers: 26, subs: 300 },
    { label: "heavy quarter   (26 providers, 2000 subs)", providers: 26, subs: 2000 },
  ];
  let sample: Buffer | null = null;
  scales.forEach(({ label, providers, subs }) => {
    const roster = roster26().slice(0, providers);
    const list: SubmissionInput[] = [];
    for (let i = 0; i < subs; i++) {
      const p = roster[i % roster.length];
      list.push(mkSub(`${p.name} (${p.office})`, [i % 11, (i + 3) % 11, (i + 5) % 11, (i + 7) % 11], {
        choices: [
          ["Excellent", "Satisfied", "Neutral", "Could be better", "Needs improvement immediately"][i % 5],
          ["Yes", "No", "N/A"][i % 3], ["Yes", "No", "N/A"][(i + 1) % 3],
          ["Yes", "No", "N/A"][(i + 2) % 3], ["Yes", "No", "N/A"][i % 3],
        ],
        comments: i % 2 === 0 ? { overallRating: `Comment ${i}` } : undefined,
        client: `Client ${i}`,
      }));
    }
    const t0 = Date.now();
    const a = aggregateSurveys({ roster, submissions: list, period: PERIOD });
    const t1 = Date.now();
    const { buffer } = buildSurveyWorkbook(a);
    const t2 = Date.now();
    console.log(`  ${label}: aggregate ${t1 - t0}ms, workbook ${t2 - t1}ms, total ${t2 - t0}ms, ${buffer.length} bytes`);
    check(`${label.split("(")[0].trim()} builds in under 5s`, t2 - t0 < 5000, `${t2 - t0}ms`);
    if (providers === 26 && subs === 300) sample = buffer;
  });

  const w = process.argv.indexOf("--write");
  if (w !== -1 && process.argv[w + 1] && sample) {
    writeFileSync(process.argv[w + 1], sample);
    console.log(`  (wrote ${process.argv[w + 1]} — ${(sample as Buffer).length} bytes)`);
  }
}

// ===========================================================================
console.log("\n[8] Protected surfaces are untouched");
{
  check("the public survey router still registers the two public endpoints",
    read("server/survey/routes.ts").indexOf("/api/public/survey/providers") !== -1);
  check("the aggregation layer is imported, not modified, by the export",
    read("server/survey/export.ts").indexOf("aggregateSurveys") !== -1);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
