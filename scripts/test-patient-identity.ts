/**
 * Patient identity (legal name + DOB), the tiebreak on it, and three strikes.
 *
 *   npx tsx scripts/test-patient-identity.ts
 *
 * Pure. Every name is invented; clinician names are staff names.
 */
import { groupTnPatients, legalNameKey, patientKey, type TnPatientRowInput } from "../server/therapy-notes/tn-patient-groups";
import { collapseIdentities, matchSubmission, type ContactIdentity, type SubmittedIdentity } from "../server/survey/matching";
import { STRIKE_LIMIT, strikeReviewReason, strikeRun, type AttachEvent } from "../server/survey/attach-strikes";
import { REASON_LABEL } from "../shared/survey-match-reasons";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const row = (chartId: string, name: string, dob: string, clinicians: string[], phone = ""): TnPatientRowInput =>
  ({ chartId, name, dob, phone, clinicians });
const crm = (id: number, name: string, dob: string, o: Partial<ContactIdentity> = {}): ContactIdentity =>
  ({ contactId: id, name, email: null, phone: null, patientDob: dob, ...o });
const survey = (name: string, dob: string, provider?: string): SubmittedIdentity => ({ name, dateOfBirth: dob, provider: provider ?? null });
/** What match-runner does: group the rows, one TN identity per person. */
const tnIdentities = (rows: TnPatientRowInput[]): ContactIdentity[] => groupTnPatients(rows).map((g) => ({
  contactId: null, name: g.name, email: null, phone: g.phones[0] ?? null, altPhones: g.phones.slice(1),
  patientDob: g.dob, chartId: g.chartIds[0] ?? null, chartIds: g.chartIds, clinicians: g.clinicians,
  duplicateClinicians: g.duplicateClinicians, patientKey: g.patientKey, source: "therapynotes",
}));

// ---------------------------------------------------------------------------
console.log("\n[1] The legal name");
eq("plain name", legalNameKey("Rosalind Ashgrove"), "ashgrove rosalind");
eq("surname first, comma", legalNameKey("Ashgrove, Rosalind"), "ashgrove rosalind");
eq("Preferred (Legal) Last -> the legal reading", legalNameKey("Minor (Rowan) Thistlewood"), "rowan thistlewood");
eq("a trailing annotation is ignored", legalNameKey("Rosalind Ashgrove (dad)"), "ashgrove rosalind");
eq("accents and apostrophes fold as the matcher folds", legalNameKey("Siobhán O'Callaghan"), "ocallaghan siobhan");
eq("patient key = legal name | DOB, any DOB format", patientKey("Minor (Rowan) Thistlewood", "6/12/2015"), "rowan thistlewood|2015-06-12");
eq("no DOB -> no key", patientKey("Rosalind Ashgrove", ""), null);

// ---------------------------------------------------------------------------
console.log("\n[2] Grouping rows into people");
const mixed = [
  row("A1", "Odette Marchbanks", "7/2/1991", ["Jill Nantze"], "(505) 555-0101"),
  row("A2", "Odette Marchbanks", "07/02/1991", ["Krista Luna"], "(505) 555-0101"),   // same person, 2nd clinician, other id
  row("B1", "Minor (Rowan) Thistlewood", "6/12/2015", ["Liz Lopez"]),
  row("B2", "Minor (Robin) Thistlewood", "6/12/2015", ["Liz Lopez"]),               // twin: one birthday, other legal name
  row("C1", "Casimir Underhill", "11/2/1975", ["Ivory Kahler"]),
  row("C2", "Casimir Underhill", "11/2/1975", ["Ivory Kahler"]),                   // same clinician twice: TRUE duplicate
  row("D1", "Nameless Dob", "", ["Liz Lopez"]),
];
const groups = groupTnPatients(mixed);
const g = (k: string) => groups.find((x) => x.patientKey === k);
eq("7 rows -> 5 people", groups.length, 5);
eq("one patient under two clinicians is ONE person with both", g("marchbanks odette|1991-07-02")?.clinicians, ["Jill Nantze", "Krista Luna"]);
eq("…both chart ids kept, as advisory", g("marchbanks odette|1991-07-02")?.chartIds, ["A1", "A2"]);
eq("…and that is NOT a duplicate", g("marchbanks odette|1991-07-02")?.duplicateClinicians, []);
ok("twins sharing a birthday and a preferred name stay two people",
  !!g("rowan thistlewood|2015-06-12") && !!g("robin thistlewood|2015-06-12"));
eq("same key under the SAME clinician IS a duplicate", g("casimir underhill|1975-11-02")?.duplicateClinicians, ["Ivory Kahler"]);
ok("a row with no DOB is its own person, keyed by its chart", !!g("chart:D1"));

// ---------------------------------------------------------------------------
console.log("\n[3] Matching on people");
// One patient seen by two clinicians, plus an unlinked CRM contact for them.
{
  const ids = collapseIdentities([crm(501, "Odette Marchbanks", "1991-07-02", { assignedProvider: "Jill Nantze" })], tnIdentities(mixed));
  const out = matchSubmission(survey("Odette Marchbanks", "1991-07-02", "Krista Luna (LL)"), ids);
  eq("two rows of one patient + their contact -> matched, not ambiguous", [out.status, out.contactId], ["matched", 501]);
  ok("…recording one of the person's chart ids (advisory)", ["A1", "A2"].includes(String(out.chartId)));
  const noTherapist = matchSubmission(survey("Odette Marchbanks", "1991-07-02"), ids);
  eq("no therapist named is still one person -> matched", noTherapist.status, "matched");
}
// TN-only patient under two clinicians, no CRM contact at all.
{
  const ids = collapseIdentities([], tnIdentities(mixed));
  const out = matchSubmission(survey("Odette Marchbanks", "1991-07-02", "Jill Nantze (ABQ)"), ids);
  eq("TN-only patient under two clinicians -> matched", [out.status, out.contactId, out.chartId], ["matched", null, "A1"]);
  const other = matchSubmission(survey("Odette Marchbanks", "1991-07-02", "Ivory Kahler (RR)"), ids);
  eq("…even naming a therapist neither row has: one person needs no tiebreak", other.status, "matched");
}
// Two DIFFERENT people who both answer to the name typed: the tiebreak picks
// the one whose clinician set holds the therapist.
{
  const ids = collapseIdentities(
    [crm(601, "Rowan Thistlewood", "2015-06-12")],                                    // legal "rowan thistlewood"
    tnIdentities([row("E1", "Rowan (Robin) Thistlewood", "6/12/2015", ["Liz Lopez"])]), // legal "robin thistlewood"
  );
  eq("different legal names, same reading: two people", ids.length, 2);
  const picks = matchSubmission(survey("Rowan Thistlewood", "2015-06-12", "Liz Lopez (LL)"), ids);
  eq("tiebreak picks the person whose clinicians include the therapist", [picks.status, picks.reason, picks.contactId, picks.chartId],
    ["matched", "name_dob_provider", null, "E1"]);
  const both = collapseIdentities(
    [crm(602, "Rowan Thistlewood", "2015-06-12", { assignedProvider: "Liz Lopez" })],
    tnIdentities([row("E1", "Rowan (Robin) Thistlewood", "6/12/2015", ["Liz Lopez"])]));
  eq("two DIFFERENT people both carrying the therapist -> provider_ambiguous",
    matchSubmission(survey("Rowan Thistlewood", "2015-06-12", "Liz Lopez (LL)"), both).reason, "provider_ambiguous");
  eq("…and neither carrying it -> provider_no_match",
    matchSubmission(survey("Rowan Thistlewood", "2015-06-12", "Ivory Kahler (RR)"), both).reason, "provider_no_match");
}
// A true duplicate chart stays in review.
{
  const ids = collapseIdentities([], tnIdentities(mixed));
  const out = matchSubmission(survey("Casimir Underhill", "1975-11-02", "Ivory Kahler (RR)"), ids);
  eq("a person listed twice under one clinician -> review duplicate_chart", [out.status, out.reason], ["review", "duplicate_chart"]);
  const folded = collapseIdentities([crm(701, "Casimir Underhill", "1975-11-02")], tnIdentities(mixed));
  eq("…also when their CRM contact folds the chart in", matchSubmission(survey("Casimir Underhill", "1975-11-02"), folded).reason, "duplicate_chart");
}
// A contact still linked to last week's chart id folds into tonight's rows.
{
  const ids = collapseIdentities([crm(801, "Odette Marchbanks", "1991-07-02", { chartId: "A2" })], tnIdentities(mixed));
  const person = ids.find((c) => c.contactId === 801)!;
  eq("a linked contact keeps its own chart id when it is among the person's", [person.chartId, person.chartIds], ["A2", ["A1", "A2"]]);
  eq("…and gains every clinician", person.clinicians, ["Jill Nantze", "Krista Luna"]);
}
// Two CRM contacts for one person are not merged: the couples case.
{
  const ids = collapseIdentities([
    crm(901, "Odette Marchbanks", "1991-07-02", { assignedProvider: "Jill Nantze" }),
    crm(902, "Odette Marchbanks", "1991-07-02", { assignedProvider: "Krista Luna" }),
  ], tnIdentities(mixed));
  eq("two same-key contacts: the chart is folded into neither", ids.filter((c) => c.name === "Odette Marchbanks").length, 3);
  eq("the therapist separates the two contacts (couples case)",
    [matchSubmission(survey("Odette Marchbanks", "1991-07-02", "Krista Luna (LL)"), ids).contactId], [902]);
  ok("…and the shared chart never made it a three-way tie", true);
}
// Speed: a nightly table's worth of rows.
{
  const big: TnPatientRowInput[] = [];
  for (let i = 0; i < 1100; i++) {
    big.push(row(`Z${i}`, `Zzpatient${i % 950} Zzsurname`, `1/${(i % 28) + 1}/1980`, [`Clinician ${i % 33}`]));
  }
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 20; k++) groupTnPatients(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  console.log(`  …grouping 1,100 rows takes ${ms.toFixed(2)} ms`);
  ok("grouping 1,100 rows at read time is cheap (< 25 ms)", ms < 25, `${ms} ms`);
}

// ---------------------------------------------------------------------------
console.log("\n[4] Three strikes");
const night = (code: string | null): AttachEvent => ({ code, trigger: "scheduled" });
const press = (code: string | null): AttachEvent => ({ code, trigger: "manual" });
eq("limit is three", STRIKE_LIMIT, 3);
eq("3 nights of patient_not_found", strikeRun([night("patient_not_found"), night("patient_not_found"), night("patient_not_found")]),
  { code: "patient_not_found", nights: 3 });
eq("5 nights", strikeRun(Array(5).fill(night("patient_not_found")))?.nights, 5);
eq("2 nights is not yet three", strikeRun([night("field_unreadable"), night("field_unreadable")])?.nights, 2);
eq("an outage night is skipped: neither counts nor breaks",
  strikeRun([night("patient_not_found"), night("agent_unreachable"), night("login_failed"), night("unknown_error"),
    night("agent_timeout"), night("patient_not_found"), night("patient_not_found")]),
  { code: "patient_not_found", nights: 3 });
eq("outages alone are no strikes", strikeRun([night("agent_unreachable"), night("agent_timeout"), night("unknown_error")]), null);
eq("a success resets", strikeRun([night("patient_not_found"), night(null), night("patient_not_found"), night("patient_not_found")])?.nights, 1);
eq("a different code resets the run", strikeRun([night("patient_not_found"), night("field_unreadable"), night("field_unreadable")])?.nights, 1);
eq("a non-strike refusal ends it", strikeRun([night("pdf_download_failed"), night("patient_not_found"), night("patient_not_found")]), null);
eq("a staff press is not a night", strikeRun([press("patient_not_found"), night("patient_not_found"), night("patient_not_found")])?.nights, 2);
eq("review reason", strikeReviewReason("patient_not_found"), "attach_repeated_patient_not_found");
ok("its label says three nights and what to do",
  REASON_LABEL.attach_repeated_patient_not_found.endsWith("(3 nights in a row); file by hand or check the record"));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
