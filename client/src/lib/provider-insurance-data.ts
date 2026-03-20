/**
 * Provider Insurance Snapshot Data
 *
 * Hardcoded provider-level insurance acceptance data from the
 * Credentialing Spreadsheet (Updated March 2026).
 *
 * Data source: Credentialing Spreadsheet Updated (5).pdf
 *
 * Interpretation rules:
 * - Date value (e.g., "8.1.23") → Accepted (credentialed/recredentialed)
 * - "U7" → Accepted (credentialing code)
 * - "Approved" → Accepted
 * - Blank → Not accepted
 * - "Sup" in Pres Com column → No Presbyterian Commercial, but other
 *   insurances with real dates ARE included (supervised billing only
 *   affects Pres Com; does not exclude from other payers)
 *
 * Excluded columns (per Dawn's guidance):
 * - Aetna (EAP), Compsych (EAP), Anthem EAP → EAPs not accepted
 * - Solutions Group → Not accepted
 * - Health Advocate → Not accepted
 * - Mines & Associates → Not accepted
 * - Mutual of Omaha → Not accepted
 */

import type { InsuranceCategory } from "./insurance-utils";

/**
 * Mapping from snapshot first names to full provider names in the system.
 * Used to join insurance data to provider records.
 */
export const PROVIDER_NAME_MAPPING: Record<string, string> = {
  "Abena": "Abena Marfowaa Owusu-Nkwantabisah",
  "Amanda": "Amanda Davison",
  "Amber L": "Amber Lute",
  "Amber M": "Amber Merritt",
  "Angelica C": "Angelica Chavez",
  "Angelica V": "Angelica Villicana",
  "Anna": "Anna Aldridge",
  "Bentley": "Bentley Carbone",
  "Carrie": "Carrie Savedra",
  "Cindy": "Cindy Ketchum",
  "Danielle": "Danielle Burke",
  "Debra": "Debra Dederich-Elsner",
  "Elizabeth": "Liz Lopez",
  "Janet": "Janet Fackrell",
  "Jennifer B": "Jennifer Bogart",
  "Jessica": "Jessica Neuhart",
  "Jill": "Jill Nantze",
  "Kennedy": "Kennedy Hull",
  "Krista": "Krista luna",
  "Kristi": "Kristi Simmons",
  "Laura": "Laura Garcia-Rosecrans",
  "Laurel": "Laurel Muehlmeyer",
  "Paula": "Paula Raley",
  "Renee": "Renee Singletary",
  "Sandra": "Sandra Rivera",
  "Tyra": "Tyra Jones",
  "Ivory": "Ivory Kahler",
};

/**
 * Providers in snapshot that are NOT in the Current sheet of the
 * Provider Skills Spreadsheet. These are inactive or non-patient-facing.
 */
export const UNMATCHED_SNAPSHOT_PROVIDERS = [
  "Ginger",    // Not in Current sheet
];

/**
 * Providers in the Current sheet that are NOT in the insurance snapshot PDF.
 * These providers have no per-provider insurance data and will show a warning.
 */
export const PROVIDERS_WITHOUT_INSURANCE_DATA: string[] = [
];

/**
 * Provider-level accepted insurances from the snapshot.
 * Key: Full provider name (must match PROVIDERS list)
 * Value: Array of canonical insurance categories
 */
export const PROVIDER_INSURANCE_DATA: Record<string, InsuranceCategory[]> = {
  // Row 1: Abena - RR - Full credentials
  "Abena Marfowaa Owusu-Nkwantabisah": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 2: Amanda - Corp (ABQ) - Full credentials
  "Amanda Davison": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 3: Amber L - LL - Supervisor status (limited insurances)
  "Amber Lute": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "ComPsych",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 4: Amber M - RR - Full credentials
  "Amber Merritt": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 5: Angelica C - ABQ - Full credentials (no ChampVA)
  "Angelica Chavez": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 6: Angelica V - RR - Full credentials
  "Angelica Villicana": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 7: Anna - ABQ - Full credentials (no Tricare, no ChampVA)
  "Anna Aldridge": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 8: Bentley - ABQ - Supervisor status (limited insurances)
  "Bentley Carbone": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "ComPsych",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 9: Carrie - LL - Full credentials (no Carelon, no Tricare, no ChampVA)
  "Carrie Savedra": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "Medicare",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 10: Danielle - RR - Full credentials
  "Danielle Burke": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 11: Debra - LL - Full credentials
  "Debra Dederich-Elsner": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 12: Elizabeth (Liz Lopez) - LL - Full credentials
  "Liz Lopez": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 14: Jennifer B - ABQ - Full credentials (no Tricare from snapshot)
  "Jennifer Bogart": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 19: Jill - LL - Supervisor status (limited insurances)
  "Jill Nantze": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "Aetna",
    "ComPsych",
    "Molina",
    "Tricare",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 15: Kennedy - ABQ - Full credentials (no Tricare from snapshot)
  "Kennedy Hull": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 16: Paula - LL - Full credentials
  "Paula Raley": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 17: Renee - RR - Full credentials
  "Renee Singletary": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // Row 18: Sandra - ABQ - Full credentials
  "Sandra Rivera": [
    "Presbyterian Commercial",
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Partners Direct Health",
    "VACCN",
    "Tricare",
    "Aetna",
    "ComPsych",
    "Medicare",
    "Molina",
    "Carelon",
    "UHC Commercial",
    "UHC Centennial",
    "ChampVA",
  ],

  // ================================================================
  // Supervised providers — "Sup" in Pres Com column only.
  // All other columns with real dates/U7 are included.
  // Source: Provider Snapshot 2.9.26 PDF
  // ================================================================

  // Row 23: Cindy - RR - Supervised (intern)
  // Supervisor: Renee | Pres Com: Sup
  "Cindy Ketchum": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 20: Janet - RR - Supervised (intern)
  // Supervisor: Angelica V | Pres Com: Sup
  "Janet Fackrell": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 23: Jessica - ABQ - Supervised (intern)
  // Supervisor: Debra | Pres Com: Sup
  "Jessica Neuhart": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 23: Krista - ABQ - Supervised (LMHC)
  // Supervisor: Sandra | Pres Com: Sup | Molina: U7
  "Krista luna": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 23: Kristi - LL - Supervised (intern)
  // Supervisor: Debra | Pres Com: Sup | Molina: U7
  "Kristi Simmons": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 21: Laura - LL - Supervised (LMHC)
  // Supervisor: Paula | Pres Com: Sup
  // Has VACCN + Tricare dates (1.15.26) unlike most supervised providers
  "Laura Garcia-Rosecrans": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "VACCN",
    "Tricare",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Row 22: Laurel - RR - Supervised (intern)
  // Supervisor: Renee | Pres Com: Sup
  "Laurel Muehlmeyer": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Tyra Jones - ABQ - Supervised (LMHC)
  // Supervisor: Angelica C | Pres Com: Sup
  // Source: Credentialing Spreadsheet Updated (5).pdf — row 28
  // Note: Skills sheet lists as "Ty Jones" — name corrected in server parser
  "Tyra Jones": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],

  // Ivory Kahler - RR - Supervised (LMSW)
  // Supervisor: Angelica V | Pres Com: Sup
  // Source: Credentialing Spreadsheet Updated (5).pdf — row 15
  // Note: In skills sheet with no skills/location data (placeholder)
  "Ivory Kahler": [
    "Presbyterian Turquoise Care",
    "BlueCross BlueShield Commercial",
    "BlueCross BlueShield Turquoise Care",
    "Molina",
    "UHC Commercial",
    "UHC Centennial",
  ],
};

/**
 * Get provider's accepted insurances from the snapshot data.
 * Returns undefined if the provider is not in the snapshot.
 *
 * @param providerName - Full provider name (must match PROVIDERS list exactly)
 * @returns Array of accepted insurance categories, or undefined if not found
 */
export function getProviderInsurances(providerName: string): InsuranceCategory[] | undefined {
  return PROVIDER_INSURANCE_DATA[providerName];
}

/**
 * Check if a provider has insurance data in the snapshot.
 *
 * @param providerName - Full provider name
 * @returns true if provider has insurance data, false otherwise
 */
export function hasProviderInsuranceData(providerName: string): boolean {
  return providerName in PROVIDER_INSURANCE_DATA;
}

/**
 * Log providers that couldn't be matched for visibility.
 * Call this during development/debugging.
 */
export function logUnmatchedProviders(): void {
  console.log("[Provider Insurance] Unmatched snapshot providers:", UNMATCHED_SNAPSHOT_PROVIDERS);
  console.log("[Provider Insurance] Providers without insurance data:", PROVIDERS_WITHOUT_INSURANCE_DATA);
}
