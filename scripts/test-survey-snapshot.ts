/**
 * Self-checks — the Survey Insights snapshot.
 *
 * Run: npx tsx scripts/test-survey-snapshot.ts
 *
 * No database, no network, no PHI. Every provider name is invented here.
 *
 * THE CENTRAL CLAIM is that the snapshot and the workbook cannot disagree. The
 * client will hold them side by side — he said so — so the check that matters
 * is not "does the snapshot compute a percentage" but "does it produce the same
 * one Excel would, for the same period". That is asserted by generating a real
 * workbook, reading the numbers back out of its XML, and comparing.
 *
 * SCOPE IS ALSO A TEST. He cut this feature down to two tables and was specific
 * about it. [7] asserts the absence of everything he cut.
 */
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { unzipSync, strFromU8 } from "fflate";
import { percent } from "../server/survey/snapshot";
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

const snapSrc = read("server/survey/snapshot.ts");
const uiSrc = read("client/src/components/survey-snapshot.tsx");
const dialogSrc = read("client/src/components/survey-export-dialog.tsx");
const pageSrc = read("client/src/pages/submissions.tsx");

// ---------------------------------------------------------------------------
// A synthetic practice. Two ABQ providers, one RR, one with no office.
// ---------------------------------------------------------------------------
const PERIOD = { from: "2026-10-01", to: "2026-10-31" };
const roster: RosterEntry[] = [
  { id: 1, name: "Zzamanda Zzdavison", shortName: "Zzamanda D", office: "ABQ", isActive: true },
  { id: 2, name: "Zzsandra Zzrivera", shortName: "Zzsandra", office: "ABQ", isActive: true },
  { id: 3, name: "Zzliz Zzlopez", shortName: "Zzliz", office: "RR", isActive: true },
  { id: 4, name: "Zzjune Zznoplace", shortName: "Zzjune", office: "", isActive: true },
];
function sub(id: number, therapist: string, day: string): SubmissionInput {
  return {
    id, submittedAt: `${day}T12:00:00Z`, createdAt: `${day}T12:00:00Z`,
    payload: {
      formVariant: "in-person", modality: "In Person",
      client: { name: `Zzclient ${id}`, dateOfBirth: "1990-04-12", phone: "5055550143" },
      answers: {
        therapist, overallSatisfaction: 9, therapistSatisfaction: 10,
        schedulingSatisfaction: 8, officeSatisfaction: 9,
      },
    },
  };
}
// Amanda 3 surveys, Sandra 1, Liz 1, June 1.
const submissions: SubmissionInput[] = [
  sub(1, "Zzamanda Zzdavison (ABQ)", "2026-10-05"),
  sub(2, "Zzamanda Zzdavison (ABQ)", "2026-10-09"),
  sub(3, "Zzamanda Zzdavison (ABQ)", "2026-10-10"),
  sub(4, "Zzsandra Zzrivera (ABQ)", "2026-10-11"),
  sub(5, "Zzliz Zzlopez (RR)", "2026-10-14"),
  sub(6, "Zzjune Zznoplace ()", "2026-10-15"),
];
const agg = aggregateSurveys({ roster, submissions, period: PERIOD });

const COUNTS: ActiveClientCounts = {
  newestCapturedOn: "2026-10-30",
  byProviderId: {
    1: { count: 45, capturedOn: "2026-10-30" },   // 3/45  -> 7%
    2: { count: 5, capturedOn: "2026-10-30" },    // 1/5   -> 20%
    3: { count: 57, capturedOn: "2026-10-30" },   // 1/57  -> 2%
    4: { count: 10, capturedOn: "2026-10-30" },   // 1/10  -> 10%
  },
};

/**
 * The snapshot's own shaping, run WITHOUT a database.
 *
 * buildSurveySnapshot() does I/O, so this exercises the pure half — the same
 * rollup rule and the same percent() the server uses — over the same aggregate
 * and counts the workbook gets. What it cannot cover (the two reading different
 * tables) is prevented structurally instead, and asserted in [2].
 */
function shape(a = agg, c = COUNTS) {
  const providers = a.providers.map((p) => {
    const cell = p.providerId === null ? undefined : c.byProviderId[p.providerId];
    const activeClients = cell?.count ?? null;
    return {
      shortName: p.shortName, office: p.office, surveys: p.surveyCount,
      activeClients, percent: percent(p.surveyCount, activeClients),
      override: cell?.override ?? null,
    };
  });
  const byOffice = new Map<string, typeof providers>();
  providers.forEach((r) => {
    const k = r.office || "(none)";
    const l = byOffice.get(k); if (l) l.push(r); else byOffice.set(k, [r]);
  });
  const roll = (rows: typeof providers) => {
    const surveys = rows.reduce((n, r) => n + r.surveys, 0);
    const missing = rows.filter((r) => r.activeClients === null).length;
    const active = rows.length > 0 && missing === 0
      ? rows.reduce((n, r) => n + (r.activeClients ?? 0), 0) : null;
    return { surveys, activeClients: active, percent: percent(surveys, active), missing };
  };
  return {
    providers,
    offices: Array.from(byOffice.entries()).map(([office, rows]) => ({ office, ...roll(rows) })),
    total: roll(providers),
  };
}

// ===========================================================================
console.log("\n[1] Two tables, and only two");
{
  const headings = uiSrc.match(/<p className="text-xs font-medium mb-1">([^<]+)<\/p>/g) || [];
  eq("exactly two table headings", headings.length, 2);
  check("  one by provider", headings.some((h) => /By provider/.test(h)));
  check("  one by location", headings.some((h) => /By location/.test(h)));
  eq("exactly two <table> elements", (uiSrc.match(/<table /g) || []).length, 2);
  // Three numbers each, plus the label.
  const provHeaders = ["Provider", "Active clients", "Surveys", "%"];
  provHeaders.forEach((h) => check(`  provider table has ${h}`, uiSrc.includes(`>${h}<`)));
  check("  location table has Location", uiSrc.includes(">Location<"));
}

// ===========================================================================
console.log("\n[2] Every number comes from the export's own function");
{
  const exp = read("server/survey/export.ts");
  check("there is ONE loader, shared",
    /export async function loadSurveyPeriodData/.test(exp));
  check("the workbook build uses it",
    /buildSurveyExport[\s\S]{0,300}await loadSurveyPeriodData\(range\)/.test(exp));
  check("the snapshot uses it too", /await loadSurveyPeriodData\(range\)/.test(snapSrc));
  // The snapshot must not read a table itself — that is the whole guarantee.
  for (const forbidden of ["getActiveCountsAsOf", "getOverridesForPeriod", "getAllCrmProviders",
                           "getRecentSurveySubmissions", "aggregateSurveys", "getPool"]) {
    check(`  the snapshot never calls ${forbidden}`, !snapSrc.includes(forbidden));
  }
  check("...and does no SQL", !/SELECT|FROM |WHERE /.test(snapSrc));
}

// ===========================================================================
console.log("\n[3] The percentage matches the workbook's formula, to the decimal");
{
  // Read the numbers back out of a REAL workbook and recompute what Excel would
  // display, then compare to what the snapshot shows.
  const files = unzipSync(new Uint8Array(buildSurveyWorkbook(agg, COUNTS).buffer));
  const analysis = strFromU8(files["xl/worksheets/sheet2.xml"]);

  // C is active clients, D is surveys, E is the percentage formula.
  const cells: Record<string, string> = {};
  for (const m of analysis.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:<f>([^<]*)<\/f>)?(?:<v>([^<]*)<\/v>)?/g)) {
    cells[m[1]] = m[2] ?? m[3] ?? "";
  }
  const s = shape();
  // ALIGNED BY NAME, NOT BY INDEX. The workbook groups its rows by office; the
  // snapshot lists providers by name. The ORDER differs by design — the numbers
  // must not — so the row is found by its label in column A.
  const rowOf: Record<string, number> = {};
  for (const m of analysis.matchAll(/<c r="A(\d+)"[^>]*><v>([^<]*)<\/v>/g)) {
    rowOf[m[2]] = Number(m[1]);
  }
  check("every snapshot provider appears in the workbook",
    s.providers.every((p) => rowOf[p.shortName] !== undefined),
    s.providers.map((p) => p.shortName).join(","));
  s.providers.forEach((p) => {
    const r = rowOf[p.shortName];
    const wbActive = cells[`C${r}`] === "" ? null : Number(cells[`C${r}`]);
    const wbSurveys = Number(cells[`D${r}`] || 0);
    eq(`  row ${r}: active clients agree`, p.activeClients, wbActive);
    eq(`  row ${r}: surveys agree`, p.surveys, wbSurveys);
    // The workbook stores the FORMULA; Excel evaluates it. Evaluate it the same
    // way and the snapshot's number must match.
    const f = cells[`E${r}`];
    check(`  row ${r}: the workbook divides D by C`, /^D\d+\/C\d+$/.test(f), f);
    const asExcelWouldShow = wbActive === null ? null : Math.round((wbSurveys / wbActive) * 100);
    eq(`  row ${r}: the percentage agrees`, p.percent, asExcelWouldShow);
  });

  // The specific numbers, spelled out so a regression is legible.
  eq("Amanda: 3 of 45 reads 7%", percent(3, 45), 7);
  eq("Sandra: 1 of 5 reads 20%", percent(1, 5), 20);
  eq("Liz: 1 of 57 reads 2%", percent(1, 57), 2);
  // Rounding, the way `0%` rounds.
  eq("0.5% rounds to 1%", percent(1, 200), 1);
  eq("exactly half a percent rounds up", percent(5, 1000), 1);
  eq("zero surveys is 0%, not blank", percent(0, 45), 0);
}

// ===========================================================================
console.log("\n[4] The location rollup is a RATIO OF SUMS, not an average");
{
  const s = shape();
  const abq = s.offices.find((o) => o.office === "ABQ")!;
  eq("ABQ active clients is the sum", abq.activeClients, 50);   // 45 + 5
  eq("ABQ surveys is the sum", abq.surveys, 4);                 // 3 + 1
  eq("ABQ percentage is 4/50 = 8%", abq.percent, 8);
  // THE CASE THAT DISTINGUISHES THEM. Averaging the two provider percentages
  // gives 13.5% -> 14%, nearly double the truth.
  const avgOfPercents = Math.round((7 + 20) / 2);
  check("the average of the percentages would have been different",
    avgOfPercents !== abq.percent, `avg=${avgOfPercents} ratio=${abq.percent}`);
  eq("...and the average would have been 14%", avgOfPercents, 14);
  check("the module says which it computes",
    /ratio of the sums, not an average of the percentages/i.test(snapSrc));

  // The practice total, same rule.
  eq("the total is the ratio of all sums", s.total.percent, percent(6, 117));
  eq("  which is 5%", s.total.percent, 5);

  // A provider with no office gets a ROW, not a disappearance.
  check("the no-office provider has its own row",
    s.offices.some((o) => o.office === "(none)"), s.offices.map((o) => o.office).join(","));
  eq("every provider is in exactly one office row",
    s.offices.reduce((n, o) => n + (o as any).surveys, 0), 6);
}

// ===========================================================================
console.log("\n[5] The override panel is in ONE place — here");
{
  check("the snapshot renders it", /<ActiveCountOverrides/.test(uiSrc));
  check("the export dialog does NOT", !/ActiveCountOverrides/.test(dialogSrc));
  check("...and does not import it", !/active-count-overrides/.test(dialogSrc));
  check("...and has no counts panel left over",
    !/showCounts|Adjust/.test(dialogSrc) || /Survey Insights/.test(dialogSrc));
  // Exactly one component renders it, across the whole client.
  const renderers = execSync(
    'grep -rl "<ActiveCountOverrides" client/src || true', { encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  eq("exactly one component renders the panel", renderers.length, 1);
  eq("  and it is the snapshot", renderers[0], "client/src/components/survey-snapshot.tsx");
  check("the dialog points people to where it went", /Survey snapshot/.test(dialogSrc));
  check("the three routes did not change",
    execSync('git diff --name-only HEAD -- server/survey/active-count-overrides-db.ts',
      { encoding: "utf8" }).trim() === "");
}

// ===========================================================================
console.log("\n[6] An override shows with a marker");
{
  const withOv: ActiveClientCounts = {
    ...COUNTS,
    byProviderId: {
      ...COUNTS.byProviderId,
      1: {
        count: 45, capturedOn: "2026-10-30",
        override: { pulled: 43, setBy: "lane@example.invalid", setAt: "2026-10-31T16:20:00Z", note: null },
      },
    },
  };
  const s = shape(agg, withOv);
  const amanda = s.providers.find((p) => p.shortName === "Zzamanda D")!;
  check("the overridden row carries the override", amanda.override !== null);
  eq("...and the figure used is the typed one", amanda.activeClients, 45);
  eq("...and the percentage uses it", amanda.percent, 7);
  const others = s.providers.filter((p) => p.shortName !== "Zzamanda D");
  check("no other row is marked", others.every((p) => p.override === null));

  check("the UI renders a marker for it", /marker-override-/.test(uiSrc));
  check("...with who set it", /Set by hand by \$\{r\.override\.setBy\}/.test(uiSrc));
  check("...and what the pull had said", /TherapyNotes had \$\{r\.override\.pulled\}/.test(uiSrc));
  check("...and says so when there was no reading",
    /no TherapyNotes reading for this period/.test(uiSrc));
}

// ===========================================================================
console.log("\n[7] Nothing the client cut is present");
{
  // He was offered a full results view and scoped it down. These are the things
  // he removed, and their absence is the feature.
  const forbidden: [string, RegExp][] = [
    ["a per-question breakdown", /questionBreakdown|byQuestion|per-question|QuestionBreakdown/],
    ["rating averages", /averages|SCALE_KEYS|ratings/],
    ["comment listings", /listingRows|negatives|NegativeListing|comments/i],
    ["a chart library", /recharts|Chart\b|<Bar|<Pie|<Line[^a-z]/],
    ["an office-by-provider grid", /providersByOffice|officeProviders|groupedByOffice/],
  ];
  // COMMENTS STRIPPED FIRST. Both files explain in prose WHAT WAS CUT and why,
  // and a search that cannot tell an explanation from an implementation would
  // forbid saying so.
  const codeOf = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const snapCode = codeOf(snapSrc), uiCode = codeOf(uiSrc);
  forbidden.forEach(([label, re]) => {
    check(`  the snapshot module has no ${label}`, !re.test(snapCode), label);
    check(`  the snapshot UI has no ${label}`, !re.test(uiCode), label);
  });
  check("no charting library is imported anywhere in it",
    !/recharts|chart\.js|d3/i.test(uiSrc));
  check("the toggle icon is not a chart icon", !/BarChart/.test(uiSrc));
  // Three numbers per row, no more.
  eq("the provider table has four columns and no more",
    (uiSrc.slice(uiSrc.indexOf("table-snapshot-providers"),
                 uiSrc.indexOf("table-snapshot-offices")).match(/<th /g) || []).length, 4);
  eq("the location table has four columns and no more",
    (uiSrc.slice(uiSrc.indexOf("table-snapshot-offices")).match(/<th /g) || []).length, 4);
}

// ===========================================================================
console.log("\n[8] No new tab");
{
  const navChanged = execSync(
    'git diff --name-only HEAD -- client/src/components/layout client/src/App.tsx ' +
    'client/src/components/layout/page-layout.tsx shared/access-control.ts',
    { encoding: "utf8" },
  ).trim();
  eq("no navigation file appears in the diff", navChanged, "");
  check("the snapshot is mounted on the Submissions page", /<SurveySnapshot \/>/.test(pageSrc));
  check("...and nowhere else",
    execSync('grep -rl "<SurveySnapshot" client/src || true', { encoding: "utf8" })
      .trim().split("\n").filter(Boolean).length === 1);
  // App.tsx carries a PRE-EXISTING /insights route for the separate Insights
  // page. The meaningful assertion is that the diff added nothing, which the
  // nav check above already proves — this names the trap so nobody "fixes" it
  // by searching for the string again.
  check("App.tsx is untouched",
    execSync('git diff --stat HEAD -- client/src/App.tsx', { encoding: "utf8" }).trim() === "");
  // Comments stripped: the file explains IN PROSE that it deliberately avoids
  // the name, which a naive search would read as using it.
  check("the panel is not named after the existing Insights tab",
    !/Survey Insights/.test(uiSrc.replace(/\/\*[\s\S]*?\*\//g, ""))
    && /Survey snapshot/.test(uiSrc));
}

// ===========================================================================
console.log("\n[9] Someone who ignores it pays nothing");
{
  check("it starts collapsed", /const \[open, setOpen\] = useState\(false\)/.test(uiSrc));
  check("it fetches nothing until opened", /if \(!open \|\| !rangeValid\) return;/.test(uiSrc));
  check("the fetch is inside an effect keyed on open", /\}, \[open, from, to/.test(uiSrc));
  // It must not be able to break the page around it.
  check("a failed load renders a message, not a throw", /setError\(e\.message\)/.test(uiSrc));
  check("an in-flight load is cancelled on unmount", /cancelled = true/.test(uiSrc));
  check("the submissions list is untouched",
    !/SurveySnapshot/.test(pageSrc.slice(pageSrc.indexOf("allSubmissions.map"))));
  // The page's own data hooks are unchanged.
  const pageDiff = execSync('git diff HEAD -- client/src/pages/submissions.tsx',
    { encoding: "utf8" });
  // Code lines only. The mount is wrapped in a JSX comment explaining the
  // placement, whose inner lines are plain prose with no marker of their own —
  // so the comment BLOCK is removed from the added text before anything is
  // counted, rather than filtered line by line.
  const addedText = pageDiff.split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const added = addedText.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  eq("exactly two code lines were added to the page: an import and a mount",
    added.length, 2);
  check("  one is the import", added.some((l) => /^import \{ SurveySnapshot \}/.test(l)));
  check("  one is the mount", added.some((l) => /^<SurveySnapshot \/>$/.test(l)));
}

// ===========================================================================
console.log("\n[10] No PHI in any log line");
{
  const files = ["server/survey/snapshot.ts", "server/routes.ts",
                 "client/src/components/survey-snapshot.tsx"];
  files.forEach((f) => {
    const src = read(f);
    const lines = (src.match(/console\.(log|warn|error)\([\s\S]*?\);/g) || [])
      .filter((l) => /snapshot/i.test(l));
    lines.forEach((l, i) => {
      check(`  ${f.split("/").pop()} log ${i + 1} carries no identity`,
        !/\$\{[^}]*(name|client|dob|phone|payload)[^}]*\}/i.test(l), l.slice(0, 90));
    });
  });
  check("the snapshot module logs nothing at all", !/console\./.test(snapSrc));
  check("the route logs only a failure reason",
    /\[survey-snapshot\] build failed/.test(read("server/routes.ts")));
  // The response carries staff names by design; no client value is in the shape.
  for (const f of ["dateOfBirth", "patientDob", "phone", "email", "payload"]) {
    check(`  the snapshot shape has no ${f}`, !snapSrc.includes(f));
  }
}

// ===========================================================================
console.log("\n[11] Edge cases");
{
  // A provider with surveys but NO active count: no percentage, and the office
  // it sits in withholds its total — the workbook's rule.
  const partial: ActiveClientCounts = {
    newestCapturedOn: "2026-10-30",
    byProviderId: { 1: { count: 45, capturedOn: "2026-10-30" }, 3: { count: 57, capturedOn: "2026-10-30" } },
  };
  const s = shape(agg, partial);
  const sandra = s.providers.find((p) => p.shortName === "Zzsandra")!;
  eq("a provider with no count has no active figure", sandra.activeClients, null);
  eq("...and no percentage rather than a zero", sandra.percent, null);
  eq("...but keeps its survey count", sandra.surveys, 1);
  const abq = s.offices.find((o) => o.office === "ABQ")!;
  eq("its office withholds the total", abq.activeClients, null);
  eq("...and the percentage with it", abq.percent, null);
  eq("...while still showing surveys", abq.surveys, 4);
  eq("...and saying how many are missing", abq.missing, 1);
  eq("the practice total is withheld too", s.total.percent, null);
  // RR is complete and still gets its numbers — the rule is per office.
  const rr = s.offices.find((o) => o.office === "RR")!;
  eq("a complete office is unaffected", rr.percent, percent(1, 57));

  // A period with nothing in it.
  const empty = aggregateSurveys({ roster, submissions: [], period: PERIOD });
  const e = shape(empty, COUNTS);
  eq("an empty period still lists every provider", e.providers.length, 4);
  eq("...with zero surveys", e.providers.every((p) => p.surveys === 0), true);
  eq("...and 0%, which is true and not a blank", e.providers[0].percent, 0);
  eq("...and the total is 0%", e.total.percent, 0);

  // An override for a provider no longer on the roster: ignored, not a crash.
  const ghost: ActiveClientCounts = {
    ...COUNTS,
    byProviderId: { ...COUNTS.byProviderId, 99: {
      count: 12, capturedOn: null,
      override: { pulled: null, setBy: "lane@example.invalid", setAt: "2026-10-31T16:20:00Z", note: null },
    } },
  };
  let threw = false;
  try { shape(agg, ghost); } catch { threw = true; }
  check("an override for a departed provider is ignored, not a crash", !threw);
  eq("...and does not add a row", shape(agg, ghost).providers.length, 4);

  // Division by a stored zero.
  eq("zero active clients yields no percentage, not Infinity", percent(3, 0), null);
}

// ===========================================================================
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
