/**
 * Canonical insurance payers (client-issued list, 2026-08-14).
 *
 * THE SELECTION LIST. Every place a human PICKS a payer offers exactly these 16
 * and nothing else: the waitlist filter, the contact-card payer dropdown, the
 * staff referral review form, and the provider accepted-insurances picker.
 *
 * RETIRED-FROM-SELECTION, RETAINED-FOR-DISPLAY (2026-08-14): the client retired
 * "Tricare" (dropped 2026-08-13, no longer accepted) and anything EAP-related.
 * Those, and the ~114 other nonconforming strings already in the data, are
 * LEGACY: a record holding one keeps showing it, but it can never be chosen
 * again. Retiring a value is a display/selection concern and NEVER rewrites
 * stored data — remapping legacy payers to canonical ones is the client's data
 * decision, not the code's.
 *
 * ============================================================================
 * WHY THIS IS A SEPARATE MODULE FROM shared/insurance-utils.ts
 * ============================================================================
 * insurance-utils.ts owns normalizeInsurance() + ACCEPTED_INSURANCES, which are
 * a *bucketing* system: they squash ~125 raw strings into broad categories for
 * REPORTING (Insights, referral reports, the agent enum) and for CLINICAL
 * PROVIDER MATCHING (provider-matching, provider-matching-v2, reverse-matching).
 * Those two concerns have different requirements from a selection list — they
 * must keep resolving legacy strings, and their category set is deliberately
 * wider and fuzzier.
 *
 * Repointing ACCEPTED_INSURANCES at this list would silently change reporting
 * semantics and provider matching, both explicitly out of scope. So this module
 * is additive and insurance-utils.ts is untouched — the same acceptance-vs-offer
 * split as MODALITIES vs MODALITY_OPTIONS in modality-utils.ts.
 */

/**
 * The 16 selectable payers, verbatim from the client. Stored and exported in
 * FULL — abbreviations below are a rendering concern only.
 *
 * "Unknown" is a real, selectable choice here (staff genuinely don't always
 * know), unlike the residual "Unknown" bucket in insurance-utils.
 */
export const CANONICAL_INSURANCES = [
  "Aetna",
  "BlueCross BlueShield Commercial",
  "BlueCross BlueShield Turquoise Care",
  "ChampVA",
  "ComPsych",
  "Medicaid",
  "Medicare",
  "Molina Commercial",
  "Molina Turquoise Care",
  "Presbyterian Commercial",
  "Presbyterian Turquoise Care",
  "Self-Pay",
  "UHC Commercial",
  "UHC Turquoise Care",
  "Unknown",
  "VACCN",
] as const;

export type CanonicalInsurance = typeof CANONICAL_INSURANCES[number];

/**
 * Short forms for dense UI (the waitlist column). Only the long names appear
 * here; anything absent is already short enough to render in full.
 *
 * NEVER used in exports or on the contact card — a CSV has no width constraint
 * and abbreviating there loses information.
 */
export const INSURANCE_ABBREVIATIONS: Record<string, string> = {
  "BlueCross BlueShield Commercial": "BCBS Com",
  "BlueCross BlueShield Turquoise Care": "BCBS TC",
  "Molina Commercial": "Molina Com",
  "Molina Turquoise Care": "Molina TC",
  "Presbyterian Commercial": "Pres Com",
  "Presbyterian Turquoise Care": "Pres TC",
  "UHC Commercial": "UHC Com",
  "UHC Turquoise Care": "UHC TC",
};

/** Compact label for the list column; falls back to the value itself. */
export function abbreviateInsurance(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  return INSURANCE_ABBREVIATIONS[v] ?? v;
}

/** Is this exactly one of the 16 selectable payers? */
export function isCanonicalInsurance(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return !!v && (CANONICAL_INSURANCES as readonly string[]).includes(v);
}

/** A stored value that is not selectable — shown, never offered. */
export function isLegacyInsurance(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return !!v && !isCanonicalInsurance(v);
}

/**
 * THE filter predicate. Matches the record's stored payer EXACTLY against a
 * canonical value — no normalization, no fuzzy mapping.
 *
 * Consequence, and it is intentional: a record holding a legacy string
 * ("United Healthcare", "VACCN (VA Community Care)", "BCBS") matches no
 * specific filter and is reachable only under "All Insurances". Mapping those
 * to canonical values is a data decision for the client; doing it here would
 * hide the mess the distinct-value report exists to surface.
 *
 * The waitlist list view and the server-side export predicate both call this,
 * so an export can never disagree with the view it reproduces.
 */
export function matchesInsurance(
  storedValue: string | null | undefined,
  canonicalFilter: string,
): boolean {
  return (storedValue ?? "").trim() === canonicalFilter;
}
