/**
 * Fix 2 self-checks — TN dispatch: DOB normalisation + PHI-safe error surfacing.
 *
 * Run: npx tsx scripts/test-tn-dob-normalisation.ts
 *
 * NOTE: every date below is synthetic. No patient data appears in this file.
 */
import { dobToMMDDYYYY, isUnparseableDob, summarizeAgentError, normalizeSex, validateAgentPayload } from "../server/routes";

// The exact pattern the TN agent validates `dob` against
// (shared/schemas/therapy_notes_v2.py).
const AGENT_DOB_RE = /^\d{2}\/\d{2}\/\d{4}$/;

let pass = 0, fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---------------------------------------------------------------------------
console.log("\n[1] Format coverage — each accepted format converts to MM/DD/YYYY");
// Every format the CRM's own ingestion normalizer (normalizeExcelDate /
// normalizeDateValue) can produce or accept, plus the already-correct form.
const accepted: Array<[string, unknown, string]> = [
  ["ISO YYYY-MM-DD",              "2014-05-14",             "05/14/2014"],
  ["ISO datetime (Z)",            "2014-05-14T00:00:00Z",   "05/14/2014"],
  ["ISO datetime (space)",        "2014-05-14 00:00:00",    "05/14/2014"],
  ["YYYY/MM/DD  <-- the failure", "2014/05/14",             "05/14/2014"],
  ["MM/DD/YYYY (already right)",  "05/14/2014",             "05/14/2014"],
  ["M/D/YYYY (single digits)",    "5/4/2014",               "05/04/2014"],
  ["Written month, full",         "January 5, 2015",        "01/05/2015"],
  ["Written month, abbreviated",  "Jan 5, 2015",            "01/05/2015"],
  ["Written month, no comma",     "March 15 2015",          "03/15/2015"],
  ["Excel serial (number)",       41773,                    "05/14/2014"],
  ["Excel serial (string)",       "41773",                  "05/14/2014"],
  ["Surrounding whitespace",      "  2014/05/14  ",         "05/14/2014"],
];
for (const [label, input, expected] of accepted) {
  const got = dobToMMDDYYYY(input);
  check(`${label} -> ${expected}`, got === expected, `got ${JSON.stringify(got)}`);
  check(`${label} matches the agent's regex`, got !== null && AGENT_DOB_RE.test(got), `got ${JSON.stringify(got)}`);
  check(`${label} is not flagged unparseable`, isUnparseableDob(input) === false);
}

// ---------------------------------------------------------------------------
console.log("\n[2] Absent values -> null, and NOT flagged as unparseable");
for (const [label, input] of [["null", null], ["undefined", undefined], ["empty string", ""], ["whitespace only", "   "]] as Array<[string, unknown]>) {
  check(`${label} -> null`, dobToMMDDYYYY(input) === null);
  check(`${label} not flagged unparseable (it is absent, not malformed)`, isUnparseableDob(input) === false);
}

// ---------------------------------------------------------------------------
console.log("\n[3] Unrecognised values are REJECTED locally, never passed through");
const rejected: Array<[string, unknown]> = [
  ["free text",               "unknown"],
  ["partial date",            "05/2014"],
  ["two-digit year",          "05/14/14"],
  ["impossible month",        "2014-13-01"],
  ["impossible day",          "2014-02-30"],
  ["day/month/year (D/M/Y)",  "2014.05.14"],
  ["serial out of range",     "999999"],
  ["dashes, US order",        "05-14-2014"],
];
for (const [label, input] of rejected) {
  const got = dobToMMDDYYYY(input);
  check(`${label} -> null (not echoed back)`, got === null, `got ${JSON.stringify(got)}`);
  check(`${label} IS flagged unparseable`, isUnparseableDob(input) === true);
}
// The regression itself: the old code returned the raw value for anything it did
// not recognise, which is what reached the agent and produced the silent 422.
check(
  "REGRESSION: an unrecognised value is never returned verbatim",
  rejected.every(([, input]) => dobToMMDDYYYY(input) !== input),
);

// ---------------------------------------------------------------------------
console.log("\n[4] summarizeAgentError — surfaces field + constraint, never the value");
// Exactly the body FastAPI returned for the 4 Sept failure, with a synthetic value.
const SECRET = "2014/05/14"; // stands in for the rejected DOB
const fastapi422 = JSON.stringify({
  detail: [{
    type: "string_pattern_mismatch",
    loc: ["body", "dob"],
    msg: "String should match pattern '^\\d{2}/\\d{2}/\\d{4}$'",
    input: SECRET,
    ctx: { pattern: "^\\d{2}/\\d{2}/\\d{4}$" },
  }],
});
const summary = summarizeAgentError(422, fastapi422);
check("names the field", summary.includes("body.dob"), summary);
check("names the constraint", summary.includes("String should match pattern"), summary);
check("includes the status", summary.includes("422"), summary);
check("EXCLUDES the rejected value (PHI)", !summary.includes(SECRET), summary);

const multi = JSON.stringify({ detail: [
  { type: "missing", loc: ["body", "zip"], msg: "Field required", input: SECRET },
  { type: "string_pattern_mismatch", loc: ["body", "dob"], msg: "String should match pattern", input: SECRET },
]});
const multiSummary = summarizeAgentError(422, multi);
check("multiple errors are all named", multiSummary.includes("body.zip") && multiSummary.includes("body.dob"), multiSummary);
check("multiple errors: no values leak", !multiSummary.includes(SECRET), multiSummary);

// Bodies we cannot parse into (field, constraint) are discarded entirely — we
// cannot prove an arbitrary body is PHI-free, so only the status survives.
for (const [label, body] of [
  ["non-JSON body", `Internal Server Error for patient ${SECRET}`],
  ["unknown JSON shape", JSON.stringify({ error: "boom", payload: { dob: SECRET } })],
  ["empty body", ""],
  ["detail is an object", JSON.stringify({ detail: { dob: SECRET } })],
] as Array<[string, string]>) {
  const out = summarizeAgentError(500, body);
  check(`${label}: no body content leaks`, !out.includes(SECRET), out);
  check(`${label}: status still reported`, out.includes("500"), out);
}

// A string detail is a developer message, not an echoed value — safe to keep.
check(
  "string detail is surfaced",
  summarizeAgentError(429, JSON.stringify({ detail: "Another patient creation is already in progress" }))
    .includes("already in progress"),
);


// ---------------------------------------------------------------------------
console.log("\n[5] DOB plausibility — a shape-valid date that is not a birth date");
// A dropped leading digit (1981 -> 0981) parses, round-trips through Date, and
// satisfies the agent's MM/DD/YYYY pattern. TherapyNotes rejects it at SAVE,
// long after the run has started, so it must be stopped here.
for (const [label, input] of [
  ["year 0981 (dropped leading digit)", "0981-05-01"],
  ["year 0001",                         "0001-01-01"],
  ["year 1899 (below the floor)",       "1899-12-31"],
  ["a future date",                     "2099-01-01"],
] as Array<[string, unknown]>) {
  check(`${label} -> null`, dobToMMDDYYYY(input) === null, `got ${JSON.stringify(dobToMMDDYYYY(input))}`);
  check(`${label} IS flagged unparseable`, isUnparseableDob(input) === true);
}
for (const [label, input, expected] of [
  ["year 1900 (the floor, inclusive)", "1900-01-01", "01/01/1900"],
  ["an ordinary adult DOB",           "1981-05-01", "05/01/1981"],
  ["a newborn (today)",               new Date().toISOString().slice(0, 10), null],
] as Array<[string, string, string | null]>) {
  const got = dobToMMDDYYYY(input);
  if (expected) check(`${label} -> ${expected}`, got === expected, `got ${JSON.stringify(got)}`);
  else check(`${label} is accepted`, got !== null && AGENT_DOB_RE.test(got), `got ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------------------
console.log("\n[6] normalizeSex — map the unambiguous, reject the rest");
for (const [input, expected] of [
  ["Male", "Male"], ["male", "Male"], ["MALE", "Male"], ["  Male  ", "Male"], ["m", "Male"], ["M", "Male"],
  ["Female", "Female"], ["female", "Female"], ["FEMALE", "Female"], ["f", "Female"], ["F", "Female"],
] as Array<[string, string]>) {
  check(`${JSON.stringify(input)} -> ${expected}`, normalizeSex(input) === expected, `got ${normalizeSex(input)}`);
}
// Never guessed. A gender identity outside the administrative binary is real
// data; coercing it would write a wrong fact into a clinical record.
for (const input of ["", "   ", null, undefined, "Other", "Non-binary", "Nonbinary",
                     "Unknown", "X", "Prefer not to say", "Intersex", "Transgender",
                     "Man", "Woman", "1", "0", "MF"]) {
  check(`${JSON.stringify(input)} -> null (rejected, never guessed)`, normalizeSex(input) === null,
        `got ${normalizeSex(input)}`);
}

// ---------------------------------------------------------------------------
console.log("\n[7] validateAgentPayload — mirrors the agent schema, leaks no values");
const SENTINEL = "SENSITIVE-VALUE-9999";
const goodPayload = {
  first_name: "A", last_name: "B", dob: "05/01/1981",
  address: "1 Example St", zip: "87031", sex: "Male",
  email: "", phone: "", rfs_url: "",
  intake_pdf_url: "https://example.test/i.pdf",
  snapshot_pdf_url: "https://example.test/s.pdf",
  appointment_date: "9/17/2026", appointment_time: "8:00 AM",
  appointment_alert_text: "New Individual In-Person Therapy CRM",
  appointment_modality: "In Person",
  clinician_name: "Example Clinician",
  contact_id: 1, run_id: "r", callback_url: "https://example.test/cb",
} as Parameters<typeof validateAgentPayload>[0];

check("a complete payload has no problems", validateAgentPayload(goodPayload).length === 0,
      JSON.stringify(validateAgentPayload(goodPayload)));

const cases: Array<[string, Record<string, unknown>, string]> = [
  ["empty sex (the live failure)",  { sex: "" },                        "sex"],
  ["unmapped sex",                  { sex: SENTINEL },                  "sex"],
  ["empty dob",                     { dob: "" },                        "dob"],
  ["empty address",                 { address: "" },                    "address"],
  ["over-long address",             { address: "x".repeat(201) },       "address"],
  ["empty zip",                     { zip: "" },                        "zip"],
  ["4-digit zip",                   { zip: "7031" },                    "zip"],
  ["empty first name",              { first_name: "" },                 "first_name"],
  ["over-long first name",          { first_name: "x".repeat(101) },    "first_name"],
  ["empty last name",               { last_name: "" },                  "last_name"],
  ["empty clinician",               { clinician_name: "" },             "clinician_name"],
  ["empty alert text",              { appointment_alert_text: "" },     "appointment_alert_text"],
  ["bad appointment date",          { appointment_date: "2026-09-17" }, "appointment_date"],
  ["bad appointment time",          { appointment_time: "0800" },       "appointment_time"],
  ["hyphenated modality",           { appointment_modality: "In-Person" }, "appointment_modality"],
  ["non-http pdf url",              { intake_pdf_url: "file:///x.pdf" }, "intake_pdf_url"],
];
for (const [label, patch, field] of cases) {
  const out = validateAgentPayload({ ...goodPayload, ...patch } as typeof goodPayload);
  check(`${label} is caught`, out.length > 0, JSON.stringify(out));
  check(`${label} names the field (${field})`, out.some((m) => m.includes(field)), JSON.stringify(out));
  check(`${label} leaks no value`, !out.join(" ").includes(SENTINEL) && !out.join(" ").includes("x".repeat(50)),
        JSON.stringify(out));
}
// The whole point: several problems at once are all reported, not just the first.
const multiProblems = validateAgentPayload({ ...goodPayload, sex: "", zip: "", address: "" } as typeof goodPayload);
check("multiple problems are all reported", multiProblems.length === 3, JSON.stringify(multiProblems));

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
