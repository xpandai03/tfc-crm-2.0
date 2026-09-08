/**
 * Canonical insurance regression tests — `npm run test:insurance-canonical`.
 *
 * Guards the SELECTION list and the filter predicate. The older
 * client/src/lib/insurance-utils.test.ts still guards normalizeInsurance, which
 * this batch deliberately left alone (it powers reporting + provider matching).
 * Both suites must pass: that pairing is what proves the offer list changed
 * without reporting semantics moving.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  CANONICAL_INSURANCES,
  INSURANCE_ABBREVIATIONS,
  abbreviateInsurance,
  isCanonicalInsurance,
  isLegacyInsurance,
  matchesInsurance,
} from "../shared/insurance";
import { ACCEPTED_INSURANCES } from "../shared/insurance-utils";

let fails = 0;
const eq = (l: string, a: unknown, e: unknown) => {
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    console.error(`FAIL ${l}\n  expected ${JSON.stringify(e)}\n  actual   ${JSON.stringify(a)}`); fails++;
  }
};
const ok = (l: string, c: boolean) => { if (!c) { console.error(`FAIL ${l}`); fails++; } };

// ---- the list, verbatim from the client ------------------------------------
// 16 on 2026-08-14; "Curative" (commercial) added 2026-09-08 -> 17.
eq("exactly 17 selectable payers", CANONICAL_INSURANCES.length, 17);
eq("list matches the client's canonical set", [...CANONICAL_INSURANCES], [
  "Aetna", "BlueCross BlueShield Commercial", "BlueCross BlueShield Turquoise Care",
  "ChampVA", "ComPsych", "Curative", "Medicaid", "Medicare", "Molina Commercial",
  "Molina Turquoise Care", "Presbyterian Commercial", "Presbyterian Turquoise Care",
  "Self-Pay", "UHC Commercial", "UHC Turquoise Care", "Unknown", "VACCN",
]);
// Curative is selectable, and is NOT abbreviated (short enough to render whole).
ok("Curative is selectable", isCanonicalInsurance("Curative"));
ok("Curative is not legacy", !isLegacyInsurance("Curative"));
eq("Curative renders in full", abbreviateInsurance("Curative"), "Curative");
ok("Curative matches itself exactly", matchesInsurance("Curative", "Curative"));
ok("a Curative-like stray does NOT match", !matchesInsurance("Curative Health", "Curative"));

// ---- retired values are NOT selectable --------------------------------------
for (const retired of ["Tricare", "Tricare West", "EAP", "UHC Centennial", "Molina",
                       "Self-Pay (Cash / Out-of-Pocket)", "Carelon", "Partners Direct Health",
                       "Health Smart", "United Healthcare", "BCBS"]) {
  ok(`${retired} is NOT selectable`, !isCanonicalInsurance(retired));
  ok(`${retired} is treated as legacy`, isLegacyInsurance(retired));
}

// ---- abbreviations ----------------------------------------------------------
eq("BCBS Commercial abbreviates", abbreviateInsurance("BlueCross BlueShield Commercial"), "BCBS Com");
eq("BCBS Turquoise abbreviates", abbreviateInsurance("BlueCross BlueShield Turquoise Care"), "BCBS TC");
eq("Molina Com abbreviates", abbreviateInsurance("Molina Commercial"), "Molina Com");
eq("Molina TC abbreviates", abbreviateInsurance("Molina Turquoise Care"), "Molina TC");
eq("Pres Com abbreviates", abbreviateInsurance("Presbyterian Commercial"), "Pres Com");
eq("Pres TC abbreviates", abbreviateInsurance("Presbyterian Turquoise Care"), "Pres TC");
eq("UHC Com abbreviates", abbreviateInsurance("UHC Commercial"), "UHC Com");
eq("UHC TC abbreviates", abbreviateInsurance("UHC Turquoise Care"), "UHC TC");
// Short names pass through untouched.
for (const short of ["Aetna", "ChampVA", "ComPsych", "Medicaid", "Medicare", "Self-Pay", "Unknown", "VACCN"]) {
  eq(`${short} renders in full`, abbreviateInsurance(short), short);
}
// A legacy value renders as itself — never blank, never guessed at.
eq("legacy renders as stored", abbreviateInsurance("United Healthcare"), "United Healthcare");
eq("blank renders blank", abbreviateInsurance(null), "");
// Every abbreviation key must be a canonical value, or the column would map a
// value the filter can't offer.
for (const k of Object.keys(INSURANCE_ABBREVIATIONS)) {
  ok(`abbreviation key "${k}" is canonical`, isCanonicalInsurance(k));
}

// ---- the filter predicate: EXACT, never normalized ---------------------------
ok("exact canonical matches", matchesInsurance("Presbyterian Turquoise Care", "Presbyterian Turquoise Care"));
ok("whitespace is tolerated", matchesInsurance("  Medicaid  ", "Medicaid"));
ok("a legacy synonym does NOT match", !matchesInsurance("United Healthcare", "UHC Commercial"));
ok("a legacy abbreviation does NOT match", !matchesInsurance("BCBS", "BlueCross BlueShield Commercial"));
ok("a parenthetical variant does NOT match", !matchesInsurance("VACCN (VA Community Care)", "VACCN"));
ok("a retired value does NOT match anything canonical",
   CANONICAL_INSURANCES.every((c) => !matchesInsurance("Tricare", c)));
ok("null matches nothing", CANONICAL_INSURANCES.every((c) => !matchesInsurance(null, c)));
// The abbreviation is a rendering concern only — never a filter value.
ok("abbreviations are not matchable", !matchesInsurance("BCBS TC", "BlueCross BlueShield Turquoise Care"));

// ---- scope guards: reporting + matching must NOT have been repointed ---------
// This used to assert a fixed length (18). A COUNT can't tell a repoint apart
// from a legitimate addition, and it broke the moment the client added a payer.
// Assert the invariant it was actually protecting instead: the reporting list is
// a DIFFERENT set from the selection list, and it still carries every value that
// was retired from selection, so historical records stay reportable.
const acceptedSet = new Set<string>(ACCEPTED_INSURANCES as readonly string[]);
for (const retained of ["Tricare", "UHC Centennial", "Molina", "Carelon",
                        "Partners Direct Health", "Health Smart"]) {
  ok(`ACCEPTED_INSURANCES still carries ${retained} (legacy records stay reportable)`,
     acceptedSet.has(retained));
}
ok("ACCEPTED_INSURANCES was not repointed at CANONICAL_INSURANCES",
   CANONICAL_INSURANCES.some((c) => !acceptedSet.has(c)));
// A payer the client adds belongs in BOTH lists: selection AND reporting/matching.
ok("Curative is in the reporting/matching list too", acceptedSet.has("Curative"));

const dbSrc = readFileSync(join(process.cwd(), "server", "sync", "db.ts"), "utf8");
// The export predicate must use the shared canonical matcher...
ok("export predicate uses matchesInsurance", /matchesInsurance\(\s*r\.insurance_payer/.test(dbSrc));
// ...while the referral report keeps normalizeInsurance (reporting unchanged).
ok("referral report still uses normalizeInsurance", /normalizeInsurance\(insuranceRaw\)/.test(dbSrc));

// insurance_payer is intake-sourced, NOT CRM-owned: the sync must still own it.
ok("sync upserts still write insurance_payer (not CRM-owned)",
   /insurance_payer = EXCLUDED\.insurance_payer/.test(dbSrc));

if (fails === 0) console.log(`PASS — canonical insurance: ${CANONICAL_INSURANCES.length} options, abbreviations, exact-match filter, scope guards OK`);
else { console.error(`\n${fails} FAILURES`); process.exit(1); }
