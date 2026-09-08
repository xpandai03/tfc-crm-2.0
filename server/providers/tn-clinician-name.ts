/**
 * Provider display name  ↔  TherapyNotes clinician name.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * One string used to do two jobs:
 *
 *   1. a DISPLAY name for staff (providers page, assignment history, activity
 *      entries, the contact record, the email dropdown), and
 *   2. a LOOKUP KEY into TherapyNotes — the value the Axiom agent types into
 *      TN's clinician DynamicDropdown and then token-matches against the
 *      rendered options (services/api/tn_executor_v2.py::_select_clinician).
 *
 * The provider spreadsheet holds the form TherapyNotes actually uses
 * ("Ty Jones, LMHC"). PROVIDER_NAME_CORRECTIONS below rewrites that into the
 * form staff prefer to read ("Tyra Jones") — a genuine display improvement, and
 * the reason the corrected value is also what got persisted into crm_providers
 * and PROVIDER_LIST. Sending the corrected value onward as a TN lookup key is
 * what broke scheduling: the agent requires the sent name's tokens to be a
 * SUBSET of a rendered option's tokens, and {tyra, jones} is not a subset of
 * {jones, ty}. It fails hard and names both strings — that behaviour is correct
 * and is deliberately NOT relaxed. The data is what needs fixing.
 *
 * The correction map is therefore the ONLY source of truth for both directions:
 * the display name is the correction's output, the TherapyNotes name is its
 * input. There is no second list to keep in sync and no new column to migrate.
 */

import { normalizeProviderName } from "./normalize-name";

/**
 * Spreadsheet name → CRM display name.
 *
 * Keyed by the exact name text in column A of the Provider Skills Spreadsheet
 * (after the ", Credential" suffix is split off). Applied by the GET
 * /api/providers roster parser.
 */
export const PROVIDER_NAME_CORRECTIONS: Record<string, string> = {
  // "Last First" in the sheet — reordered for display. Token-identical, so the
  // agent's order-independent matcher handles either form; no TN-facing value
  // is derived from it (see TN_CLINICIAN_NAMES below).
  "Neuhart Jessica": "Jessica Neuhart",
  // Abbreviated in the sheet. "Ty Jones" is the form TherapyNotes renders, so
  // this correction DOES need a TN-facing value.
  "Ty Jones": "Tyra Jones",
};

/** Lowercased, punctuation-free token set — mirrors the agent's _name_tokens. */
function nameTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean));
}

/**
 * CRM display name (normalized) → the name TherapyNotes renders.
 *
 * Derived by INVERTING PROVIDER_NAME_CORRECTIONS, skipping any correction that
 * only reorders or re-punctuates tokens: the agent matches on an unordered token
 * set, so "Jessica Neuhart" already matches "Neuhart, Jessica". Only corrections
 * that change the TOKENS themselves (an abbreviation, a nickname, a spelling)
 * can break the match, and only those get an entry here.
 */
export const TN_CLINICIAN_NAMES: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [sheetName, displayName] of Object.entries(PROVIDER_NAME_CORRECTIONS)) {
    const sheetTokens = nameTokens(sheetName);
    const displayTokens = nameTokens(displayName);
    const sameTokens =
      sheetTokens.size === displayTokens.size &&
      [...sheetTokens].every((t) => displayTokens.has(t));
    if (sameTokens) continue; // reorder-only — matcher already handles it
    map[normalizeProviderName(displayName)] = sheetName;
  }
  return map;
})();

/**
 * Translate a CRM display name into the name to send as `clinician_name`.
 *
 * Providers with no entry in TN_CLINICIAN_NAMES — every provider but one today —
 * are returned BYTE-IDENTICAL to the input, including any ", Credential" suffix.
 * The credential is dropped only for a provider that has an explicit TN-facing
 * name, because that name is the bare form TherapyNotes renders and the tokens
 * of a suffix we invented would have to match too.
 *
 * Display surfaces must never call this. It exists for the agent payload only.
 */
export function toTherapyNotesClinicianName(displayName: string): string {
  const raw = displayName ?? "";
  const tnName = TN_CLINICIAN_NAMES[normalizeProviderName(raw)];
  return tnName ?? raw;
}
