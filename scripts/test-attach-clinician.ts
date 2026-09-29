/**
 * Survey attach and the survey tiebreak use scheduling's clinician rules —
 * `npm run test:attach-clinician`.
 *
 * Before 2026-09-29 the attach sent the roster label unchanged ("Tyra Jones
 * (ABQ)"), so the agent required "abq" on the chart and the Tyra→Ty alias never
 * applied: 0 of 5 attaches ever succeeded. The tiebreak compared exact strings,
 * so a "Ty Jones" chart could never win a tie for a "Tyra Jones (ABQ)" survey.
 *
 * Pure: no database. NO PHI — every patient identity here is invented; the
 * clinician names are staff names.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  clinicianNameMatches,
  stripLocationSuffix,
  surveyTherapistToTnClinician,
  toTherapyNotesClinicianName,
} from "../server/providers/tn-clinician-name";
import { matchSubmission, type ContactIdentity, type SubmittedIdentity } from "../server/survey/matching";
import { buildAttachBody } from "../server/survey/attach-runner";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// ---------------------------------------------------------------------------
console.log("\n[1] Normalisation: survey answer -> the name TherapyNotes renders");
for (const [input, want] of [
  ["Tyra Jones (ABQ)", "Ty Jones"],
  ["Tyra Jones", "Ty Jones"],
  ["  Tyra Jones  (ABQ) ", "Ty Jones"],
  ["Danya Estrada", "Danya Estrada-Rivera"],
  ["Danya Estrada (RR)", "Danya Estrada-Rivera"],
  ["Kristi Simmons (LL)", "Kristi Simmons"],
  ["Abena Marfowaa Owusu-Nkwantabisah (RR)", "Abena Marfowaa Owusu-Nkwantabisah"],
  ["Zzunknown Clinician (ABQ)", "Zzunknown Clinician"],
  ["Zzunknown Clinician", "Zzunknown Clinician"],
  ["", ""],
] as const) {
  eq(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, surveyTherapistToTnClinician(input), want);
}
eq("null passes as empty", surveyTherapistToTnClinician(null), "");
eq("stripLocationSuffix leaves a plain name alone", stripLocationSuffix("Liz Lopez"), "Liz Lopez");
eq("scheduling's own mapping is the one used", toTherapyNotesClinicianName("Tyra Jones"), "Ty Jones");

// ---------------------------------------------------------------------------
console.log("\n[2] The word rule, against the renderings TherapyNotes uses");
for (const rendered of ["Ty Jones", "Jones, Ty", "Jones, Ty, LMHC", "  ty   JONES "]) {
  ok(`"Ty Jones" matches ${JSON.stringify(rendered)}`, clinicianNameMatches("Ty Jones", rendered));
}
ok("the old roster label would not have", !clinicianNameMatches("Tyra Jones (ABQ)", "Ty Jones"));
ok("\"Tyra Jones\" does not match \"Ty Jones\" without the alias", !clinicianNameMatches("Tyra Jones", "Ty Jones"));
ok("a different clinician does not match", !clinicianNameMatches("Liz Lopez", "Ty Jones"));
ok("a hyphenated surname matches its rendering",
  clinicianNameMatches("Danya Estrada-Rivera", "Danya Estrada-Rivera"));
ok("an empty name never matches", !clinicianNameMatches("", "Ty Jones"));
ok("a bare first name on the rendered side cannot satisfy a full name", !clinicianNameMatches("Ty Jones", "Ty"));

// ---------------------------------------------------------------------------
console.log("\n[3] The attach payload sends the TherapyNotes form");
const body = (therapist: string) => buildAttachBody({
  submissionId: 1,
  fields: { firstName: "Zzfirst", lastName: "Zzlast", dob: "01/02/1990", phone: "5055550100", clinicianName: therapist, contactId: 5, chartId: null } as any,
  documentName: "Client Survey 2026-09-28 (Sub 1)",
  baseUrl: "https://crm.example",
}) as Record<string, unknown>;
eq("Tyra Jones (ABQ) -> Ty Jones", body("Tyra Jones (ABQ)").clinician_name, "Ty Jones");
eq("Danya Estrada (RR) -> Danya Estrada-Rivera", body("Danya Estrada (RR)").clinician_name, "Danya Estrada-Rivera");
eq("Kristi Simmons (LL) -> Kristi Simmons", body("Kristi Simmons (LL)").clinician_name, "Kristi Simmons");
eq("an unknown clinician passes through, location dropped", body("Zzunknown Clinician (ABQ)").clinician_name, "Zzunknown Clinician");

// ---------------------------------------------------------------------------
console.log("\n[4] The tiebreak uses the same rules; ambiguity still refuses");
const tn = (contactId: number, chartId: string, clinicians: string[]): ContactIdentity => ({
  contactId, name: "Zzsame Zzperson", email: null, phone: null, patientDob: "1990-01-02",
  assignedProvider: null, chartId, clinicians, source: "therapynotes",
});
const crm = (contactId: number, assignedProvider: string): ContactIdentity => ({
  contactId, name: "Zzsame Zzperson", email: null, phone: null, patientDob: "1990-01-02",
  assignedProvider,
});
const survey = (provider: string): SubmittedIdentity => ({ name: "Zzsame Zzperson", dateOfBirth: "1990-01-02", provider });

let r = matchSubmission(survey("Tyra Jones (ABQ)"), [tn(0, "ZZCHART1", ["Ty Jones"]), tn(0, "ZZCHART2", ["Liz Lopez"])]);
eq("a 'Ty Jones' chart wins a tie for a 'Tyra Jones (ABQ)' survey", [r.status, r.reason, r.chartId], ["matched", "name_dob_provider", "ZZCHART1"]);
r = matchSubmission(survey("Tyra Jones (ABQ)"), [crm(7001, "Tyra Jones"), crm(7002, "Liz Lopez")]);
eq("a CRM contact assigned 'Tyra Jones' wins too", [r.status, r.contactId], ["matched", 7001]);
r = matchSubmission(survey("Tyra Jones (ABQ)"), [crm(7001, "Tyra Jones, LMHC"), crm(7002, "Liz Lopez")]);
eq("...with a credential on the assignment", [r.status, r.contactId], ["matched", 7001]);
r = matchSubmission(survey("Danya Estrada (RR)"), [tn(0, "ZZCHART3", ["Danya Estrada-Rivera"]), tn(0, "ZZCHART4", ["Ty Jones"])]);
eq("Danya Estrada finds her hyphenated chart name", [r.status, r.chartId], ["matched", "ZZCHART3"]);
r = matchSubmission(survey("Tyra Jones (ABQ)"), [tn(0, "ZZCHART1", ["Ty Jones"]), tn(0, "ZZCHART2", ["Ty Jones"])]);
eq("two candidates under the same clinician: still refused", [r.status, r.reason], ["review", "provider_ambiguous"]);
r = matchSubmission(survey("Tyra Jones (ABQ)"), [crm(7001, "Tyra"), crm(7002, "Liz Lopez")]);
eq("a bare-first-name assignment does not break the tie", [r.status, r.reason], ["review", "provider_no_match"]);
r = matchSubmission(survey("Zzunknown Clinician (ABQ)"), [tn(0, "ZZCHART1", ["Ty Jones"]), tn(0, "ZZCHART2", ["Liz Lopez"])]);
eq("an unknown clinician breaks no tie", [r.status, r.reason], ["review", "provider_no_match"]);

// ---------------------------------------------------------------------------
console.log("\n[5] A clinician refusal says what was compared (staff names only)");
const runner = readFileSync(join(process.cwd(), "server", "survey", "attach-runner.ts"), "utf8");
ok("the refusal detail is kept for clinician_mismatch only",
  /reason === "clinician_mismatch" && typeof parsed\?\.message === "string"[\s\S]{0,80}clinicianCheck = parsed\.message\.slice\(0, 300\)/.test(runner));
ok("...recorded on the activity entry and the log line",
  runner.includes("...(clinicianCheck ? { clinicianCheck } : {}),") && runner.includes('clinician_check="${clinicianCheck}"'));
ok("the payload is built through the shared normalisation",
  runner.includes("clinician_name: surveyTherapistToTnClinician(fields.clinicianName),"));
const matching = readFileSync(join(process.cwd(), "server", "survey", "matching.ts"), "utf8");
ok("the tiebreak uses the shared rules", matching.includes("clinicianNameMatches(wanted, tn)") &&
  matching.includes("const wanted = surveyTherapistToTnClinician(submitted.provider);"));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
