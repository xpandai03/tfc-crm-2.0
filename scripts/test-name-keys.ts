/**
 * Self-checks — every reading of a name, and parity with the browser agent.
 *
 * Run: npx tsx scripts/test-name-keys.ts
 *
 * No database, no network. Every identity below is invented for this file.
 *
 * THE SHARED TABLE. The cases under [1], [2] and [5] are the same cases the
 * agent asserts in tests/test_name_keys.py. They exist twice on purpose: two
 * codebases compare names against the same rows, and the only way they stay one
 * rule is if both are pinned to the same table. If a case here changes, the
 * agent's copy changes with it.
 */
import { readFileSync } from "fs";
import {
  canonicalDob,
  collapseIdentities,
  matchSubmission,
  nameKey,
  nameKeys,
  namesAgree,
  type ContactIdentity,
  type SubmittedIdentity,
} from "../server/survey/matching";
import { classifyNameShapes } from "../server/therapy-notes/tn-patients-runner";

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

const crm = (id: number, name: string, dob: string, o: Partial<ContactIdentity> = {}): ContactIdentity =>
  ({ contactId: id, name, email: null, phone: null, patientDob: dob, ...o });
const tn = (chartId: string, name: string, dob: string, o: Partial<ContactIdentity> = {}): ContactIdentity =>
  ({ contactId: null, name, email: null, phone: null, patientDob: dob, chartId, clinicians: [], source: "therapynotes", ...o });
const survey = (name: string, dob: string, o: Partial<SubmittedIdentity> = {}): SubmittedIdentity =>
  ({ name, dateOfBirth: dob, ...o });

// ===========================================================================
console.log("\n[1] nameKey is UNCHANGED — many callers depend on it");
{
  eq("word order still does not matter", nameKey("Puffin, Wendell"), nameKey("Wendell Puffin"));
  eq("apostrophes are still deleted intra-word", nameKey("O'Brien"), nameKey("OBrien"));
  eq("diacritics still fold", nameKey("Renée"), "renee");
  eq("a parenthetical is still stripped", nameKey("Minor (Rowan) Thistlewood"), "minor thistlewood");
  check("a hyphen is still two tokens", nameKey("Ashgrove-Pemberton") !== nameKey("Ashgrove"));
  check("a middle name is still a real difference",
    nameKey("Wendell Michael Puffin") !== nameKey("Wendell Puffin"));
  eq("empty is still empty", nameKey(""), "");
}

// ===========================================================================
console.log("\n[2] nameKeys — every reading, never a guess at which is legal");
{
  eq("Preferred (Legal) Last reads BOTH ways",
    nameKeys("Minor (Rowan) Thistlewood"), ["minor thistlewood", "rowan thistlewood"]);
  eq("Legal (Nickname) Last reads both ways too — the old shape still works",
    nameKeys("Wendell (Wendy) Puffin"), ["puffin wendell", "puffin wendy"]);
  eq("a TRAILING group annotates and contributes no reading",
    nameKeys("Rosalind Ashgrove (dad)"), ["ashgrove rosalind"]);
  eq("no parenthetical is exactly one reading",
    nameKeys("Rowan Thistlewood"), [nameKey("Rowan Thistlewood")]);
  eq("the first reading is ALWAYS nameKey — tn_patients.name_key depends on it",
    nameKeys("Minor (Rowan) Thistlewood")[0], nameKey("Minor (Rowan) Thistlewood"));

  console.log("\n[2a] Edge shapes");
  eq("TWO groups: the middle reads, the trailing annotates",
    nameKeys("Minor (Rowan) Thistlewood (dad)"), ["minor thistlewood", "rowan thistlewood"]);
  eq("a group in the SURNAME position is trailing, so it annotates",
    nameKeys("Rowan Thistlewood (Smith)"), ["rowan thistlewood"]);
  eq("a group with words after it reads, wherever it sits",
    nameKeys("Rowan (Thistlewood) Smith"), ["rowan smith", "thistlewood smith"]);
  eq("a LEADING group still reads", nameKeys("(Rowan) Thistlewood"), ["thistlewood", "rowan thistlewood"]);
  eq("an empty group contributes nothing", nameKeys("Minor () Thistlewood"), ["minor thistlewood"]);
  eq("an unbalanced paren is just a separator", nameKeys("Rowan (Thistlewood"), ["rowan thistlewood"]);
  eq("empty has no readings", nameKeys("   "), []);
  eq("null has no readings", nameKeys(null), []);
  eq("a hyphenated surname inside a group keeps both tokens",
    nameKeys("Minor (Rowan) Thistlewood-Smith"),
    ["minor thistlewood smith", "rowan thistlewood smith"]);
  eq("'Minor' as an ACTUAL surname is untouched", nameKeys("Rowan Minor"), ["rowan minor"]);
}

// ===========================================================================
console.log("\n[3] namesAgree — intersection, not subset");
{
  check("THE CASE THIS BUILD EXISTS FOR", namesAgree("Rowan Thistlewood", "Minor (Rowan) Thistlewood"));
  check("...and symmetrically", namesAgree("Minor (Rowan) Thistlewood", "Rowan Thistlewood"));
  check("the old shape still agrees", namesAgree("Wendell Puffin", "Wendell (Wendy) Puffin"));
  check("a nickname on the survey agrees too", namesAgree("Wendy Puffin", "Wendell (Wendy) Puffin"));
  check("word order still does not matter", namesAgree("Thistlewood, Rowan", "Minor (Rowan) Thistlewood"));

  console.log("\n[3a] What it must still REFUSE");
  check("a hyphenated surname is not the same person",
    !namesAgree("Rowan Thistlewood", "Rowan Thistlewood-Smith"));
  check("a middle name is a real difference",
    !namesAgree("Rowan Thistlewood", "Rowan James Thistlewood"));
  check("the preferred token alone is not the person",
    !namesAgree("Minor Thistlewood", "Rowan Thistlewood"));
  check("an empty name agrees with nothing", !namesAgree("", "Rowan Thistlewood"));
  check("a surname alone is not a full name", !namesAgree("Thistlewood", "Minor (Rowan) Thistlewood"));
}

// ===========================================================================
console.log("\n[4] matchSubmission — the survey that could not match, now matches");
{
  const ids = collapseIdentities(
    [crm(1, "Zzsomeone Zzelse", "1970-01-01")],
    [tn("77001", "Minor (Rowan) Thistlewood", "6/12/2015", {
      phone: "(505) 555-0164", clinicians: ["Bentley Carbone"],
    })],
  );
  const out = matchSubmission(
    survey("Rowan Thistlewood", "2015-06-12", { phone: "5055550164", provider: "Bentley Carbone (ABQ)" }),
    ids,
  );
  eq("it matches", out.status, "matched");
  eq("...to the chart", out.chartId, "77001");
  eq("...with no CRM contact, because there is none", out.contactId, null);
  eq("...and the phone corroborated", out.reason, "name_dob_phone");

  console.log("\n[4a] THE BAR HAS NOT MOVED");
  const wrongDob = matchSubmission(survey("Rowan Thistlewood", "2014-06-12"), ids);
  eq("a wrong date of birth still goes to review", wrongDob.status, "review");
  eq("...and says the name is on record but the date is not", wrongDob.reason, "dob_mismatch");

  const middle = collapseIdentities([], [tn("77002", "Minor (Rowan James) Thistlewood", "6/12/2015")]);
  const mOut = matchSubmission(survey("Rowan Thistlewood", "2015-06-12"), middle);
  eq("a middle name the client did not type still refuses", mOut.status, "review");
  eq("...as no_candidates", mOut.reason, "no_candidates");

  const hyph = collapseIdentities([], [tn("77003", "Minor (Rowan) Thistlewood-Smith", "6/12/2015")]);
  eq("a hyphenated surname still refuses",
    matchSubmission(survey("Rowan Thistlewood", "2015-06-12"), hyph).status, "review");

  console.log("\n[4b] Broader keys mean more COLLISIONS, and collisions go to review");
  const twins = collapseIdentities([], [
    tn("77004", "Minor (Rowan) Thistlewood", "6/12/2015"),
    tn("77005", "Rowan Thistlewood", "6/12/2015"),
  ]);
  const t = matchSubmission(survey("Rowan Thistlewood", "2015-06-12"), twins);
  eq("two rows now agreeing on a reading is ambiguity, not a match", t.status, "review");
  eq("...as multiple_candidates", t.reason, "multiple_candidates");
}

// ===========================================================================
console.log("\n[5] The CRM contacts side — one person, one candidate");
{
  // A contact and the TherapyNotes patient for the same person, linked by chart
  // id. They must collapse to ONE candidate, not two that look ambiguous.
  const ids = collapseIdentities(
    [crm(42, "Rowan Thistlewood", "2015-06-12", { chartId: "77001" })],
    [tn("77001", "Minor (Rowan) Thistlewood", "6/12/2015")],
  );
  eq("collapsed to one identity", ids.length, 1);
  const out = matchSubmission(survey("Rowan Thistlewood", "2015-06-12"), ids);
  eq("matched, not called ambiguous", out.status, "matched");
  eq("...keeping the CRM contact id", out.contactId, 42);
  eq("...and carrying the chart", out.chartId, "77001");

  // A CRM contact with a parenthetical of its own, unlinked, keys every reading.
  const paren = [crm(43, "Minor (Rosalind) Ashgrove", "1990-02-01")];
  eq("a parenthesised CONTACT matches its legal name",
    matchSubmission(survey("Rosalind Ashgrove", "1990-02-01"), paren).status, "matched");
}

// ===========================================================================
console.log("\n[6] Name-shape classification — counts only, no names");
{
  const rows = [
    { name: "Rowan Thistlewood" },
    { name: "Minor (Rowan) Thistlewood" },
    { name: "minor (rosalind) ashgrove" },
    { name: "Wendell (Wendy) Puffin" },
    { name: "Rosalind Ashgrove (dad)" },
    { name: "(Rowan) Thistlewood" },
  ];
  const s = classifyNameShapes(rows);
  eq("plain", s.plain, 1);
  eq("preferred-legal-last", s.preferredLegalLast, 3);
  eq("...of which flagged Minor (case-insensitive)", s.minorFlag, 2);
  eq("trailing annotation", s.trailingAnnotation, 1);
  eq("leading group is neither shape and is counted as other", s.other, 1);
  eq("every row is counted exactly once",
    s.plain + s.preferredLegalLast + s.trailingAnnotation + s.other, rows.length);
}

// ===========================================================================
console.log("\n[7] Parity contract with the browser agent");
{
  const PARITY: [string, string[]][] = [
    ["Minor (Rowan) Thistlewood", ["minor thistlewood", "rowan thistlewood"]],
    ["Wendell (Wendy) Puffin", ["puffin wendell", "puffin wendy"]],
    ["Rosalind Ashgrove (dad)", ["ashgrove rosalind"]],
    ["Rowan Thistlewood", ["rowan thistlewood"]],
    ["Thistlewood, Rowan", ["rowan thistlewood"]],
    ["Siobhán O'Callaghan", ["ocallaghan siobhan"]],
    ["Ashgrove-Pemberton, Rosalind", ["ashgrove pemberton rosalind"]],
    ["Minor (Rowan) Thistlewood (dad)", ["minor thistlewood", "rowan thistlewood"]],
    ["(Rowan) Thistlewood", ["thistlewood", "rowan thistlewood"]],
    ["Rowan (Thistlewood) Smith", ["rowan smith", "thistlewood smith"]],
    ["Minor () Thistlewood", ["minor thistlewood"]],
    ["Rowan Minor", ["rowan minor"]],
  ];
  for (const [raw, want] of PARITY) eq(`parity: ${JSON.stringify(raw)}`, nameKeys(raw), want);
}

// ===========================================================================
console.log("\n[8] Source guards — one rule, not three copies of one");
{
  const matching = readFileSync("server/survey/matching.ts", "utf8");
  const db = readFileSync("server/therapy-notes/tn-patients-db.ts", "utf8");

  check("matchSubmission compares READINGS, not a single key",
    /const keys = new Set\(nameKeys\(submitted\.name\)\)/.test(matching)
    && /nameKeys\(c\.name\)/.test(matching));
  check("nameKey itself is untouched — still strips and still sorts",
    /\.replace\(\/\\\(\[\^\)\]\*\\\)\/g, " "\)/.test(matching) && /\.sort\(\)/.test(matching));
  check("the store writes every reading",
    /nameKeys\(r\.name\)/.test(db) && /tn_patient_name_keys/.test(db));
  check("the store still has no normaliser of its own",
    !/function\s+(nameKey|nameKeys|canonicalDob|phoneKey)\s*\(/.test(db));
  check("canonicalDob is unchanged in shape", typeof canonicalDob("2015-06-12") === "string");
}

console.log(`\n${"=".repeat(62)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (failures.length) for (const f of failures) console.log(`    - ${f}`);
console.log(`${"=".repeat(62)}\n`);
process.exit(fail ? 1 : 0);
