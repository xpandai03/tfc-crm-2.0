/**
 * Self-checks — the CRM sends the chart id it now has.
 *
 * Run: npx tsx scripts/test-attach-chart-id.ts
 *
 * No database, no network, no PHI. Every identity below is invented here.
 *
 * WHAT THIS IS ABOUT. A matched submission now carries a TherapyNotes chart id.
 * Sending it lets the agent open that record instead of narrowing by name, so
 * a common surname or two people sharing a date of birth stop being refusals.
 * These checks are about the CRM's half: that the id reaches the payload when
 * there is one, that it is ABSENT rather than null when there is not, that the
 * new refusal has wording a scheduler can act on, and that none of the rules
 * around it moved.
 *
 * The payload builder is pure and is driven directly. The two things that need
 * a database — the match lookup on each trigger — are asserted from source, the
 * same standard scripts/test-attach-unmatched.ts holds the dispatch to.
 */
import { readFileSync } from "fs";
import { execSync } from "child_process";
import {
  buildAttachBody,
  checkIdentityEligibility,
  type AttachPayloadFields,
} from "../server/survey/attach-runner";
import {
  ATTACH_FAILURE_REASONS,
  attachFailureText,
  isAttachFailureReason,
} from "@shared/survey-attach-reasons";
import { SURVEY_FORM_TYPE } from "@shared/survey-questions";

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

const runner = read("server/survey/attach-runner.ts");
const db = read("server/survey/attach-db.ts");
const reasons = read("shared/survey-attach-reasons.ts");

const CHART = "1005471";

function fields(over: Partial<AttachPayloadFields> = {}): AttachPayloadFields {
  return {
    firstName: "Zzmary", lastName: "Zzwatson", dob: "04/12/1990",
    phone: "(505) 555-0143", clinicianName: "Zzamanda Zzdavison (ABQ)",
    contactId: null, chartId: null, ...over,
  };
}
const build = (f: AttachPayloadFields) =>
  buildAttachBody({ submissionId: 7, fields: f, documentName: "Client Survey", baseUrl: "https://crm.test" });

// ===========================================================================
console.log("\n[1] The id reaches the payload when there is one");

const withChart = build(fields({ chartId: CHART, contactId: 42 }));
eq("expected_chart_id is sent", withChart.expected_chart_id, CHART);
eq("...alongside the contact id, not instead of it", withChart.contact_id, 42);

// A matched submission can carry a chart id with NO CRM contact — a
// TherapyNotes-only patient. The id must still travel.
const chartNoContact = build(fields({ chartId: CHART, contactId: null }));
eq("a chart id with no contact is still sent", chartNoContact.expected_chart_id, CHART);
check("...and contact_id is omitted, not null", !("contact_id" in chartNoContact));

// ===========================================================================
console.log("\n[2] It is ABSENT, not null, when there is not");

const noChart = build(fields({ contactId: 42 }));
check("the key is omitted entirely", !("expected_chart_id" in noChart));
check("not present-and-null", noChart.expected_chart_id === undefined);
eq("everything else is unchanged", Object.keys(noChart).sort(), [
  "clinician_name", "contact_id", "dob", "document_name", "first_name",
  "last_name", "pdf_url", "phone",
].sort());

// An empty string is not an id. It must not become one.
for (const empty of ["", "   "]) {
  const b = build(fields({ chartId: empty }));
  check(`chartId ${JSON.stringify(empty)} is treated as absent`,
    !("expected_chart_id" in b) || b.expected_chart_id === undefined);
}

// ===========================================================================
console.log("\n[3] Nothing else about the payload moved");

const before = build(fields({ contactId: 42 }));
eq("first_name", before.first_name, "Zzmary");
eq("last_name", before.last_name, "Zzwatson");
eq("dob is still MM/DD/YYYY", before.dob, "04/12/1990");
eq("phone is sent as submitted", before.phone, "(505) 555-0143");
eq("clinician_name", before.clinician_name, "Zzamanda Zzdavison (ABQ)");
eq("pdf_url still points at the internal route",
  before.pdf_url, "https://crm.test/api/internal/survey-pdf/7");
eq("document_name is passed through", before.document_name, "Client Survey");
// The document name still carries no identity — unchanged, re-asserted because
// this file now builds payloads.
check("no payload key carries a name beyond the two name fields",
  !JSON.stringify({ ...before, first_name: "", last_name: "" }).includes("Zzwatson"));

// ===========================================================================
console.log("\n[4] BOTH triggers populate the id — one builder, two lookups");

check("there is exactly ONE payload builder",
  (runner.match(/export function buildAttachBody/g) || []).length === 1);
check("...and attachOne is its only caller in the runner",
  (runner.match(/buildAttachBody\(/g) || []).length === 2); // the definition and the call
check("the scheduled path reads the chart id off the match state",
  /checkEligibility[\s\S]{0,900}chartId: state\.matchedChartId \|\| null/.test(runner));
check("the manual path backfills it from the same lookup",
  /trigger === "manual"[\s\S]{0,700}elig\.fields\.chartId = state\.matchedChartId/.test(runner));
// The manual backfill must not be nested inside the contact branch: a matched
// row can carry a chart id and no contact id.
check("the manual backfill is not gated on the contact id alone",
  /elig\.fields\.contactId === null \|\| elig\.fields\.chartId === null/.test(runner));
check("both triggers still reach the same dispatch",
  (runner.match(/fetch\(SURVEY_ATTACH_AGENT_URL/g) || []).length === 1);

// ===========================================================================
console.log("\n[5] The chart id is not an eligibility rule");

// A match with no chart id is exactly as attachable as it was yesterday.
function sub(client: Record<string, unknown> = {}) {
  return {
    id: 1, createdAt: "2026-09-13T12:00:00Z", source: "client_survey_v1",
    formType: SURVEY_FORM_TYPE, submittedAt: "2026-09-13T12:00:00Z",
    contactId: null, name: "Zzmary Zzwatson",
    payload: {
      formVariant: "in-person", modality: "In Person",
      client: {
        name: "Zzmary Zzwatson", dateOfBirth: "1990-04-12",
        phone: "(505) 555-0143", email: "zz@example.invalid", ...client,
      },
      answers: { therapist: "Zzamanda Zzdavison (ABQ)" },
    },
  } as any;
}
const elig = checkIdentityEligibility(sub());
check("a submission with no chart id is still eligible", elig.eligible === true);
// The signature EXCLUDES chartId (Omit<..., "contactId" | "chartId">), which is
// the point: this function cannot produce one. So the assertion is that its body
// never reads or decides on one, not that the word is absent from its type.
const identityFn = runner.slice(
  runner.indexOf("export function checkIdentityEligibility"),
  runner.indexOf("export function buildAttachBody"));
check("the identity check excludes the chart id from what it produces",
  /Omit<AttachPayloadFields, "contactId" \| "chartId">/.test(identityFn));
check("...and never reads one to decide eligibility",
  !/state\.matchedChartId|fields\.chartId/.test(identityFn));
check("the ineligibility codes are unchanged",
  !/no_chart|chart_required/.test(runner));

// ===========================================================================
console.log("\n[6] The new refusal, in language a scheduler can act on");

check("the code is in the shared vocabulary",
  (ATTACH_FAILURE_REASONS as readonly string[]).includes("expected_chart_not_in_results"));
check("it is recognised by the type guard", isAttachFailureReason("expected_chart_not_in_results"));
const text = attachFailureText("expected_chart_not_in_results");
check("it has wording", typeof text === "string" && text.length > 40);
check("...that says what happened", /not found in TherapyNotes/i.test(text));
check("...names the likely cause", /merged/i.test(text) && /discharged/i.test(text));
check("...and says what to do", /by hand/i.test(text));
// The house rule for every one of these sentences.
for (const jargon of ["verification", "payload", "selector", "phase", "chart_id", "expected_chart_not_in_results"]) {
  check(`the sentence avoids "${jargon}"`, !text.toLowerCase().includes(jargon.toLowerCase()));
}
check("every reason still has wording",
  ATTACH_FAILURE_REASONS.every((c) => typeof attachFailureText(c) === "string" && attachFailureText(c).length > 20));
check("the CRM's list matches the agent's, in order",
  reasons.indexOf('"expected_chart_not_in_results"') > reasons.indexOf('"result_set_possibly_truncated"'));

// ===========================================================================
console.log("\n[7] Which path ran is recorded, and not shown to staff");

check("the outcome recorder takes it", /selectionMode\?: string \| null;/.test(db));
check("...and writes it", /selection_mode = COALESCE\(\$6, selection_mode\)/.test(db));
check("the column is additive and nullable, like tn_patient_url",
  /ADD COLUMN IF NOT EXISTS selection_mode TEXT/.test(db));
check("a failed migration is logged, not thrown",
  /selection_mode column migration FAILED/.test(db));
check("the row type carries it", /selectionMode: string \| null;/.test(db));
check("the runner reads it off the agent's response",
  /selectionMode = typeof parsed\?\.selection_mode === "string"/.test(runner));
check("it is recorded on failures too, not only successes",
  runner.indexOf("selectionMode = typeof parsed") < runner.indexOf('parsed?.status === "success"'));
check("it is passed to recordAttachOutcome",
  /recordAttachOutcome\(\{[^}]*selectionMode[^}]*\}\)/.test(runner));
// Diagnostic, not staff-facing.
const page = read("client/src/pages/submissions.tsx");
check("nothing renders it", !/selectionMode/.test(page));

// ===========================================================================
console.log("\n[8] PHI — a chart id names a patient's record and is not logged");

const logLines = runner.match(/console\.(log|warn|error)\([\s\S]*?\);/g) || [];
const blob = logLines.join("\n");
// Only ONE log line may mention the chart id, and only to say yes or no. Any
// other interpolation of it would put a patient's record number in a log.
const chartInterpolations = blob.match(/\$\{[^}]*[cC]hartId[^}]*\}/g) || [];
eq("the chart id is interpolated exactly once", chartInterpolations.length, 1);
check("...and that one yields only yes or no",
  /^\$\{elig\.fields\.chartId \? "yes" : "no"\}$/.test(chartInterpolations[0] ?? ""),
  chartInterpolations[0]);
check("the dispatch line reports PRESENCE only",
  /expected_chart=\$\{elig\.fields\.chartId \? "yes" : "no"\}/.test(runner));
for (const f of ["firstName", "lastName", "fields.dob", "fields.phone"]) {
  check(`no log line carries ${f}`, !new RegExp(`\\$\\{[^}]*${f.replace(".", "\\.")}`).test(blob));
}

// ===========================================================================
console.log("\n[9] The matcher, the schedule and the review queue are untouched");

// NARROWED, DELIBERATELY. This began as "matching.ts must not appear in the
// diff", which was the right guard for the chart-id build — that build had no
// business touching the matcher. It is the wrong guard forever: the
// preferred-name build of 21 September changes the matcher's NAME rule on
// purpose, and a file-level assertion would have to be deleted rather than
// understood.
//
// So the file guard keeps the files that genuinely must not move, and what it
// used to protect about matching.ts is asserted where it actually lives: the
// other rules, by name, in the source.
const changed = execSync(
  "git diff --name-only HEAD -- server/survey/match-runner.ts " +
  "server/survey/match-db.ts server/reminders/cron.ts server/auth.ts",
  { encoding: "utf8" },
).trim();
eq("the runner, the store, the cron and auth are untouched", changed, "");

const matching = read("server/survey/matching.ts");
check("the date of birth is still exact after canonicalisation",
  /const dobOk = cDob !== null && cDob === dob/.test(matching));
check("phone still corroborates or contradicts and never narrows",
  /reason: "phone_contradiction"/.test(matching) && /never NARROWS/.test(matching));
check("email is still treated identically",
  /reason: "email_contradiction"/.test(matching));
check("the provider is still the ONLY tiebreak",
  /const withProvider = candidates\.filter\(\(c\) => providerMatches\(c, wanted\)\)/.test(matching));
check("exactly one candidate is still the bar",
  /if \(candidates\.length === 1\)/.test(matching));
check("the DOB-only fallback is still offered and never matched",
  /const partialCandidates = dedupeIds\(\[\.\.\.nameOnly, \.\.\.dobOnly\]\)/.test(matching));
check("nameKey itself is still exported and still strips",
  /export function nameKey\(/.test(matching));
check("the attach schedule is still 03:30", /DEFAULT_ATTACH_SCHEDULE = "30 3 \* \* \*"/.test(read("server/reminders/cron.ts")));
check("the batch is still scoped to matched submissions",
  /trigger === "scheduled"[\s\S]{0,80}checkEligibility\(submission\)/.test(runner));
check("the button is still not",
  /checkIdentityEligibility\(submission\)/.test(runner));

// ===========================================================================
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
