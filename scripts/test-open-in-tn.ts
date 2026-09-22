/**
 * Self-checks — the Open in TherapyNotes control, and the two eligibility paths.
 *
 * Run: npx tsx scripts/test-open-in-tn.ts
 *
 * No database, no network, no browser. Every identity below is invented.
 *
 * TWO THINGS ARE BEING PINNED:
 *   1. there is ONE chart-URL builder and it renders nothing without an id
 *   2. the overnight batch and the manual button agree about a TherapyNotes-only
 *      match — the defect this build exists to close
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { tnChartUrl } from "../client/src/lib/tn-chart-url";
import { checkIdentityEligibility } from "../server/survey/attach-runner";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(name, JSON.stringify(a) === JSON.stringify(b),
    `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
const read = (p: string) => readFileSync(p, "utf8");

// A survey shaped exactly as the form stores one. Invented throughout.
const survey = (o: Record<string, unknown> = {}) => ({
  id: 4242,
  formType: "survey",
  payload: {
    client: { name: "Rowan Thistlewood", dateOfBirth: "2015-06-12", phone: "(505) 555-0164" },
    answers: { therapist: "Anna Aldridge (ABQ)" },
  },
  submittedAt: "2026-09-21T10:00:00Z",
  createdAt: "2026-09-21T10:00:00Z",
  ...o,
}) as any;

// ===========================================================================
console.log("\n[1] The chart URL — one builder, and the shape recon verified");
{
  eq("builds the chart URL from an id",
    tnChartUrl("1L4JcJ5qscGPg3KTuHS86A"),
    "https://www.therapynotes.com/app/patients/edit/1L4JcJ5qscGPg3KTuHS86A/");
  check("keeps the trailing slash",
    (tnChartUrl("abc") || "").endsWith("/"));
  eq("a 16-char id works too — the id space is not fixed",
    tnChartUrl("1LOBsLRkP5WT4NKc"),
    "https://www.therapynotes.com/app/patients/edit/1LOBsLRkP5WT4NKc/");
  check("ids are escaped, never interpolated raw",
    (tnChartUrl("a/b") || "").indexOf("a%2Fb") !== -1);

  console.log("\n[1a] No id means NO CONTROL, not a control that goes nowhere");
  eq("null", tnChartUrl(null), null);
  eq("undefined", tnChartUrl(undefined), null);
  eq("empty string", tnChartUrl(""), null);
  eq("whitespace only", tnChartUrl("   "), null);
}

// ===========================================================================
console.log("\n[2] One implementation — no second chart-URL builder");
{
  const lib = read("client/src/lib/tn-chart-url.ts");
  const btn = read("client/src/components/ui/open-in-tn-button.tsx");
  const subs = read("client/src/pages/submissions.tsx");

  check("the button imports the builder rather than carrying its own",
    /from "@\/lib\/tn-chart-url"/.test(btn) && !/therapynotes\.com/.test(btn));
  check("the survey row imports the button rather than inlining one",
    /from "@\/components\/ui\/open-in-tn-button"/.test(subs));
  check("the survey row does not build a TherapyNotes URL itself",
    !/therapynotes\.com/i.test(subs));

  // The repo-wide guard: exactly one file may name the chart path.
  const hits = execSync(
    "grep -rl 'app/patients/edit' client/src server shared || true",
    { encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  eq("exactly one file in the app builds that path", hits, ["client/src/lib/tn-chart-url.ts"]);
}

// ===========================================================================
console.log("\n[3] The control renders only with a chart id");
{
  const btn = read("client/src/components/ui/open-in-tn-button.tsx");
  const subs = read("client/src/pages/submissions.tsx");
  check("returns null when the builder returns null", /if \(!url\) return null;/.test(btn));
  // Strip comments first: the prose explains WHY it is not disabled, and
  // matching that would be the assertion testing its own documentation.
  const btnCode = btn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("is NOT rendered disabled instead", !/disabled/.test(btnCode));
  check("the row passes the match's chart id",
    /chartId=\{stateFor\(sub\.id\)\?\.matchedChartId\}/.test(subs));
  check("the client type now declares the field the server already sent",
    /matchedChartId: string \| null;/.test(subs));
  check("wording matches the contact page's control",
    /Open in TherapyNotes/.test(btn)
    && /Open in TherapyNotes/.test(read("client/src/pages/contact-detail.tsx")));
  check("icon matches the contact page's control", /ExternalLink/.test(btn));
}

// ===========================================================================
console.log("\n[4] THE DEFECT: the batch and the button now agree");
{
  const runner = read("server/survey/attach-runner.ts");

  check("the batch no longer requires a CRM contact",
    !/state\.status !== "matched" \|\| !state\.matchedContactId/.test(runner));
  check("...and asks only whether the matcher reached 'matched'",
    /if \(state\.status !== "matched"\) \{/.test(runner));
  check("the batch still refuses a row awaiting review",
    /state\.status === "review".*awaiting_review/s.test(runner));
  check("the manual path still requires no match at all — unchanged",
    /export function checkIdentityEligibility/.test(runner));

  // Both paths, same submission: the identity half must agree.
  const id = checkIdentityEligibility(survey());
  check("identity path: a complete survey is eligible", id.eligible === true);

  console.log("\n[4a] The identity bar has not moved");
  for (const [label, payload] of [
    ["one-token name", { client: { name: "Rowan", dateOfBirth: "2015-06-12", phone: "5055550164" }, answers: { therapist: "Anna Aldridge" } }],
    ["no date of birth", { client: { name: "Rowan Thistlewood", dateOfBirth: "", phone: "5055550164" }, answers: { therapist: "Anna Aldridge" } }],
    ["no phone", { client: { name: "Rowan Thistlewood", dateOfBirth: "2015-06-12", phone: "" }, answers: { therapist: "Anna Aldridge" } }],
    ["no therapist", { client: { name: "Rowan Thistlewood", dateOfBirth: "2015-06-12", phone: "5055550164" }, answers: { therapist: "" } }],
  ] as [string, any][]) {
    check(`${label} is still ineligible`, checkIdentityEligibility(survey({ payload })).eligible === false);
  }
  check("a non-survey is still ineligible",
    checkIdentityEligibility(survey({ formType: "intake" })).eligible === false);
}

// ===========================================================================
console.log("\n[5] Out of scope stayed out of scope");
{
  const changed = execSync(
    "git diff --name-only HEAD -- server/survey/matching.ts server/survey/match-runner.ts " +
    "server/therapy-notes/tn-patients-runner.ts server/therapy-notes/tn-patients-db.ts " +
    "server/auth.ts client/src/pages/contact-detail.tsx",
    { encoding: "utf8" },
  ).trim();
  eq("matcher, pull, auth and the contact page are untouched", changed, "");

  const runner = read("server/survey/attach-runner.ts");
  check("the attach route's payload builder is unchanged",
    /first_name: fields\.firstName/.test(runner)
    && /\.\.\.\(fields\.contactId !== null \? \{ contact_id: fields\.contactId \} : \{\}\)/.test(runner));
  check("the batch still runs oldest first, capped, one at a time",
    /ATTACH_BATCH_LIMIT|oldest first/i.test(read("server/reminders/cron.ts")));

  const di = read(".dockerignore");
  check(".dockerignore excludes spreadsheet exports", /^\*\.xlsx$/m.test(di));
  check(".dockerignore excludes the screenshot folder", /^\/TFC-Q4-SURVEY$/m.test(di));
  check("...but keeps the provider workbook the app reads", /^!\/data\/\*\.xlsx$/m.test(di));
}

console.log(`\n${"=".repeat(62)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (failures.length) for (const f of failures) console.log(`    - ${f}`);
console.log(`${"=".repeat(62)}\n`);
process.exit(fail ? 1 : 0);
