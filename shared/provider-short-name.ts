/**
 * Provider short name — the name on a provider's tab in the survey workbook.
 * ============================================================================
 *
 * The client's survey export has one sheet per provider, named in short form:
 * "Amanda D", "Amber L", "Angelica C", "Abena". This module is the single place
 * that answers "what is this provider's short name", so the workbook builder,
 * the provider editor and anything else all get the same answer.
 *
 * WHY THE NAME IS STORED RATHER THAN DERIVED
 * ------------------------------------------
 * The client's rule looks like "first name, plus a surname initial only where
 * first names collide". Applied to the live roster it reproduces 25 of the 26
 * tab names. It fails on exactly one: "Amber L". Amber Lute is the only active
 * Amber today, so a collision rule sees no collision and yields "Amber". The
 * initial exists because Amber Merritt was on the roster when the client drew
 * the template, and she has since left.
 *
 * That single failure is the argument. A derived short name is not a property
 * of the provider — it is a property of who else happens to be employed that
 * week. A departure silently renames a different provider's tab, and
 * quarter-on-quarter comparisons stop lining up on a change nobody made.
 *
 * There is a second, harder reason. "Abena Marfowaa Owusu-Nkwantabisah" is 33
 * characters and Excel caps a sheet name at 31 (see MAX_SHEET_NAME_LENGTH). A
 * truncation rule would fix the length but introduces a duplicate-name risk,
 * because two long names can truncate to the same string and two sheets in one
 * workbook cannot share a name. A stored short name fixes both at once.
 *
 * NOT THE WAITLIST SHORTENER. client/src/components/waitlist/waitlist-columns.ts
 * carries abbreviateProviderName()/buildProviderDisplayMap(), which render
 * "Anna A." for a table column and fall back to the FULL name on a collision.
 * That is a different rule for a different surface and is deliberately left
 * alone — it is not imported here and nothing here should be used there.
 *
 * IMPORTS: dependency-free on purpose, so either side of the wire can use it.
 */

/** Excel's hard cap on a worksheet name. */
export const MAX_SHEET_NAME_LENGTH = 31;

/**
 * Characters Excel refuses inside a worksheet name. A name may also not be
 * empty, may not begin or end with an apostrophe, and may not be "History"
 * (reserved) — all checked by sheetNameProblem() below.
 */
export const FORBIDDEN_SHEET_NAME_CHARS = [":", "\\", "/", "?", "*", "[", "]"] as const;

/** The minimum shape this module needs off a provider record. */
export interface ProviderShortNameFields {
  name: string;
  shortName?: string | null;
}

/**
 * First word of a full name. Not exported: nothing outside this module should
 * be building its own short name, which is the whole point of the file.
 */
function firstNameOf(fullName: string | null | undefined): string {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? "" : parts[0];
}

/**
 * THE accessor. A provider's short name: the stored value when there is one,
 * otherwise their first name.
 *
 * THE FALLBACK DOES NO COLLISION HANDLING, DELIBERATELY. Adding a surname
 * initial when two first names clash is exactly the derivation this module
 * exists to replace, and doing it here would reintroduce the same instability
 * quietly — for precisely the providers nobody has set a name for, which is the
 * group least likely to be noticed. Two providers can therefore fall back to
 * the same short name, and that is intended: it is a visible prompt to set one,
 * not a case to paper over. The workbook builder is responsible for not writing
 * two sheets with the same name; see the note on uniqueness below.
 *
 * UNIQUENESS IS NOT GUARANTEED BY THE COLUMN. crm_providers carries a
 * case-insensitive partial-unique index on short_name, which stops two STORED
 * names colliding. It cannot stop two FALLBACKS colliding, because a fallback
 * is computed here and never written. Any consumer that needs distinct names
 * across a set must still de-duplicate what this returns.
 */
export function providerShortName(provider: ProviderShortNameFields): string {
  const stored = (provider.shortName ?? "").trim();
  return stored !== "" ? stored : firstNameOf(provider.name);
}

/**
 * Why a string is not usable as an Excel worksheet name, or null when it is.
 * Returns a message written for a staff member, not a developer, since this is
 * what a provider editor would show under the field.
 */
export function sheetNameProblem(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (v === "") return "Please enter a short name.";
  if (v.length > MAX_SHEET_NAME_LENGTH) {
    return `Please use ${MAX_SHEET_NAME_LENGTH} characters or fewer.`;
  }
  const bad = FORBIDDEN_SHEET_NAME_CHARS.filter((c) => v.includes(c));
  if (bad.length > 0) return `Please remove ${bad.join(" ")} — Excel does not allow it in a tab name.`;
  if (v.startsWith("'") || v.endsWith("'")) {
    return "Please remove the apostrophe from the start or end.";
  }
  if (v.toLowerCase() === "history") return "\"History\" is reserved by Excel. Please choose another name.";
  return null;
}

// ============================================================================
// Seed — the client's own 26, confirmed against production
// ============================================================================

/**
 * Full name → short name, taken verbatim from the tab names in
 * Lane-survey-export-template.xlsx and confirmed row by row against the live
 * roster on 2026-09-12 (26 tabs, 26 active providers, every one paired).
 *
 * This is CONFIRMED DATA, not a rule to reapply. Nothing here re-derives a
 * short name from a full name — that is the failure mode the file exists to
 * prevent. A new provider is not added here; they fall back to their first name
 * until someone sets one.
 *
 * Keys are the provider's `name` in crm_providers, exactly as stored.
 */
export const PROVIDER_SHORT_NAME_SEED: Readonly<Record<string, string>> = {
  // Albuquerque
  "Amanda Davison": "Amanda D",
  "Sandra Rivera": "Sandra",
  "Angelica Chavez": "Angelica C",
  "Anna Aldridge": "Anna",
  "Bentley Carbone": "Bentley",
  "Danya Estrada": "Danya",
  "Jennifer Bogart": "Jennifer",
  "Kennedy Hull": "Kennedy",
  "Krista Luna": "Krista",
  "Tyra Jones": "Tyra",
  // Los Lunas
  "Amanda Plotner": "Amanda P",
  "Amber Lute": "Amber L",
  "Carrie Savedra": "Carrie",
  "Debra Dederich-Elsner": "Debra",
  "Jill Nantze": "Jill",
  "Kristi Simmons": "Kristi",
  "Liz Lopez": "Liz",
  "Paula Raley": "Paula",
  // Rio Rancho
  "Abena Marfowaa Owusu-Nkwantabisah": "Abena",
  "Angelica Villicana": "Angelica V",
  "Cindy Ketchum": "Cindy",
  "Ginger Rippey": "Ginger",
  "Ivory Kahler": "Ivory",
  "Janet Fackrell": "Janet",
  "Laurel Muehlmeyer": "Laurel",
  "Renee Singletary": "Renee",
};
