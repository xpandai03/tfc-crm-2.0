/**
 * insurance-utils tests (run: `npm run test:insurance`)
 *
 * No framework — plain tsx + node:assert. Exits non-zero on any failure so it can
 * gate CI / a pre-deploy check. Two suites:
 *   1) IDEMPOTENCY — every canonical ACCEPTED_INSURANCES value must normalize to
 *      itself. This is the highest-ROI invariant: the normalizer failing to
 *      recognize its own output ("BlueCross BlueShield Commercial") is exactly why
 *      104 live contacts were Unknown.
 *   2) SNAPSHOT — locks the measured blast radius: the changed classes map to their
 *      corrected category, the BCBS+Turquoise qualifier works both directions,
 *      known-good values do NOT regress, and excluded/niche values stay Unknown.
 */
import assert from "node:assert";
import { normalizeInsurance, ACCEPTED_INSURANCES } from "./insurance-utils";

const failures: string[] = [];
function expect(input: string, expected: string) {
  const actual = normalizeInsurance(input);
  if (actual !== expected) failures.push(`normalizeInsurance(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ---- 1) IDEMPOTENCY: every canonical output round-trips to itself ----
for (const canonical of ACCEPTED_INSURANCES) {
  expect(canonical, canonical);
}

// ---- 2) SNAPSHOT of the measured blast radius ----
// (a) Fixed this change — canonical BCBS Commercial + Pres/typo abbreviations:
expect("BlueCross BlueShield Commercial", "BlueCross BlueShield Commercial"); // 104 contacts: was Unknown
expect("BlueCross BlueShiled", "BlueCross BlueShield Commercial");            // typo
expect("Pres Cent", "Presbyterian Turquoise Care");                          // Centennial = Medicaid managed care
expect("Presbyterian - Cent", "Presbyterian Turquoise Care");
expect("Pres Comm", "Presbyterian Commercial");
expect("Pres Commerical", "Presbyterian Commercial");                         // typo

// (b) BCBS + Turquoise qualifier — both directions resolve to the BCBS variant:
expect("BlueCross BlueShield Turquoise Care", "BlueCross BlueShield Turquoise Care"); // canonical (exact key)
expect("BCBS Turquoise", "BlueCross BlueShield Turquoise Care");              // bare, no "Care" → qualifier rule (NOT Commercial)
expect("Blue Cross Blue Shield Turquoise", "BlueCross BlueShield Turquoise Care");

// (c) Regression guards — known-good values must NOT change:
expect("BCBS", "BlueCross BlueShield Commercial");
expect("VACCN", "VACCN");
expect("VACCN (VA Community Care)", "VACCN");
expect("United Healthcare", "UHC Commercial");
expect("Aetna", "Aetna");
expect("Medicare", "Medicare");
expect("Presbyterian", "Presbyterian Commercial");
expect("Presbyterian Turquoise Care", "Presbyterian Turquoise Care");        // turquoise + NO bcbs → stays Presbyterian
expect("Magellan Turquoise Care", "Presbyterian Turquoise Care");            // turquoise + NO bcbs → stays Presbyterian
expect("Tricare West", "Tricare");

// (d) Excluded / niche — must stay Unknown (VA pending human decision; Other/Cigna not accepted):
expect("VA", "Unknown");
expect("Veterans Affairs", "Unknown");
expect("Other (please specify)", "Unknown");
expect("Cigna", "Unknown");
expect("Medicare AMB", "Unknown"); // explicitly Not Accepted

if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} insurance normalization assertion(s) failed:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`PASS — insurance-utils: ${ACCEPTED_INSURANCES.length} idempotency + snapshot assertions OK`);
assert.ok(true);
