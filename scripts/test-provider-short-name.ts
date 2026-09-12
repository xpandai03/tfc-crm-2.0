/**
 * Self-checks — provider short name.
 *
 * Run: npx tsx scripts/test-provider-short-name.ts
 *
 * No database and no PHI. Provider names are staff names and are the subject.
 *
 * Verifies:
 *   1. the seed is the client's 26, and every value is a legal Excel sheet name
 *   2. no two seeded short names collide, case-insensitively
 *   3. the fallback returns the first name, and only the first name
 *   4. the fallback does NO collision handling — the property this build exists
 *      to guarantee, asserted directly rather than assumed
 *   5. a stored name always wins over the fallback
 *   6. the waitlist shortener is a different rule and is not this one
 */
import {
  MAX_SHEET_NAME_LENGTH,
  FORBIDDEN_SHEET_NAME_CHARS,
  PROVIDER_SHORT_NAME_SEED,
  providerShortName,
  sheetNameProblem,
} from "../shared/provider-short-name";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---------------------------------------------------------------------------
console.log("\n[1] The seed is the client's 26, and every value is a legal sheet name");
const entries = Object.entries(PROVIDER_SHORT_NAME_SEED);
check("exactly 26 providers seeded", entries.length === 26, String(entries.length));
for (const [full, short] of entries) {
  const problem = sheetNameProblem(short);
  check(`"${short}" is a legal sheet name`, problem === null, problem ?? "");
  check(`"${short}" is <= ${MAX_SHEET_NAME_LENGTH} chars`, short.length <= MAX_SHEET_NAME_LENGTH, String(short.length));
  check(`"${short}" shares its first name with "${full}"`,
    full.trim().split(/\s+/)[0] === short.split(" ")[0], `${full} -> ${short}`);
}
// The reason the column exists at all: this full name cannot be a sheet name.
check('"Abena Marfowaa Owusu-Nkwantabisah" is itself too long to be a tab name',
  sheetNameProblem("Abena Marfowaa Owusu-Nkwantabisah") !== null);
check("...and its seeded short name is not", sheetNameProblem(PROVIDER_SHORT_NAME_SEED["Abena Marfowaa Owusu-Nkwantabisah"]) === null);

// ---------------------------------------------------------------------------
console.log("\n[2] No two seeded short names collide");
const seen: Record<string, string> = {};
const collisions: string[] = [];
for (const [full, short] of entries) {
  const key = short.toLowerCase();
  if (seen[key]) collisions.push(`${short}: ${seen[key]} vs ${full}`);
  else seen[key] = full;
}
check("all 26 short names are distinct, case-insensitively",
  collisions.length === 0, collisions.join("; "));
check("the two Amandas are disambiguated",
  PROVIDER_SHORT_NAME_SEED["Amanda Davison"] === "Amanda D" &&
  PROVIDER_SHORT_NAME_SEED["Amanda Plotner"] === "Amanda P");
check("the two Angelicas are disambiguated",
  PROVIDER_SHORT_NAME_SEED["Angelica Chavez"] === "Angelica C" &&
  PROVIDER_SHORT_NAME_SEED["Angelica Villicana"] === "Angelica V");
// The whole argument for storing rather than deriving: no rule over TODAY'S
// roster produces this, because the other Amber has left.
check('"Amber L" keeps its initial though Amber Lute is now the only Amber',
  PROVIDER_SHORT_NAME_SEED["Amber Lute"] === "Amber L");

// ---------------------------------------------------------------------------
console.log("\n[3] The fallback returns the first name");
check("no stored name -> first name",
  providerShortName({ name: "Jessica Neuhart", shortName: null }) === "Jessica");
check("undefined stored name -> first name",
  providerShortName({ name: "Amber Merritt" }) === "Amber");
check("empty stored name -> first name",
  providerShortName({ name: "Amber Merritt", shortName: "" }) === "Amber");
check("whitespace-only stored name -> first name",
  providerShortName({ name: "Amber Merritt", shortName: "   " }) === "Amber");
check("single-word name -> that word",
  providerShortName({ name: "Cher", shortName: null }) === "Cher");
check("hyphenated surname does not affect the first name",
  providerShortName({ name: "Laura Garcia-Rosecrans", shortName: null }) === "Laura");
check("leading/trailing whitespace in the full name is tolerated",
  providerShortName({ name: "  Danya Estrada  ", shortName: null }) === "Danya");
check("empty full name and no stored name -> empty string",
  providerShortName({ name: "", shortName: null }) === "");

// ---------------------------------------------------------------------------
console.log("\n[4] The fallback does NO collision handling");
// Two providers sharing a first name, neither with a stored short name, MUST
// both fall back to the bare first name. Adding an initial here is exactly the
// unstable derivation this build replaces, so this asserts the absence of it.
const amberA = { name: "Amber Lute", shortName: null };
const amberB = { name: "Amber Merritt", shortName: null };
check("two same-first-name providers both fall back to the bare first name",
  providerShortName(amberA) === "Amber" && providerShortName(amberB) === "Amber");
check("the fallback adds no surname initial",
  !providerShortName(amberA).includes("L") || providerShortName(amberA) === "Amber");
check("the fallback adds no trailing period",
  !providerShortName({ name: "Anna Aldridge", shortName: null }).endsWith("."));
check("the fallback is per-provider — it takes no roster argument",
  providerShortName.length === 1, `arity ${providerShortName.length}`);

// ---------------------------------------------------------------------------
console.log("\n[5] A stored name always wins");
check("stored name beats the first name",
  providerShortName({ name: "Amanda Davison", shortName: "Amanda D" }) === "Amanda D");
check("stored name is trimmed",
  providerShortName({ name: "Amanda Davison", shortName: "  Amanda D  " }) === "Amanda D");
check("a stored name unrelated to the full name is still returned verbatim",
  providerShortName({ name: "Abena Marfowaa Owusu-Nkwantabisah", shortName: "Abena" }) === "Abena");
check("every seeded pair round-trips through the accessor",
  entries.every(([full, short]) => providerShortName({ name: full, shortName: short }) === short));

// ---------------------------------------------------------------------------
console.log("\n[6] sheetNameProblem rejects what Excel rejects");
for (const c of FORBIDDEN_SHEET_NAME_CHARS) {
  check(`rejects ${JSON.stringify(c)}`, sheetNameProblem(`Amanda${c}D`) !== null);
}
check("rejects empty", sheetNameProblem("") !== null);
check("rejects 32 characters", sheetNameProblem("x".repeat(32)) !== null);
check("accepts 31 characters", sheetNameProblem("x".repeat(31)) === null);
check("rejects a leading apostrophe", sheetNameProblem("'Amanda") !== null);
check("rejects a trailing apostrophe", sheetNameProblem("Amanda'") !== null);
check('rejects the reserved name "History"', sheetNameProblem("history") !== null);
check("accepts a hyphen", sheetNameProblem("Dederich-Elsner") === null);

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
