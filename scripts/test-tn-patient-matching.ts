/**
 * Self-checks — TherapyNotes patients in the matcher.
 *
 * Run: npx tsx scripts/test-tn-patient-matching.ts
 *
 * No database, no network. Every identity below is invented for this file.
 *
 * THE BAR HAS NOT MOVED. Most of this file exists to prove that adding a second
 * population did not loosen anything: the near-miss cluster still goes to
 * review, a name miss is still not rescued by a provider, and a contradiction
 * still stops a match.
 */
import { readFileSync } from "fs";
import {
  collapseIdentities,
  matchSubmission,
  nameKey,
  type ContactIdentity,
  type SubmittedIdentity,
} from "../server/survey/matching";
import { collapseByChart } from "../server/therapy-notes/tn-patients-runner";

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

const crm = (id: number, name: string, dob: string, o: Partial<ContactIdentity> = {}): ContactIdentity =>
  ({ contactId: id, name, email: null, phone: null, patientDob: dob, ...o });
const tn = (chartId: string, name: string, dob: string, o: Partial<ContactIdentity> = {}): ContactIdentity =>
  ({ contactId: null, name, email: null, phone: null, patientDob: dob, chartId, clinicians: [], source: "therapynotes", ...o });
const survey = (name: string, dob: string, o: Partial<SubmittedIdentity> = {}): SubmittedIdentity =>
  ({ name, dateOfBirth: dob, ...o });

// ===========================================================================
console.log("\n[1] Parenthesised names — the results-table versus chart gap");
{
  // 136 of the 1,011 live rows carry a parenthetical. Stripping it is the one
  // normalisation change this build makes, and it applies to BOTH populations.
  eq("a preferred name in brackets is not part of the key",
    nameKey("Wendell (Wendy) Puffin"), nameKey("Wendell Puffin"));
  eq("...whichever side carries it", nameKey("Puffin, Wendell"), nameKey("Wendell (Wendy) Puffin"));
  eq("a bracketed segment mid-name is stripped too",
    nameKey("Marigold (Mari) Thistleby"), nameKey("Marigold Thistleby"));
  // Everything nameKey already did must still hold.
  eq("token order still does not matter", nameKey("Thistleby, Marigold"), nameKey("Marigold Thistleby"));
  eq("apostrophes are still deleted intra-word", nameKey("O'Brien"), nameKey("OBrien"));
  eq("diacritics still fold", nameKey("Renée"), nameKey("Renee"));
  check("a hyphen is still two tokens, so a married surname still differs",
    nameKey("Ashgrove-Pemberton") !== nameKey("Ashgrove"));
  check("A MIDDLE NAME IS STILL A REAL DIFFERENCE — deliberately unchanged",
    nameKey("Wendell Michael Puffin") !== nameKey("Wendell Puffin"));
}

// ===========================================================================
console.log("\n[2] The case this build exists for");
{
  // A patient who exists ONLY in TherapyNotes. Before this build: no candidates.
  const ids = collapseIdentities(
    [crm(1, "Someone Else", "1970-01-01")],
    [tn("77001", "Barnaby Quillfeather", "3/14/1988", {
      phone: "(505) 555-0143", clinicians: ["Anna Aldridge"],
    })],
  );
  const out = matchSubmission(
    survey("Barnaby Quillfeather", "1988-03-14", { phone: "5055550143", provider: "Anna Aldridge (ABQ)" }),
    ids,
  );
  eq("it matches", out.status, "matched");
  eq("...to the chart", out.chartId, "77001");
  eq("...with no CRM contact, because there is none", out.contactId, null);
  eq("...and the phone corroborated", out.reason, "name_dob_phone");
}

// ===========================================================================
console.log("\n[3] THE THREE-FIELD RULE — name, date of birth, clinician, no phone");
{
  // 7 of 1,011 patients have no phone. This is the rule for them, on the record.
  const ids = collapseIdentities([], [
    tn("77002", "Odette Marchbanks", "7/2/1991", { clinicians: ["Jill Nantze"] }),
  ]);
  const out = matchSubmission(
    survey("Odette Marchbanks", "1991-07-02", { provider: "Jill Nantze (LL)" }), ids,
  );
  eq("a single candidate with no phone on either side still matches", out.status, "matched");
  eq("...and says it rested on name and date of birth alone", out.reason, "name_dob");
  eq("...carrying the chart", out.chartId, "77002");

  // And the bar it does NOT lower: a typed phone that belongs to someone else
  // still stops the match, exactly as before.
  const withOther = collapseIdentities([], [
    tn("77002", "Odette Marchbanks", "7/2/1991", { clinicians: ["Jill Nantze"] }),
    tn("77003", "Someone Different", "1/1/1980", { phone: "(505) 555-0199" }),
  ]);
  eq("a phone on record against another patient still contradicts",
    matchSubmission(survey("Odette Marchbanks", "1991-07-02", { phone: "5055550199" }), withOther).status,
    "review");
}

// ===========================================================================
console.log("\n[4] A person in both systems is ONE candidate");
{
  const contact = crm(42, "Casimir Underhill", "1975-11-02", { chartId: "77010" });
  const patient = tn("77010", "Casimir Underhill", "11/2/1975", { clinicians: ["Krista Luna"] });
  const ids = collapseIdentities([contact], [patient]);
  eq("two rows collapse to one identity", ids.length, 1);
  eq("...keeping the CRM contact id", ids[0].contactId, 42);
  eq("...and gaining the chart", ids[0].chartId, "77010");
  eq("...and the clinician list", ids[0].clinicians, ["Krista Luna"]);

  const out = matchSubmission(survey("Casimir Underhill", "1975-11-02"), ids);
  eq("it matches rather than reading as ambiguous", out.status, "matched");
  eq("...to the contact", out.contactId, 42);
  eq("...and carries the chart too", out.chartId, "77010");

  // Without the link there is nothing to collapse on, and two identities that
  // agree on everything are correctly ambiguous.
  const unlinked = collapseIdentities([crm(43, "Casimir Underhill", "1975-11-02")], [patient]);
  eq("an unlinked contact and patient stay two identities", unlinked.length, 2);
  eq("...and go to review rather than guessing",
    matchSubmission(survey("Casimir Underhill", "1975-11-02"), unlinked).status, "review");
}

// ===========================================================================
console.log("\n[5] Shared care — one chart, several clinicians");
{
  // Zero patients are shared-care today. The shape is here because one will be.
  const rows = collapseByChart([
    { option_value: "any", label: "Any Clinician", is_aggregate: true, status: "success",
      rows: [{ chart_id: "77020", name: "X", dob: "1/1/1990", phone: "", clinician_option_value: "any", clinician_label: "Any Clinician" }] },
    { option_value: "c1", label: "Anna Aldridge", status: "success",
      rows: [{ chart_id: "77020", name: "Perpetua Glimmerwick", dob: "5/9/1993", phone: "(505) 555-0111", clinician_option_value: "c1", clinician_label: "Anna Aldridge" }] },
    { option_value: "c2", label: "Jill Nantze", status: "success",
      rows: [{ chart_id: "77020", name: "Perpetua Glimmerwick", dob: "5/9/1993", phone: "(505) 555-0111", clinician_option_value: "c2", clinician_label: "Jill Nantze" }] },
  ] as any);
  eq("two occurrences become one row", rows.length, 1);
  eq("...with both clinicians", rows[0].clinicians, ["Anna Aldridge", "Jill Nantze"]);
  check("the aggregate option contributed nothing", rows[0].name === "Perpetua Glimmerwick");

  const ids = collapseIdentities([], [
    tn("77020", "Perpetua Glimmerwick", "5/9/1993", { clinicians: ["Anna Aldridge", "Jill Nantze"] }),
    tn("77021", "Perpetua Glimmerwick", "5/9/1993", { clinicians: ["Renee Singletary"] }),
  ]);
  eq("naming EITHER of the two separates them",
    matchSubmission(survey("Perpetua Glimmerwick", "1993-05-09", { provider: "Jill Nantze (LL)" }), ids).chartId,
    "77020");
  eq("naming the other one of the two also works",
    matchSubmission(survey("Perpetua Glimmerwick", "1993-05-09", { provider: "Anna Aldridge (ABQ)" }), ids).chartId,
    "77020");
  eq("naming the OTHER patient's clinician picks that one",
    matchSubmission(survey("Perpetua Glimmerwick", "1993-05-09", { provider: "Renee Singletary (RR)" }), ids).chartId,
    "77021");
  eq("naming a therapist neither sees stays review",
    matchSubmission(survey("Perpetua Glimmerwick", "1993-05-09", { provider: "Ivory Kahler (RR)" }), ids).reason,
    "provider_no_match");
}

// ===========================================================================
console.log("\n[6] The bar has not moved");
{
  const ids = collapseIdentities([], [
    tn("77030", "Rosalind Ashgrove", "3/14/1988", { clinicians: ["Anna Aldridge"] }),
  ]);
  // The near-miss cluster: five spellings, none of which may match.
  [
    ["Rosalind Ashgrave", "a transposed letter"],
    ["Rosalind M Ashgrove", "an added middle initial"],
    ["Rosalind Ashgrove-Pemberton", "a hyphenated surname"],
    ["Roz Ashgrove", "a shortened first name"],
    ["Rosalind", "a first name alone"],
  ].forEach(([name, why]) => {
    const out = matchSubmission(survey(name, "1988-03-14", { provider: "Anna Aldridge (ABQ)" }), ids);
    check(`${why} does NOT match`, out.status === "review", `${name} -> ${out.status}/${out.reason}`);
  });
  eq("the exact name still does", matchSubmission(survey("Rosalind Ashgrove", "1988-03-14"), ids).status, "matched");

  // Provider must never rescue a name miss.
  const out = matchSubmission(survey("Rosalind Ashgrave", "1988-03-14", { provider: "Anna Aldridge (ABQ)" }), ids);
  eq("a name miss with the right therapist is still review", out.status, "review");
  eq("...reported as a name problem, not a provider one", out.reason, "no_candidates");

  // A wrong date of birth is still fatal.
  eq("the right name with the wrong date of birth is review",
    matchSubmission(survey("Rosalind Ashgrove", "1988-03-15"), ids).reason, "dob_mismatch");
  // A patient not in today's snapshot cannot match.
  eq("an empty snapshot matches nobody",
    matchSubmission(survey("Rosalind Ashgrove", "1988-03-14"), collapseIdentities([], [])).reason,
    "no_candidates");
}

// ===========================================================================
console.log("\n[7] A patient in both systems with DIFFERENT dates of birth");
{
  // The link is the chart id, so they collapse — and the CRM row's date of
  // birth is what survives, because staff maintain it. Documented rather than
  // silently resolved either way.
  const ids = collapseIdentities(
    [crm(50, "Ignatius Fernwhistle", "1982-06-01", { chartId: "77040" })],
    [tn("77040", "Ignatius Fernwhistle", "6/2/1982")],
  );
  eq("they still collapse to one", ids.length, 1);
  eq("the CRM date of birth wins", ids[0].patientDob, "1982-06-01");
  eq("a survey typing the CRM date matches",
    matchSubmission(survey("Ignatius Fernwhistle", "1982-06-01"), ids).status, "matched");
  eq("a survey typing the EHR date does not",
    matchSubmission(survey("Ignatius Fernwhistle", "1982-06-02"), ids).status, "review");
}

// ===========================================================================
console.log("\n[8] A partial pull never replaces the snapshot");
{
  const runner = read("server/therapy-notes/tn-patients-runner.ts");
  check("a non-success status refuses to replace",
    /body\.status !== "success" \|\| failedOptions > 0/.test(runner));
  check("...and says the snapshot was kept", /not replacing the snapshot/.test(runner));
  check("an empty result also refuses", /returned no patient rows/.test(runner));
  check("the failure is recorded with what was kept", /keptRows: before\.rows/.test(runner));
  const db = read("server/therapy-notes/tn-patients-db.ts");
  check("the replace is one transaction", /BEGIN[\s\S]{0,400}DELETE FROM tn_patients/.test(db));
  check("...rolled back on failure", /ROLLBACK/.test(db));
  check("the aggregate option is never a source of rows", /is_aggregate\) continue/.test(runner));
}

// ===========================================================================
console.log("\n[9] Storage, schedule and discipline");
{
  const db = read("server/therapy-notes/tn-patients-db.ts");
  check("verbatim and normalised sit side by side",
    /name\s+TEXT NOT NULL/.test(db) && /name_key\s+TEXT NOT NULL/.test(db));
  check("the normalisers are the CRM's own, not new ones",
    /from "\.\.\/survey\/matching"/.test(db) && db.indexOf("nameKey") !== -1);
  check("no second normaliser is defined here",
    !/function\s+(nameKey|canonicalDob|phoneKey)\s*\(/.test(db));
  check("shared care is a list on one row", /clinicians\s+TEXT NOT NULL DEFAULT '\[\]'/.test(db));
  check("the contact link is additive and nullable",
    /ADD COLUMN IF NOT EXISTS tn_chart_id TEXT/.test(db));
  check("the chart lands on the submission", /ADD COLUMN IF NOT EXISTS matched_chart_id TEXT/.test(db));
  check("the link is only ever written from a match, never guessed",
    /tn_chart_id IS DISTINCT FROM/.test(db));

  const cron = read("server/reminders/cron.ts");
  check("the pull is scheduled", cron.indexOf("startTnPatientsCron") !== -1);
  check("at 03:00, after the count pass", /DEFAULT_TN_PATIENTS_SCHEDULE = "0 3 \* \* \*"/.test(cron));
  check("with an explicit Mountain timezone", /TN_PATIENTS_TIMEZONE = "America\/Denver"/.test(cron));
  check("an invalid expression refuses to schedule", /patient pull NOT scheduled/.test(cron));
  check("an overlapping pull is skipped", cron.indexOf("isPullingPatients") !== -1);

  const runner = read("server/survey/match-runner.ts");
  check("the matcher reads both populations", /getTnPatientIdentities\(\)/.test(runner));
  check("...and collapses them", /collapseIdentities\(contacts, tnIdentities\)/.test(runner));
  check("an empty snapshot degrades rather than throwing", /\.catch\(\(\) => \[\]\)/.test(runner));
  check("human resolutions still survive a re-run",
    /humanResolved\.has\(sub\.id\)/.test(runner) &&
    /resolved_by IS NULL/.test(read("server/survey/match-db.ts")));
}

// ===========================================================================
console.log("\n[10] No PHI in any log line");
{
  [
    "server/therapy-notes/tn-patients-runner.ts",
    "server/therapy-notes/tn-patients-db.ts",
    "server/survey/match-runner.ts",
  ].forEach((f) => {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const logs = (code.match(/console\.(log|warn|error)\([\s\S]*?\);/g) ?? []).join("\n");
    // Only INTERPOLATED values count. A migration message naming the column
    // `tn_chart_id`, or a count called `before.rows`, is not a patient value —
    // the first version of this check flagged both and was simply wrong.
    const interpolated = (logs.match(/\$\{[^}]*\}/g) ?? []).join(" ");
    const bad = /\.name\b|\.dob\b|\.phone\b|\bchartId\b|patientDob|\.clinicians\b|\brows\[/;
    check(`${f.split("/").pop()}: no log line interpolates an identity field`,
      !bad.test(interpolated), interpolated.slice(0, 160));
  });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
