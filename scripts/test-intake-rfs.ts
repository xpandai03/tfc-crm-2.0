/**
 * Self-checks — the Request for Services intake: old shape and new.
 *
 * Run: npx tsx scripts/test-intake-rfs.ts
 *
 * No database, no network. Payloads go through buildIntakeRecord, which is
 * every decision POST /api/intake makes; the route only adds the writes.
 *
 * [1] THE LEGACY REPLAY. scripts/fixtures/intake-legacy.golden.json was captured
 *     from the route's logic BEFORE this change (extracted verbatim, 2026-09-25).
 *     Every legacy fixture must still produce it byte for byte: same rejections,
 *     same stored fields, same timeline note.
 *
 * NO PHI. Every name is ZZTEST-shaped, every email @example.test, every phone
 * a 555 number.
 */
import { readFileSync } from "fs";
import { buildIntakeRecord } from "../server/intake/build-intake";
import { REASON_CANONICALS, bucketReason, normalizeReasonForTherapy } from "../shared/reason-canonicals";
import { SERVICE_TYPES } from "../shared/service-types";
import {
  CHILD_SERVICE_TYPE, bandedServiceType, childDeclaration, storedRequestingFor,
} from "../shared/age-bands";
import { guardiansFromPayload, guardianName, MAX_GUARDIANS } from "../shared/intake-guardians";

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
const NOW = "2026-01-01T00:00:00.000Z";
const build = (b: unknown) => buildIntakeRecord(b, NOW);
const okFields = (b: unknown) => {
  const r = build(b);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.body)}`);
  return r.fields;
};

// ===========================================================================
console.log("\n[1] Legacy payloads are stored exactly as before");
{
  const fixtures = JSON.parse(read("scripts/fixtures/intake-legacy.json"));
  const golden = JSON.parse(read("scripts/fixtures/intake-legacy.golden.json"));
  eq("one golden result per fixture", golden.length, fixtures.length);
  fixtures.forEach((f: { label: string; body: unknown }, i: number) => {
    eq(`unchanged: ${f.label}`, build(f.body), golden[i].result);
  });
  const legacyChild = fixtures.find((f: { label: string }) => f.label.startsWith("legacy My Child"));
  check("a legacy My Child with no guardians is accepted", build(legacyChild.body).ok === true);
  eq("...and stored as My Child", okFields(legacyChild.body).requestingFor, "My Child");
}

// ===========================================================================
console.log("\n[2] The new shape");
const base = {
  name: "Zztest Newshape", email: "zztest.new@example.test", phone: "505-555-0110",
  reasonForTherapy: ["Anxiety", "School Challenges"],
  modalityP1: "Telehealth",
};
{
  // The brief's positive example: adolescent, School Challenges, no guardians.
  const f = okFields({ ...base, requestingFor: "adolescent", guardians: [], patientDob: "2010-05-05" });
  eq("adolescent is stored as the banded service type", f.requestingFor, CHILD_SERVICE_TYPE);
  check("School Challenges is kept", (f.reasonForTherapy ?? "").includes("School Challenges"), f.reasonForTherapy ?? "");
  check("the note records the declaration",
    f.lastNote.includes("Requesting For: My Child (declared: Adolescent)"), f.lastNote);
  check("an empty guardians array adds no note line", !f.lastNote.includes("Guardians"));
  eq("banded from the date of birth", bandedServiceType(f.requestingFor, f.patientDob, "2026-09-25"), "Adolescent");
}
{
  // The brief's edge case: a parent says minor_child, the DOB says adolescent.
  const body = { ...base, requestingFor: "minor_child", patientDob: "2011-03-01" };
  const f = okFields(body);
  eq("minor_child is stored as My Child", f.requestingFor, "My Child");
  eq("the declaration is Minor", childDeclaration(body.requestingFor), "Minor");
  eq("...and the count uses the DOB: Adolescent", bandedServiceType(f.requestingFor, f.patientDob, "2026-09-25"), "Adolescent");
  check("...without any error", build(body).ok === true);
}
{
  const guardians = [
    { firstName: "Zztest", lastName: "Guardianone", phone: "505-555-0111", email: "zztest.g1@example.test", relationship: "Mother" },
    { firstName: "Zztest", lastName: "Guardiantwo", phone: "505-555-0112", email: "", relationship: "Father" },
  ];
  const body = { ...base, requestingFor: "minor_child", custody: "Joint", guardians, patientDob: "2016-07-07" };
  const f = okFields(body);
  check("two guardians are counted in the note", f.lastNote.includes("Guardians: 2"), f.lastNote);
  check("...by count only, no names", !f.lastNote.includes("Guardianone"));
  const g = guardiansFromPayload(body);
  eq("both are read back", g.length, 2);
  eq("with their relationship", g.map((x) => x.relationship), ["Mother", "Father"]);
  eq("and a readable name", guardianName(g[0]), "Zztest Guardianone");
  eq("banded Minor by DOB", bandedServiceType(f.requestingFor, f.patientDob, "2026-09-25"), "Minor");
}
{
  // Lenient: one guardian under joint custody is stored, not rejected.
  const body = { ...base, requestingFor: "minor_child", custody: "Joint",
    guardians: [{ firstName: "Zztest", lastName: "Onlyone", relationship: "Grandparent" }] };
  check("fewer guardians than the form's rule is accepted", build(body).ok === true);
  eq("...and stored", guardiansFromPayload(body).length, 1);
}
{
  const messy = { guardians: ["a string", null, 7, {}, { firstName: "  ", lastName: "" },
    { firstName: " Zztest ", lastName: " Trimmed ", relationship: " Aunt ", extra: "dropped" }] };
  const g = guardiansFromPayload(messy);
  eq("malformed entries and blank rows are skipped", g.length, 1);
  eq("values are trimmed and only the five fields kept", g[0],
    { firstName: "Zztest", lastName: "Trimmed", phone: "", email: "", relationship: "Aunt" });
  eq("a non-array guardians reads as none", guardiansFromPayload({ guardians: "Zztest" }), []);
  eq("no payload reads as none", guardiansFromPayload(null), []);
  check("a malformed guardians field never rejects the intake",
    build({ ...base, requestingFor: "Myself", guardians: "zztest" }).ok === true);
  const many = { guardians: Array.from({ length: 10 }, (_, i) => ({ firstName: `Zz${i}` })) };
  eq("rendering is capped", guardiansFromPayload(many).length, MAX_GUARDIANS);
}
{
  for (const v of ["minor_child", "Minor Child", "minor-child", " MINOR_CHILD "]) {
    eq(`"${v}" declares Minor`, childDeclaration(v), "Minor");
  }
  for (const v of ["adolescent", "Adolescent"]) eq(`"${v}" declares Adolescent`, childDeclaration(v), "Adolescent");
  for (const v of ["My Child", "My child", "Myself", "My Family", "", null, 3]) {
    eq(`${JSON.stringify(v)} is not a declaration`, childDeclaration(v), null);
  }
  eq("legacy values are stored verbatim", ["My Child", "My child", "My-Child", " Myself "].map(storedRequestingFor),
    ["My Child", "My child", "My-Child", "Myself"]);
  eq("absent is null", storedRequestingFor(undefined), null);
  check("the declaration never becomes a new service type",
    !(SERVICE_TYPES as readonly string[]).some((t) => /minor|adolescent/i.test(t)));
}

// ===========================================================================
console.log("\n[3] School Challenges, at the one source and everywhere it is read");
{
  check("in the canonical list", (REASON_CANONICALS as readonly string[]).includes("School Challenges"));
  eq("sorted with its neighbours", REASON_CANONICALS.indexOf("School Challenges" as never),
    REASON_CANONICALS.indexOf("Relationship Issues" as never) + 1);
  eq("buckets as itself in Insights, not as Other", bucketReason("School Challenges"), "School Challenges");
  eq("normalises from the website form", normalizeReasonForTherapy(["School Challenges"]).unknown, []);
  const wrongCase = build({ ...base, requestingFor: "Myself", reasonForTherapy: ["school challenges"] });
  check("the casing is exact: a lower-case copy from the website is still rejected", wrongCase.ok === false);
  check("the waitlist filter reads the canonical list",
    /reason: \[\.\.\.REASON_CANONICALS\]/.test(read("client/src/pages/waitlist.tsx")));
  check("the staff review form reads the canonical list",
    /from "@shared\/reason-canonicals"/.test(read("client/src/components/referral/review-form.tsx")));
  check("Insights buckets through bucketReason",
    /bucketReason\(reason\)/.test(read("client/src/pages/insights.tsx")));
  // No surface keeps its own copy of the list.
  for (const f of ["client/src/pages/insights.tsx", "client/src/pages/waitlist.tsx",
    "client/src/components/referral/review-form.tsx", "server/dashboard/db.ts", "server/dashboard/export.ts",
    "client/src/components/report-builder-modal.tsx", "server/routes.ts"]) {
    check(`${f} holds no copy of the reason list`, !/"Grief\/Loss"/.test(read(f)));
  }
}

// ===========================================================================
console.log("\n[4] The contact page");
{
  const page = read("client/src/pages/contact-detail.tsx");
  check("guardians are read through the shared reader", /guardiansFromPayload\(p\)/.test(page));
  check("...shown with their relationship", /\["Relationship", g\.relationship\]/.test(page));
  check("...after the Participants block, apart from it",
    page.indexOf(">Participants<") < page.indexOf("Guardians ({guardians.length})"));
  check("the declaration is shown beside the band, not instead of it",
    /data-testid="text-requestingFor-banded"/.test(page) && /data-testid="text-requestingFor-declared"/.test(page));
  check("the band still comes from bandedServiceType", /bandedServiceType\(contact\.requestingFor, contact\.patientDob\)/.test(page));
}

// ===========================================================================
console.log("\n[5] The route delegates every decision");
{
  const routes = read("server/routes.ts");
  const route = routes.slice(routes.indexOf('app.post("/api/intake"'), routes.indexOf("// Sync API (n8n"));
  check("it calls buildIntakeRecord", /buildIntakeRecord\(b, now\)/.test(route));
  check("it stores the raw body unchanged, guardians included", /payload: b,/.test(route));
  check("it writes the built fields", /\.\.\.fields,/.test(route));
  check("no validation is left inline", !/normalizeReasonForTherapy|MODALITIES/.test(route));
}

// ===========================================================================
console.log("\n[6] Fixtures carry no real identity");
{
  const blob = read("scripts/fixtures/intake-legacy.json") + read("scripts/test-intake-rfs.ts");
  const emails = blob.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
  check("every email is @example.test", emails.every((e) => e.endsWith("@example.test")), emails.join(", "));
  const fx = JSON.parse(read("scripts/fixtures/intake-legacy.json")) as Array<{ body: { name: string } }>;
  check("every fixture name is ZZTEST-shaped", fx.every((f) => !f.body.name.trim() || /^Zztest /.test(f.body.name)));
}

console.log(`\n${"=".repeat(62)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
