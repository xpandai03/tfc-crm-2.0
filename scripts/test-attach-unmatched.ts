/**
 * Self-checks — attaching a survey with no CRM match.
 *
 * Run: npx tsx scripts/test-attach-unmatched.ts
 *
 * No database, no network, no PHI. The test patient named below is the client's
 * own test record, created by him for this purpose.
 *
 * WHAT THIS CAN AND CANNOT PROVE. Eligibility is pure, so it is tested directly.
 * The dispatch itself talks to a browser automation against a live EHR and is
 * not exercised here — the claim, the payload shape and the wording are checked
 * by construction, and the live run is a human step.
 */
import { readFileSync } from "fs";
import { buildAttachBody, checkIdentityEligibility } from "../server/survey/attach-runner";
import { attachIneligibleText, attachFailureText } from "@shared/survey-attach-reasons";
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

function sub(over: Record<string, unknown> = {}, client: Record<string, unknown> = {}) {
  return {
    id: 1, createdAt: "2026-09-13T12:00:00Z", source: "client_survey_v1",
    formType: SURVEY_FORM_TYPE, submittedAt: "2026-09-13T12:00:00Z",
    contactId: null, name: "Test LS",
    payload: {
      formVariant: "in-person", modality: "In Person",
      client: {
        name: "Test LS", dateOfBirth: "1990-04-12",
        phone: "(505) 555-0143", email: "test.ls@example.invalid", ...client,
      },
      answers: { therapist: "Amanda Davison (ABQ)", ...(over.answers as object ?? {}) },
      ...over,
    },
  } as any;
}

// ===========================================================================
console.log("\n[1] Eligibility no longer requires a match");
{
  // The exact case that failed on the client call: a real TherapyNotes patient
  // who is not, and never was, a CRM contact.
  const e = checkIdentityEligibility(sub());
  check("a survey with no contact is eligible", e.eligible);
  if (e.eligible) {
    eq("...and carries the name split for the agent's search",
      [e.fields.firstName, e.fields.lastName], ["Test", "LS"]);
    eq("...the date of birth in the agent's format", e.fields.dob, "04/12/1990");
    eq("...the phone as typed", e.fields.phone, "(505) 555-0143");
    eq("...and the therapist verbatim", e.fields.clinicianName, "Amanda Davison (ABQ)");
  }
  check("the function takes no match argument at all",
    checkIdentityEligibility.length === 1);
}

// ===========================================================================
console.log("\n[2] The four identity fields are still required");
{
  const cases: [string, any, string][] = [
    ["a one-word name", sub({}, { name: "Madonna" }), "no_name"],
    ["no name", sub({}, { name: "" }), "no_name"],
    ["a malformed date of birth", sub({}, { dateOfBirth: "12/04/1990" }), "no_dob"],
    ["an impossible date", sub({}, { dateOfBirth: "1990-02-31" }), "no_dob"],
    ["no date of birth", sub({}, { dateOfBirth: "" }), "no_dob"],
    ["a phone with too few digits", sub({}, { phone: "12345" }), "no_phone"],
    ["no phone at all", sub({}, { phone: "" }), "no_phone"],
    ["no therapist", sub({ answers: { therapist: "" } }), "no_therapist"],
  ];
  cases.forEach(([label, s, code]) => {
    const e = checkIdentityEligibility(s);
    eq(`${label} is refused as ${code}`, e.eligible ? "eligible" : e.code, code);
  });
  const notSurvey = checkIdentityEligibility({ ...sub(), formType: "intake" });
  eq("a non-survey is refused", notSurvey.eligible ? "eligible" : notSurvey.code, "not_a_survey");
}

// ===========================================================================
console.log("\n[3] Pre-phone submissions stay ineligible, and say why");
{
  // The 32 stored submissions all predate the phone field. They cannot be
  // verified against a chart and are manual forever.
  const legacy = sub({}, { phone: undefined });
  delete (legacy.payload.client as any).phone;
  const e = checkIdentityEligibility(legacy);
  eq("a submission with no phone key is refused", e.eligible ? "eligible" : e.code, "no_phone");
  check("...with wording that explains it is permanent, not a queue",
    attachIneligibleText("no_phone").indexOf("before the form asked for a phone number") !== -1);
  check("...and points at the manual download",
    attachIneligibleText("no_phone").toLowerCase().indexOf("by hand") !== -1);
}

// ===========================================================================
console.log("\n[4] The button no longer gates on a match");
{
  const ui = read("client/src/pages/submissions.tsx");
  check("the client-side check does not refuse on awaiting_review",
    !/ineligible = "awaiting_review"/.test(ui));
  check("...nor on no_match", !/ineligible = "no_match"/.test(ui));
  check("it still refuses on each missing identity field",
    ['"no_name"', '"no_dob"', '"no_phone"', '"no_therapist"']
      .every((c) => ui.indexOf(`ineligible = ${c}`) !== -1));
  check("it still refuses while one is running", ui.indexOf('ineligible = "in_progress"') !== -1);
  check("...and once one has succeeded", ui.indexOf('ineligible = "already_attached"') !== -1);
  check("the pending state says it is talking to TherapyNotes",
    ui.indexOf("Checking TherapyNotes…") !== -1);
  check("...and the tooltip warns it takes about a minute",
    /Takes about a\s*\n?\s*.*minute/.test(ui) || ui.indexOf("Takes about a ") !== -1);
}

// ===========================================================================
console.log("\n[5] The overnight run is unchanged — still matched-only");
{
  const runner = read("server/survey/attach-runner.ts");
  check("checkEligibility still requires a matched state",
    /checkEligibility[\s\S]{0,600}state\.status !== "matched"/.test(runner));
  check("...and the scheduled trigger is what selects it",
    /trigger === "scheduled"[\s\S]{0,80}checkEligibility\(submission\)/.test(runner));
  check("the manual trigger uses the identity-only rule",
    /checkIdentityEligibility\(submission\)/.test(runner));
  check("the batch still filters on checkEligibility, not the new rule",
    !/runScheduledAttach[\s\S]{0,4000}checkIdentityEligibility/.test(runner));
}

// ===========================================================================
console.log("\n[6] The claim still makes a double attach impossible");
{
  const db = read("server/survey/attach-db.ts");
  const runner = read("server/survey/attach-runner.ts");
  check("every attach claims first", /claimAttach\(\{[\s\S]{0,200}trigger, actorEmail/.test(runner));
  check("...on the unmatched path too — the claim is before any branch",
    runner.indexOf("claimAttach") < runner.indexOf("SURVEY_ATTACH_AGENT_URL"));
  check("a row already attached never yields",
    /WHERE survey_attach_attempts\.status = 'failed'/.test(db));
  check("...and a running one only after it goes stale",
    /status = 'running'[\s\S]{0,120}started_at < NOW\(\)/.test(db));
  check("losing the claim is reported as in_progress or already_attached",
    /existing\?\.status === "running" \? "in_progress" : "already_attached"/.test(runner));
  check("the claim column was already nullable — no migration for contact_id",
    /contact_id\s+INTEGER,/.test(db) && !/contact_id\s+INTEGER\s+NOT NULL/.test(db));
}

// ===========================================================================
console.log("\n[7] Nothing links an attached survey to a contact");
{
  const runner = read("server/survey/attach-runner.ts");
  const stripped = runner.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the attach path never writes a contact link",
    stripped.indexOf("UPDATE form_submissions") === -1 &&
    stripped.indexOf("setMatchState") === -1 &&
    stripped.indexOf("recordHumanResolution") === -1);
  check("...and never removes anything from the review queue",
    stripped.indexOf("DELETE FROM survey_match_reviews") === -1);
  check("the chart is recorded on the ATTEMPT instead",
    /tnPatientUrl/.test(runner) && /tn_patient_url/.test(read("server/survey/attach-db.ts")));
  check("...and a later failure cannot erase it",
    /tn_patient_url = COALESCE\(\$5, tn_patient_url\)/.test(read("server/survey/attach-db.ts")));
}

// ===========================================================================
console.log("\n[8] The payload, and what changed about it");
{
  const runner = read("server/survey/attach-runner.ts");
  // The payload moved into buildAttachBody when the chart id was added, so these
  // are now asserted by BUILDING one rather than by reading the source of the
  // function that sends it. Same claims, better evidence.
  const body = buildAttachBody({
    submissionId: 7,
    fields: {
      firstName: "Test", lastName: "LS", dob: "04/12/1990",
      phone: "(505) 555-0143", clinicianName: "Amanda Davison (ABQ)",
      contactId: null, chartId: null,
    },
    documentName: "Client Survey",
    baseUrl: "https://crm.test",
  });
  // Every identifying field has ALWAYS come from the submission. The matched
  // path added contact_id, and the chart id came later; nothing else.
  ([["first_name", "Test"], ["last_name", "LS"], ["dob", "04/12/1990"],
    ["phone", "(505) 555-0143"], ["clinician_name", "Amanda Davison (ABQ)"]] as const)
    .forEach(([k, v]) => {
      check(`${k} still comes from the submission`, body[k] === v);
    });
  check("contact_id is omitted rather than sent as null", !("contact_id" in body));
  check("...and is present when there is one",
    buildAttachBody({
      submissionId: 7,
      fields: {
        firstName: "Test", lastName: "LS", dob: "04/12/1990",
        phone: "(505) 555-0143", clinicianName: "Amanda Davison (ABQ)",
        contactId: 42, chartId: null,
      },
      documentName: "Client Survey",
    }).contact_id === 42);
  check("a manual attach on a MATCHED row still carries its contact id",
    /trigger === "manual" && \(elig\.fields\.contactId === null/.test(runner));
}

// ===========================================================================
console.log("\n[9] A refusal reads as information, not breakage");
{
  // MATCHED ON INTENT, NOT ON PHRASING. This pinned the exact substring "not
  // in TherapyNotes at all", which the 22 September rewrite phrased as "may not
  // be in TherapyNotes at all" — the cause was still named and the assertion
  // still failed. A message test should hold the message to what it must TELL
  // someone, and leave the sentence free to be written better.
  const pnf = attachFailureText("patient_not_found");
  check("patient_not_found names the not-in-TherapyNotes cause",
    pnf.indexOf("in TherapyNotes at all") !== -1);
  check("...and still names the middle-name case", pnf.indexOf("middle") !== -1);
  check("...and names a differently-spelled surname, the commoner miss",
    /surname/i.test(pnf));
  check("...and names the date of birth", /date of birth/i.test(pnf));
  check("...and does NOT send anyone hunting for a bracketed preferred name, " +
        "which now matches", !/bracket|parenthe|preferred name/i.test(pnf));
  check("clinician_mismatch says which field disagreed",
    attachFailureText("clinician_mismatch").indexOf("therapist named on the survey") !== -1);
  // Every refusal must end by pointing somewhere a staff member can go.
  ["patient_not_found", "multiple_candidates", "name_mismatch", "dob_mismatch",
   "phone_mismatch", "clinician_mismatch", "clinician_unassigned", "login_failed",
   "attach_failed", "unknown_error", "agent_unreachable", "agent_timeout"].forEach((r) => {
    const t = attachFailureText(r).toLowerCase();
    check(`${r} points at the manual download`,
      t.indexOf("by hand") !== -1 || t.indexOf("download the pdf") !== -1);
  });
  check("the overnight skip reasons no longer read as a blocked button",
    attachIneligibleText("no_match").indexOf("can still be filed by hand") !== -1 &&
    attachIneligibleText("awaiting_review").indexOf("can still be filed by hand") !== -1);
}

// ===========================================================================
console.log("\n[10] No PHI in any log line or activity entry");
{
  const runner = read("server/survey/attach-runner.ts");
  const codeOnly = runner.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const logLines = (codeOnly.match(/console\.(log|warn|error)\([\s\S]*?\);/g) ?? []).join("\n");
  const IDENTITY = /firstName|lastName|\.name\b|dateOfBirth|\bdob\b|\.phone\b|clinicianName|payload|document_name/;
  check("no log line interpolates an identity field", !IDENTITY.test(logLines), logLines.slice(0, 200));
  const activity = /logActivity\(\{[\s\S]*?\}\)/.exec(codeOnly)?.[0] ?? "";
  check("the activity entry names no client", !IDENTITY.test(activity));
  check("...and uses a fixed entity name", activity.indexOf('entityName: "Client survey"') !== -1);
  check("the chart URL is not logged either", logLines.indexOf("tnPatientUrl") === -1);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
