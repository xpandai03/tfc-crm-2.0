/**
 * Insurance Utilities
 *
 * Shared insurance normalization utilities used by:
 * - insights.tsx (for aggregation/display)
 * - provider-matching.ts (for matching algorithm)
 * - provider-api.ts (for parsing provider accepted insurances)
 */

/**
 * TFC Clinic-Level Accepted Insurances (v1)
 *
 * This is the authoritative list of insurances accepted by TFC as a clinic.
 * Used as a fallback when per-provider insurance data is not available.
 *
 * TODO: Remove this clinic-level fallback once Column 30 (Accepted Insurances)
 * is populated per provider in the Provider Skills Spreadsheet.
 *
 * Source: TFC insurance acceptance list (screenshot provided Jan 2026)
 */
export const TFC_ACCEPTED_INSURANCES_RAW = [
  "Aetna",
  "Blue Cross Blue Shield",
  "Magellan",
  "Medicaid",
  "Medicare",
  "Molina Healthcare",
  "Presbyterian Health Plan",
  "Presbyterian Turquoise Care",
  "BlueCross BlueShield Turquoise Care",
  "Tricare",
  "United Health Care",
  "United Behavioral Health",
  "UMR",
  "Health Smart",
  "Highmark",
  "Carelon",
  "ChampVA",
  "VACCN",
  "Meritain Health",
  "Optum Health",
  "Partners Direct Health",
  "United Health Shared Services (UHC GEHA)",
  "UHC Centennial",
  "ComPsych",
  "Self-Pay (Cash / Out-of-Pocket)",
] as const;

/**
 * Insurance normalization mapping (raw values → canonical categories)
 * Based on Dawn's insurance categorization document
 * Maps multiple raw variants to a single canonical category
 */
export const INSURANCE_NORMALIZATION_MAP: Record<string, string> = {
  // 1. VACCN (VA Community Care Network)
  "vaccn": "VACCN",
  "va community care": "VACCN",
  "vapc3": "VACCN",
  "va ccn": "VACCN",

  // 2. ChampVA (distinct from VACCN)
  "champva": "ChampVA",
  "champ va": "ChampVA",

  // 2. Presbyterian Commercial / Magellan
  "presbyterian": "Presbyterian Commercial",
  "magellan": "Presbyterian Commercial",
  "presbyterian aps": "Presbyterian Commercial",
  "pres commercial": "Presbyterian Commercial",
  "pres": "Presbyterian Commercial",
  "presbyterian health plan": "Presbyterian Commercial",
  "pres comm": "Presbyterian Commercial", // abbreviation (item 3)
  "pres commerical": "Presbyterian Commercial", // typo handling (item 3)

  // 3. BlueCross BlueShield Commercial / Highmark
  "bcbs of nm": "BlueCross BlueShield Commercial",
  "bcbs": "BlueCross BlueShield Commercial",
  "blue cross blue shield": "BlueCross BlueShield Commercial",
  "bcbs comm": "BlueCross BlueShield Commercial",
  "highmark blue cross blue shield": "BlueCross BlueShield Commercial",
  "highmark": "BlueCross BlueShield Commercial",
  "bluegrass blueshield": "BlueCross BlueShield Commercial",
  "bcbs of new mexico": "BlueCross BlueShield Commercial",
  "bluecross blueshield of new mexico": "BlueCross BlueShield Commercial",
  "blue cross blue sheild": "BlueCross BlueShield Commercial", // typo handling
  "blue cross": "BlueCross BlueShield Commercial",
  "blue cross blueshield": "BlueCross BlueShield Commercial",
  "blue cross blue shield of minnesota": "BlueCross BlueShield Commercial",
  "blue cross blue shield nm": "BlueCross BlueShield Commercial",
  "bcbs of texas": "BlueCross BlueShield Commercial",
  "blue cross blue shield fep": "BlueCross BlueShield Commercial",
  "bcbsnm": "BlueCross BlueShield Commercial",
  "bcbs nm": "BlueCross BlueShield Commercial",
  // Canonical round-trip (item 1): the normalizer must recognize its own output.
  // "BlueCross BlueShield Commercial" lowercases to "bluecross..." (no space), so
  // the space-required "blue cross" keyword and the "bcbs" keyword both miss it —
  // without this exact key it fell through to Unknown (104 live contacts).
  "bluecross blueshield commercial": "BlueCross BlueShield Commercial",
  "blue cross blue shiled": "BlueCross BlueShield Commercial", // typo handling
  "bluecross blueshiled": "BlueCross BlueShield Commercial", // typo handling

  // 4. Tricare
  "tricare": "Tricare",
  "tricare west": "Tricare",
  "tricare select": "Tricare",
  "tricare west prime": "Tricare",
  "tri care": "Tricare",
  "triwest": "Tricare",
  "tricare prime or triwest": "Tricare",

  // 5. Presbyterian Turquoise Care (Medicaid managed care)
  "pres tc": "Presbyterian Turquoise Care",
  "presbyterian - turquoise care": "Presbyterian Turquoise Care",
  "pres turquoise": "Presbyterian Turquoise Care",
  "presbyterian turquoise care": "Presbyterian Turquoise Care",
  "presbyterian turquoise": "Presbyterian Turquoise Care",
  "magellan turquoise care": "Presbyterian Turquoise Care",
  "pres cent - turquoise": "Presbyterian Turquoise Care",
  "turquoise care presbyterian": "Presbyterian Turquoise Care",
  "truq care presbyterian health plan": "Presbyterian Turquoise Care",
  "presbyterian centennial": "Presbyterian Turquoise Care",
  // Abbreviations (item 3): "Centennial" is NM Medicaid managed care = Turquoise
  // Care (same convention as "presbyterian centennial" above).
  "pres cent": "Presbyterian Turquoise Care",
  "presbyterian - cent": "Presbyterian Turquoise Care",

  // 6. BlueCross BlueShield Turquoise Care (Medicaid managed care)
  // Canonical-form self-map so this category round-trips through
  // normalizeInsurance() (required for getTFCAcceptedInsurances() to surface
  // it, since the raw clinic list now includes it).
  "bluecross blueshield turquoise care": "BlueCross BlueShield Turquoise Care",
  "bcbs cent": "BlueCross BlueShield Turquoise Care",
  "bcbs - turquoise care": "BlueCross BlueShield Turquoise Care",
  "bcbs turquoise care": "BlueCross BlueShield Turquoise Care",
  "blue cross blue shield - turquoise care": "BlueCross BlueShield Turquoise Care",
  "blue cross blue shield turquoise": "BlueCross BlueShield Turquoise Care",
  "bcbs tc": "BlueCross BlueShield Turquoise Care",
  "bcbs centenial": "BlueCross BlueShield Turquoise Care", // typo handling
  "bcbs turquioise": "BlueCross BlueShield Turquoise Care", // typo handling

  // 7. UHC Commercial (United Healthcare / UBH / Optum / UMR)
  "united healthcare": "UHC Commercial",
  "united health care": "UHC Commercial",
  "uhc": "UHC Commercial",
  "uhc commercial": "UHC Commercial",
  "united healrhcare": "UHC Commercial", // typo handling
  "united behavioral health": "UHC Commercial",
  "ubh": "UHC Commercial",
  "optum": "UHC Commercial",
  "optum health": "UHC Commercial",
  "united health shared services": "UHC Commercial",
  "uhc geha": "UHC Commercial",
  "united health shared services (uhc geha)": "UHC Commercial",

  // 7b. UHC Centennial (Medicaid managed care via UHC)
  "uhc centennial": "UHC Centennial",
  "uhc cent": "UHC Centennial",
  "uhc/umr centennial": "UHC Centennial",
  "uhc/umr ce": "UHC Centennial",
  "united healthcare centennial": "UHC Centennial",
  "uhc medicaid": "UHC Centennial",

  // 8. Aetna / Meritain Health (Aetna subsidiary)
  "atena": "Aetna", // typo handling
  "aetna": "Aetna",
  "meritain": "Aetna",
  "meritain health": "Aetna",

  // 9. Medicare
  "medicare": "Medicare",
  "blue cross blue shield medicare": "Medicare",
  "uhc medicare": "Medicare",
  "bcbs medicare advantage": "Medicare",

  // 10. UMR (merged into UHC Commercial)
  "umr": "UHC Commercial",
  "umr - secondy medicaid -": "UHC Commercial",

  // 11. Molina
  "molina": "Molina",
  "molina healthcare": "Molina",

  // 12. Medicaid
  "turquoise care native american": "Medicaid",
  "medicaid": "Medicaid",

  // 13. Self-Pay
  "self-pay": "Self-Pay",
  "self pay": "Self-Pay",
  "selfpay": "Self-Pay",

  // 14. ComPsych
  "compsych": "ComPsych",

  // 15. Health Smart
  "health smart": "Health Smart",
  "healthsmart": "Health Smart",

  // 16. Carelon (formerly Carleon Health Options)
  "carelon": "Carelon",
  "carleon": "Carelon",
  "carleon health options": "Carelon",
  "carelon health options": "Carelon",

  // 17. Partners Direct Health
  "partners direct": "Partners Direct Health",
  "partners direct health": "Partners Direct Health",

  // Rejected insurances (not accepted by TFC)
  "healthscope": "Not Accepted",
  "healthscope benefits": "Not Accepted",
  "healthscope benifits quantum health": "Not Accepted",
  "lisa hale": "Not Accepted",
  "humana medicare": "Not Accepted",
  "medicare amb": "Not Accepted",
  "humana": "Not Accepted",
};

/**
 * Canonical list of accepted insurances
 * These are the normalized category names used throughout the system
 */
export const ACCEPTED_INSURANCES = [
  "VACCN",
  "ChampVA",
  "Presbyterian Commercial",
  "BlueCross BlueShield Commercial",
  "Tricare",
  "Presbyterian Turquoise Care",
  "BlueCross BlueShield Turquoise Care",
  "UHC Commercial",
  "UHC Centennial",
  "Aetna",
  "Medicare",
  "Molina",
  "Medicaid",
  "Self-Pay",
  "ComPsych",
  "Health Smart",
  "Carelon",
  "Partners Direct Health",
] as const;

export type InsuranceCategory = typeof ACCEPTED_INSURANCES[number] | "Unknown";

/**
 * Normalize insurance payer name to canonical category
 * Pure function: no side effects, deterministic
 * Returns "Unknown" for unmapped values
 *
 * Handles various input formats:
 * - Exact matches: "BCBS", "Medicare"
 * - With parenthetical notes: "VACCN (VA Community Care)"
 * - Partial matches: tries to find a keyword match
 */
export function normalizeInsurance(rawValue: string | null | undefined): InsuranceCategory {
  if (!rawValue) return "Unknown";
  const trimmed = rawValue.trim();
  if (!trimmed) return "Unknown";
  const normalized = trimmed.toLowerCase();

  // First try exact match
  let mapped = INSURANCE_NORMALIZATION_MAP[normalized];

  // If no exact match, try stripping parenthetical content: "VACCN (VA Community Care)" → "vaccn"
  if (!mapped && normalized.includes("(")) {
    const withoutParens = normalized.replace(/\s*\([^)]*\)\s*/g, "").trim();
    mapped = INSURANCE_NORMALIZATION_MAP[withoutParens];
  }

  // Qualifier-aware BCBS Turquoise Care (item 2): a string carrying BOTH a BCBS
  // signal (bcbs / blue cross / bluecross — including the concatenated canonical
  // form) AND "turquoise" must map to the BCBS Turquoise variant, NOT Presbyterian.
  // This MUST run before the keyword loop below, whose unconditional
  // "turquoise care" rule maps to Presbyterian and whose "bcbs"/"blue cross" rules
  // map to Commercial — either of which would mis-bucket "BCBS Turquoise" strings
  // that aren't covered by an exact key (e.g. bare "BCBS Turquoise" without "Care").
  if (!mapped) {
    const hasBcbsSignal =
      normalized.includes("bcbs") ||
      normalized.includes("blue cross") ||
      normalized.includes("bluecross");
    if (hasBcbsSignal && normalized.includes("turquoise")) {
      mapped = "BlueCross BlueShield Turquoise Care";
    }
  }

  // If still no match, try keyword-based matching for common patterns
  if (!mapped) {
    // Check for keyword matches in order of specificity
    const keywordMatches: [string, string][] = [
      ["champva", "ChampVA"],
      ["champ va", "ChampVA"],
      ["vaccn", "VACCN"],
      ["va community care", "VACCN"],
      ["vapc3", "VACCN"],
      ["tricare", "Tricare"],
      // "turquoise care" must be tested BEFORE "bcbs"/"blue cross" so a
      // Turquoise Care (Medicaid managed care) string isn't mis-bucketed as
      // Commercial by the broader "bcbs"/"blue cross" keywords.
      ["turquoise care", "Presbyterian Turquoise Care"],
      ["bcbs", "BlueCross BlueShield Commercial"],
      ["blue cross", "BlueCross BlueShield Commercial"],
      ["presbyterian", "Presbyterian Commercial"],
      ["magellan", "Presbyterian Commercial"],
      ["uhc cent", "UHC Centennial"],
      ["united health", "UHC Commercial"],
      ["uhc", "UHC Commercial"],
      ["optum", "UHC Commercial"],
      ["umr", "UHC Commercial"],
      ["aetna", "Aetna"],
      ["meritain", "Aetna"],
      ["medicare", "Medicare"],
      ["medicaid", "Medicaid"],
      ["molina", "Molina"],
      ["self-pay", "Self-Pay"],
      ["self pay", "Self-Pay"],
      ["compsych", "ComPsych"],
      ["health smart", "Health Smart"],
    ];

    for (const [keyword, category] of keywordMatches) {
      if (normalized.includes(keyword)) {
        mapped = category;
        break;
      }
    }
  }

  // If mapped to a rejection category, return Unknown
  if (mapped === "Not Accepted" || mapped === "Need to remove as we do not accept insurance") {
    return "Unknown";
  }

  // Return mapped value if it's a valid insurance category, otherwise Unknown
  if (mapped && ACCEPTED_INSURANCES.includes(mapped as typeof ACCEPTED_INSURANCES[number])) {
    return mapped as InsuranceCategory;
  }

  return "Unknown";
}

/**
 * Get normalized list of TFC clinic-level accepted insurances
 *
 * TODO: Remove this function once per-provider insurance data is populated
 * in the Provider Skills Spreadsheet Column 30.
 *
 * @returns Array of normalized InsuranceCategory values that TFC accepts
 */
export function getTFCAcceptedInsurances(): InsuranceCategory[] {
  // Normalize each raw insurance name from the clinic list
  const normalized = TFC_ACCEPTED_INSURANCES_RAW
    .map(raw => normalizeInsurance(raw))
    .filter(ins => ins !== "Unknown");

  // Deduplicate (some raw values may normalize to the same category)
  return Array.from(new Set(normalized)) as InsuranceCategory[];
}

/**
 * Check if an insurance is accepted by TFC clinic
 * Used for hard constraint in provider matching
 */
export function isInsuranceAcceptedByTFC(insurance: InsuranceCategory): boolean {
  if (insurance === "Unknown") return false;
  const tfcInsurances = getTFCAcceptedInsurances();
  return tfcInsurances.includes(insurance);
}

/**
 * Check if a provider accepts a specific insurance
 * Returns true if the contact's insurance is in the provider's accepted list
 * Returns true if contact insurance is Unknown (can't filter on unknown)
 */
export function providerAcceptsInsurance(
  providerInsurances: InsuranceCategory[],
  contactInsurance: InsuranceCategory
): boolean {
  // If contact insurance is unknown, we can't filter on it
  if (contactInsurance === "Unknown") {
    return true;
  }

  // If provider has no insurance data, we cannot confirm a match
  if (!providerInsurances || providerInsurances.length === 0) {
    return false;
  }

  return providerInsurances.includes(contactInsurance);
}

/**
 * Parse a comma-separated insurance string into normalized categories
 * Used to parse provider's accepted insurances from spreadsheet Column 30
 * @param rawInsuranceString - Comma-separated string like "BCBS, Presbyterian, Tricare"
 * @returns Array of normalized insurance categories
 */
export function parseInsuranceList(rawInsuranceString: string | null | undefined): InsuranceCategory[] {
  if (!rawInsuranceString) return [];

  const insurances = rawInsuranceString
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => normalizeInsurance(s))
    .filter(s => s !== "Unknown");

  // Deduplicate using Array.from for TypeScript compatibility
  return Array.from(new Set(insurances)) as InsuranceCategory[];
}
