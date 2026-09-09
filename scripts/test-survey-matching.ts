/**
 * Self-checks for survey → contact matching, 2026-09-03 client criteria.
 *
 * Run: npx tsx scripts/test-survey-matching.ts
 *
 * PURE. matchSubmission() takes a contact snapshot and returns an outcome, so
 * every rule below is exercised against an in-memory contact set — no database,
 * no test contacts written anywhere, nothing to clean up.
 *
 * NO PHI. Every identity here is invented for this file.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  canonicalDob, emailKey, matchSubmission, nameKey, phoneKey, providerKey,
  type ContactIdentity, type SubmittedIdentity,
} from "../server/survey/matching";
import {
  MATCHED_REASONS, REASON_LABEL, REASON_SHORT, REVIEW_REASONS,
  failedFieldFor, isMatchReason, reasonText,
} from "../shared/survey-match-reasons";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const contact = (o: Partial<ContactIdentity> & { contactId: number; name: string }): ContactIdentity => ({
  email: null, phone: null, patientDob: null, assignedProvider: null, ...o,
});
const submit = (o: Partial<SubmittedIdentity> & { name: string; dateOfBirth: string }): SubmittedIdentity => o;

/** Assert an outcome in one line. */
function expect(
  label: string,
  submitted: SubmittedIdentity,
  contacts: ContactIdentity[],
  want: { status: "matched" | "review"; reason: string; contactId?: number | null },
) {
  const got = matchSubmission(submitted, contacts);
  const good =
    got.status === want.status &&
    got.reason === want.reason &&
    (want.contactId === undefined || got.contactId === want.contactId);
  ok(label, good, `got ${got.status}/${got.reason}/contact=${got.contactId}`);
  return got;
}

// ===========================================================================
// The near-miss cluster. One synthetic identity, five submissions around it.
// ===========================================================================
console.log("\n[1] The five near-miss cases still route to review, each naming a field");

const ROSALIND = contact({
  contactId: 9001,
  name: "Rosalind Ashgrove",
  patientDob: "1988-03-14",
  phone: "(505) 555-0181",
  email: "rosalind.ashgrove@example.invalid",
  assignedProvider: "Anna Aldridge",
});
const ROSTER = [
  ROSALIND,
  contact({ contactId: 9002, name: "Marcus Trilby", patientDob: "1975-11-02", phone: "5055550199" }),
];

// The exact identity DOES match — the near misses below differ from this by one thing each.
expect("the exact identity matches (control)",
  submit({ name: "Rosalind Ashgrove", dateOfBirth: "1988-03-14",
           phone: "(505) 555-0181", email: "rosalind.ashgrove@example.invalid" }),
  ROSTER, { status: "matched", reason: "name_dob_phone_email", contactId: 9001 });

const nearMisses: Array<[string, SubmittedIdentity, string]> = [
  ["misspelled surname (Ashgrave)",
    submit({ name: "Rosalind Ashgrave", dateOfBirth: "1988-03-14", phone: "(505) 555-0181", email: "rosalind.ashgrove@example.invalid" }),
    "no_candidates"],
  ["added middle initial (Rosalind M Ashgrove)",
    submit({ name: "Rosalind M Ashgrove", dateOfBirth: "1988-03-14", phone: "(505) 555-0181", email: "rosalind.ashgrove@example.invalid" }),
    "no_candidates"],
  ["hyphenated married name (Ashgrove-Pemberton)",
    submit({ name: "Rosalind Ashgrove-Pemberton", dateOfBirth: "1988-03-14", phone: "(505) 555-0181", email: "rosalind.ashgrove@example.invalid" }),
    "no_candidates"],
  ["nickname (Roz Ashgrove)",
    submit({ name: "Roz Ashgrove", dateOfBirth: "1988-03-14", phone: "(505) 555-0181", email: "rosalind.ashgrove@example.invalid" }),
    "no_candidates"],
  ["transposed date of birth (03-14 -> 14-03 read as 1988-04-13)",
    submit({ name: "Rosalind Ashgrove", dateOfBirth: "1988-04-13", phone: "(505) 555-0181", email: "rosalind.ashgrove@example.invalid" }),
    "dob_mismatch"],
];
for (const [label, s, wantReason] of nearMisses) {
  const got = expect(`  ${label} -> review`, s, ROSTER, { status: "review", reason: wantReason, contactId: null });
  ok(`  ${label} names a field`, failedFieldFor(got.reason) !== null, got.reason);
}
// The transposed-DOB case must say the NAME was found — that is the whole point
// of splitting no_candidates into two codes.
eq("a transposed date of birth blames the date of birth, not the name",
  failedFieldFor("dob_mismatch"), "dateOfBirth");
eq("an unknown name blames the name", failedFieldFor("no_candidates"), "name");

// A nickname must never match, even with everything else perfect. This is the
// preferred-name rule, and it is the one the client was explicit about.
ok("a preferred name never matches a legal name",
  matchSubmission(submit({ name: "Roz Ashgrove", dateOfBirth: "1988-03-14" }), ROSTER).status === "review");

// ===========================================================================
// The couples case.
// ===========================================================================
console.log("\n[2] The couples case resolves, in both directions");

// One TherapyNotes account, two records: the same legal name, date of birth,
// phone and email. Only the provider differs.
const JEFF_INDIVIDUAL = contact({
  contactId: 9101, name: "Jeff Powers", patientDob: "1979-06-21",
  phone: "505-555-0110", email: "jeff.powers@example.invalid",
  assignedProvider: "Anna Aldridge",
});
const JEFF_COUPLE = contact({
  contactId: 9102, name: "Jeff Powers", patientDob: "1979-06-21",
  phone: "(505) 555-0110", email: "Jeff.Powers@example.invalid",
  assignedProvider: "Amber Lute",
});
const COUPLES = [JEFF_INDIVIDUAL, JEFF_COUPLE, ...ROSTER];
const jeffBase = { name: "Jeff Powers", dateOfBirth: "1979-06-21", phone: "(505) 555-0110", email: "jeff.powers@example.invalid" };

expect("names Anna Aldridge -> the individual record alone",
  submit({ ...jeffBase, provider: "Anna Aldridge (ABQ)" }),
  COUPLES, { status: "matched", reason: "name_dob_provider", contactId: 9101 });
expect("names Amber Lute -> the couple record alone",
  submit({ ...jeffBase, provider: "Amber Lute (LL)" }),
  COUPLES, { status: "matched", reason: "name_dob_provider", contactId: 9102 });

console.log("\n[3] A third provider matches neither, and says so");
expect("names a provider neither sees -> review",
  submit({ ...jeffBase, provider: "Krista Luna (ABQ)" }),
  COUPLES, { status: "review", reason: "provider_no_match", contactId: null });
eq("...and the reason names the provider", failedFieldFor("provider_no_match"), "provider");
// A malformed assignment value (there are two in production: a bare first name
// and a misspelling) must fail to break the tie rather than break it wrongly.
expect("an unreadable assignment value cannot break the tie",
  submit({ ...jeffBase, provider: "Ginger Rippey (RR)" }),
  [contact({ ...JEFF_INDIVIDUAL, assignedProvider: "Ginger" }), JEFF_COUPLE],
  { status: "review", reason: "provider_no_match", contactId: null });

console.log("\n[4] A phone that contradicts routes to review");
const PHONE_ELSEWHERE = [
  contact({ contactId: 9201, name: "Delia Okonkwo", patientDob: "1992-01-09", phone: "5055550120", email: "delia@example.invalid" }),
  contact({ contactId: 9202, name: "Marcus Trilby", patientDob: "1975-11-02", phone: "5055550175" }),
];
expect("phone belongs to someone else -> phone_contradiction",
  submit({ name: "Delia Okonkwo", dateOfBirth: "1992-01-09", phone: "(505) 555-0175" }),
  PHONE_ELSEWHERE, { status: "review", reason: "phone_contradiction", contactId: null });
eq("...and it names the phone", failedFieldFor("phone_contradiction"), "phone");
expect("a phone on nobody's record is unknown, not contradictory",
  submit({ name: "Delia Okonkwo", dateOfBirth: "1992-01-09", phone: "505-555-0999" }),
  PHONE_ELSEWHERE, { status: "matched", reason: "name_dob", contactId: 9201 });
// Households share numbers: 315 contacts do. An owner set containing the
// candidate corroborates, it does not conflict.
const HOUSEHOLD = [
  contact({ contactId: 9301, name: "Tomas Vance", patientDob: "2012-05-04", phone: "5055550140" }),
  contact({ contactId: 9302, name: "Priya Vance", patientDob: "1984-02-17", phone: "(505) 555-0140" }),
];
expect("a shared household number corroborates the child's own record",
  submit({ name: "Tomas Vance", dateOfBirth: "2012-05-04", phone: "505 555 0140" }),
  HOUSEHOLD, { status: "matched", reason: "name_dob_phone", contactId: 9301 });
expect("a shared household email likewise corroborates",
  submit({ name: "Tomas Vance", dateOfBirth: "2012-05-04", email: "vance.family@example.invalid" }),
  [contact({ ...HOUSEHOLD[0], email: "vance.family@example.invalid" }),
   contact({ ...HOUSEHOLD[1], email: "vance.family@example.invalid" })],
  { status: "matched", reason: "name_dob_email", contactId: 9301 });
expect("an email that belongs elsewhere still contradicts",
  submit({ name: "Delia Okonkwo", dateOfBirth: "1992-01-09", email: "someone.else@example.invalid" }),
  [...PHONE_ELSEWHERE, contact({ contactId: 9203, name: "Other Person", patientDob: "1970-01-01", email: "someone.else@example.invalid" })],
  { status: "review", reason: "email_contradiction", contactId: null });

console.log("\n[5] Provider never rescues a failure on another field");
// Exhaustive: for every way a submission can fail WITHOUT provider, adding a
// perfectly-matching provider must not change the verdict.
const RESCUE_BASE = contact({
  contactId: 9401, name: "Rosalind Ashgrove", patientDob: "1988-03-14",
  phone: "5055550181", email: "rosalind.ashgrove@example.invalid",
  assignedProvider: "Anna Aldridge",
});
const RESCUE_SET = [RESCUE_BASE, contact({ contactId: 9402, name: "Marcus Trilby", patientDob: "1975-11-02", phone: "5055550175", assignedProvider: "Anna Aldridge" })];
const failing: Array<[string, SubmittedIdentity]> = [
  ["a misspelled name", submit({ name: "Rosalind Ashgrave", dateOfBirth: "1988-03-14" })],
  ["an extra token", submit({ name: "Rosalind M Ashgrove", dateOfBirth: "1988-03-14" })],
  ["a hyphenated surname", submit({ name: "Rosalind Ashgrove-Pemberton", dateOfBirth: "1988-03-14" })],
  ["a nickname", submit({ name: "Roz Ashgrove", dateOfBirth: "1988-03-14" })],
  ["a wrong date of birth", submit({ name: "Rosalind Ashgrove", dateOfBirth: "1988-04-13" })],
  ["an unreadable date of birth", submit({ name: "Rosalind Ashgrove", dateOfBirth: "not a date" })],
  ["an empty name", submit({ name: "   ", dateOfBirth: "1988-03-14" })],
  ["a contradicting phone", submit({ name: "Rosalind Ashgrove", dateOfBirth: "1988-03-14", phone: "5055550175" })],
];
for (const [label, s] of failing) {
  const without = matchSubmission(s, RESCUE_SET);
  const withProvider = matchSubmission({ ...s, provider: "Anna Aldridge (ABQ)" }, RESCUE_SET);
  ok(`  ${label}: still review with a matching provider`, withProvider.status === "review", `${withProvider.status}/${withProvider.reason}`);
  eq(`  ${label}: the provider changed nothing at all`,
    { s: without.status, r: without.reason }, { s: withProvider.status, r: withProvider.reason });
}
// And structurally: no matched outcome may cite the provider unless it came
// from the tiebreak branch, which requires >1 candidate.
ok("a single candidate never reports a provider tiebreak",
  matchSubmission(submit({ name: "Rosalind Ashgrove", dateOfBirth: "1988-03-14", provider: "Anna Aldridge (ABQ)" }), RESCUE_SET).reason === "name_dob");

console.log("\n[6] Two candidates the provider cannot separate go to review");
expect("no therapist named -> multiple_candidates",
  submit(jeffBase), COUPLES, { status: "review", reason: "multiple_candidates", contactId: null });
expect("both assigned to the same therapist -> provider_ambiguous",
  submit({ ...jeffBase, provider: "Anna Aldridge (ABQ)" }),
  [JEFF_INDIVIDUAL, contact({ ...JEFF_COUPLE, assignedProvider: "Anna Aldridge" })],
  { status: "review", reason: "provider_ambiguous", contactId: null });
expect("neither has an assignment -> provider_no_match",
  submit({ ...jeffBase, provider: "Anna Aldridge (ABQ)" }),
  [contact({ ...JEFF_INDIVIDUAL, assignedProvider: null }), contact({ ...JEFF_COUPLE, assignedProvider: null })],
  { status: "review", reason: "provider_no_match", contactId: null });

console.log("\n[8] Pre-phone submissions degrade to the old criteria, without error");
// The 32 stored submissions carry no phone at all.
expect("no phone supplied -> matches on name + dob as before",
  submit({ name: "Rosalind Ashgrove", dateOfBirth: "1988-03-14" }),
  RESCUE_SET, { status: "matched", reason: "name_dob", contactId: 9401 });
expect("no phone, with a corroborating email -> name_dob_email",
  submit({ name: "Rosalind Ashgrove", dateOfBirth: "1988-03-14", email: "rosalind.ashgrove@example.invalid" }),
  RESCUE_SET, { status: "matched", reason: "name_dob_email", contactId: 9401 });
for (const missing of [undefined, null, "", "   "]) {
  const got = matchSubmission(submit({ name: "Rosalind Ashgrove", dateOfBirth: "1988-03-14", phone: missing as never }), RESCUE_SET);
  ok(`  phone=${JSON.stringify(missing)} is treated as no evidence`, got.status === "matched" && got.reason === "name_dob");
}
// A contact with no phone on record cannot be contradicted by one either.
expect("a contact with no stored phone still matches",
  submit({ name: "Solo Person", dateOfBirth: "1990-01-01", phone: "5055550001" }),
  [contact({ contactId: 9501, name: "Solo Person", patientDob: "1990-01-01" })],
  { status: "matched", reason: "name_dob", contactId: 9501 });
// Unusable phone fragments (3 exist in production) must not become a key that
// matches everything ending the same way.
for (const junk of ["505", "55501", "abc", "+", "1"]) {
  eq(`  phoneKey(${JSON.stringify(junk)}) is null`, phoneKey(junk), null);
}
eq("phoneKey folds a country code onto the ten-digit form", phoneKey("+1 (505) 555-0142"), "5055550142");
eq("phoneKey ignores punctuation", phoneKey("505.555.0142"), "5055550142");
eq("providerKey strips the roster's location suffix", providerKey("Tyra Jones (ABQ)"), "tyra jones");
eq("providerKey strips a credential suffix", providerKey("Tyra Jones, LMHC"), "tyra jones");
eq("providerKey agrees across both shapes", providerKey("Tyra Jones (ABQ)"), providerKey("Tyra Jones"));
eq("providerKey of nothing is empty", providerKey(null), "");

console.log("\n[9] No survey answer content reaches the queue");
const reviewSrc = readFileSync(join(process.cwd(), "client", "src", "components", "survey-match-review.tsx"), "utf8");
const routesSrc = readFileSync(join(process.cwd(), "server", "routes.ts"), "utf8");
const subsSrc = readFileSync(join(process.cwd(), "client", "src", "pages", "submissions.tsx"), "utf8");
/** Source with comments removed, so a doc line SAYING "no comments are shown"
 *  is not mistaken for code that shows them. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const reviewCode = codeOnly(reviewSrc);
for (const forbidden of [
  "overallRating", "connectionRating", "goalsRating", "approachRating",
  "followUpRequested", "additionalComments", "facilityClean", "privacyRespected",
]) {
  ok(`  the review dialog never reads ${forbidden}`, !reviewCode.includes(forbidden));
}
// "answers" and "comments" appear in the dialog's own copy telling the reviewer
// they are NOT shown, so a bare substring test flags the reassurance itself.
// What must not exist is a PROPERTY ACCESS on either.
for (const prop of ["answers", "comments"]) {
  const access = new RegExp(`[.\\[]\\s*["']?${prop}\\b`);
  ok(`  the review dialog never accesses .${prop}`, !access.test(reviewCode));
}
const reviewEndpoint = codeOnly(routesSrc.slice(
  routesSrc.indexOf('app.get("/api/survey/matching/review/:submissionId"'),
  routesSrc.indexOf('app.post("/api/survey/matching/resolve"'),
));
ok("  the review endpoint returns no answers object", !/answers:\s/.test(reviewEndpoint));
// Every read of the answers object must be the therapist and nothing else.
const answerReads = reviewEndpoint.match(/payload\.answers\??\.[A-Za-z_$][\w$]*/g) ?? [];
ok("  the review endpoint reads only the therapist answer",
  answerReads.length > 0 && answerReads.every((r) => r.endsWith(".therapist")),
  answerReads.join(", "));
// ...and the same for the matcher's own payload reader.
const runnerReads = codeOnly(readFileSync(join(process.cwd(), "server", "survey", "match-runner.ts"), "utf8"))
  .match(/answers\??\.[A-Za-z_$][\w$]*/g) ?? [];
ok("  the runner reads only the therapist answer",
  runnerReads.every((r) => r.endsWith(".therapist")), runnerReads.join(", "));
ok("  the list row's reason note reads only a fixed label",
  subsSrc.includes("REASON_SHORT[state.reason]") && !/MatchReasonNote[\s\S]{0,600}payload/.test(subsSrc));
ok("  confirm stays disabled until a contact is chosen",
  /disabled=\{busy \|\| chosen === null\}/.test(reviewSrc));
ok("  resolutions still record who and when",
  routesSrc.includes("recordHumanResolution") && readFileSync(join(process.cwd(), "server", "survey", "match-db.ts"), "utf8").includes("resolved_at        = NOW()"));

console.log("\n[10] Nothing here writes to a contact");
const dbSrc = readFileSync(join(process.cwd(), "server", "survey", "match-db.ts"), "utf8");
ok("  match-db issues no UPDATE/INSERT/DELETE against sync_contacts",
  !/(UPDATE|INSERT INTO|DELETE FROM)\s+sync_contacts/i.test(dbSrc));
ok("  match-db issues no write against contact_provider_assignments",
  !/(UPDATE|INSERT INTO|DELETE FROM)\s+contact_provider_assignments/i.test(dbSrc));
ok("  the only form_submissions write is contact_id",
  (dbSrc.match(/UPDATE form_submissions/g) ?? []).length === 1 && dbSrc.includes("SET contact_id = $2"));
ok("  matching.ts performs no I/O at all",
  !/getPool|fetch\(|console\./.test(readFileSync(join(process.cwd(), "server", "survey", "matching.ts"), "utf8")));

console.log("\n[extra] The reason vocabulary is complete and label-covered");
for (const r of [...MATCHED_REASONS, ...REVIEW_REASONS]) {
  ok(`  ${r} has a label`, typeof REASON_LABEL[r] === "string" && REASON_LABEL[r].length > 0);
  ok(`  ${r} has a short label`, typeof REASON_SHORT[r] === "string" && REASON_SHORT[r].length > 0);
  ok(`  ${r} is recognised`, isMatchReason(r));
}
for (const r of REVIEW_REASONS) {
  ok(`  ${r} names a field`, failedFieldFor(r) !== null);
}
ok("a human resolution's sentence passes through unchanged",
  reasonText("Confirmed by staff") === "Confirmed by staff" && !isMatchReason("Confirmed by staff"));
// Sanity on the shared normalisers this build did not change.
eq("canonicalDob still reads M/D/YYYY", canonicalDob("3/14/1988"), "1988-03-14");
eq("nameKey is still order-independent", nameKey("Ashgrove, Rosalind"), nameKey("Rosalind Ashgrove"));
eq("nameKey still folds diacritics", nameKey("Siobhán O'Callaghan"), "ocallaghan siobhan");
eq("emailKey still lowercases", emailKey("  A@B.CO "), "a@b.co");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
