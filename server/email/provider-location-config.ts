/**
 * Provider Email + Location Configuration
 *
 * Single source of truth for the Send Email modal:
 * - PROVIDER_LIST: canonical provider list (dropdown + CC resolution)
 * - OFFICE_LOCATIONS: location list for the location dropdown
 *
 * Source: tfc-emails-march2026.md (Dawn's email, March 2026)
 * Credentials: Provider Skills Spreadsheet
 */

import { normalizeProviderName } from "../providers/normalize-name";

export interface ProviderEntry {
  name: string;
  credential: string;
  email: string;
}

export interface OfficeLocation {
  id: string;
  label: string;
  address: string | null;
  telehealth: boolean;
}

/**
 * Canonical provider list — powers both the dropdown and CC resolution.
 * Alphabetical by last name. No admins, no inactive providers.
 */
export const PROVIDER_LIST: ProviderEntry[] = [
  { name: "Anna Aldridge", credential: "LMHC", email: "anna@tfc.health" },
  { name: "Danielle Dimas", credential: "LPCC", email: "danielle@tfc.health" },
  { name: "Bentley Carbone", credential: "LAMFT", email: "bentley@tfc.health" },
  { name: "Angelica Chavez", credential: "LCSW", email: "angelicac@tfc.health" },
  { name: "Amanda Davison", credential: "LMFT", email: "amanda@tfc.health" },
  { name: "Debra Dederich-Elsner", credential: "LPCC", email: "debra@tfc.health" },
  { name: "Janet Fackrell", credential: "Intern", email: "jfackrell@tfc.health" },
  { name: "Laura Garcia-Rosecrans", credential: "LMHC", email: "lgarcia-rosecrans@tfc.health" },
  { name: "Kennedy Hull", credential: "LPCC", email: "kennedy@tfc.health" },
  { name: "Ivory Kahler", credential: "LMSW", email: "ikahler@tfc.health" },
  { name: "Tyra Jones", credential: "LMHC", email: "tjones@tfc.health" },
  { name: "Cindy Ketchum", credential: "Intern", email: "cindy@tfc.health" },
  { name: "Liz Lopez", credential: "LCSW", email: "elopez@tfc.health" },
  { name: "Krista Luna", credential: "LMHC", email: "kluna@tfc.health" },
  { name: "Amber Lute", credential: "LAMFT", email: "alute@tfc.health" },
  { name: "Amber Merritt", credential: "LCSW", email: "amber@tfc.health" },
  { name: "Laurel Muehlmeyer", credential: "Intern", email: "lmuehlmeyer@tfc.health" },
  { name: "Jill Nantze", credential: "LAMFT", email: "jnantze@tfc.health" },
  { name: "Jessica Neuhart", credential: "Intern", email: "jneuhart@tfc.health" },
  { name: "Abena Marfowaa Owusu-Nkwantabisah", credential: "LPCC", email: "abena@tfc.health" },
  { name: "Jennifer Bogart", credential: "LPCC", email: "jenniferb@tfc.health" },
  { name: "Paula Raley", credential: "LCSW", email: "praley@tfc.health" },
  { name: "Sandra Rivera", credential: "LMFT", email: "sandra@tfc.health" },
  { name: "Carrie Savedra", credential: "LMSW", email: "carrie@tfc.health" },
  { name: "Kristi Simmons", credential: "Intern", email: "ksimmons@tfc.health" },
  { name: "Renee Singletary", credential: "LMSW", email: "renee@tfc.health" },
  { name: "Angelica Villicana", credential: "LCSW", email: "angelica@tfc.health" },
  { name: "Ginger Rippey", credential: "LMHC", email: "GRippey@tfc.health" },
];

// Derived email map for CC resolution (case-insensitive)
const emailMapLower: Record<string, string> = {};
for (const p of PROVIDER_LIST) {
  emailMapLower[p.name.toLowerCase()] = p.email;
}

// Reverse map: lowercased email → ProviderEntry, for O(1) email lookup
// (used by /api/provider-availability to validate inbound form emails).
// PROVIDER_LIST emails are lowercase by convention; normalize defensively.
const entryByEmailLower: Record<string, ProviderEntry> = {};
for (const p of PROVIDER_LIST) {
  entryByEmailLower[p.email.trim().toLowerCase()] = p;
}

// ===========================================================================
// Phase 3 (provider unification): crm_providers-derived directory is the PRIMARY
// source for the email axis; PROVIDER_LIST below is a SILENT FALLBACK on a miss.
// The directory is pushed in by the server (setCrmDirectory) after querying
// crm_providers (is_active = true AND email IS NOT NULL), so these resolvers stay
// synchronous for their existing callers. Until the first refresh (or on a miss),
// lookups fall back to PROVIDER_LIST — so nothing ever hard-fails during the
// transition. Active-only by construction (the directory excludes inactive rows).
// ===========================================================================
let crmDirByEmail = new Map<string, ProviderEntry>();
let crmDirByNorm = new Map<string, ProviderEntry>();

/** Replace the in-memory crm directory (called by the server after querying). */
export function setCrmDirectory(entries: ProviderEntry[]): void {
  const byEmail = new Map<string, ProviderEntry>();
  const byNorm = new Map<string, ProviderEntry>();
  for (const e of entries) {
    const email = (e.email || "").trim().toLowerCase();
    if (!email) continue;
    const entry: ProviderEntry = { name: e.name, credential: e.credential, email };
    byEmail.set(email, entry);
    byNorm.set(normalizeProviderName(e.name), entry);
  }
  crmDirByEmail = byEmail;
  crmDirByNorm = byNorm;
}

/** Active emailed providers from crm_providers (the Assign-dropdown source). */
export function getCrmDirectory(): ProviderEntry[] {
  return Array.from(crmDirByEmail.values());
}

/**
 * Resolve a provider name to their email address.
 * Primary: crm_providers directory (by normalized name). Fallback: PROVIDER_LIST.
 * Case-insensitive. Returns undefined only if neither source has it.
 */
export function getProviderEmail(name: string): string | undefined {
  const hit = crmDirByNorm.get(normalizeProviderName(name || ""));
  if (hit) return hit.email;
  const fb = emailMapLower[(name || "").toLowerCase()];
  if (fb) console.log(`[provider-dir] getProviderEmail fallback→PROVIDER_LIST for "${name}"`);
  return fb;
}

/**
 * Resolve a provider email to their full ProviderEntry (name, credential, email).
 *
 * v1: Sources only from PROVIDER_LIST. CRM-managed providers (crm_providers
 * table) are NOT yet covered — those have no email column. Unifying lookup
 * across both sources is a follow-up ticket.
 *
 * Case-insensitive; trims whitespace. Returns undefined for unknown emails
 * (does NOT throw — callers handle the missing case).
 */
export function getProviderByEmail(email: string): ProviderEntry | undefined {
  if (!email) return undefined;
  const key = email.trim().toLowerCase();
  const hit = crmDirByEmail.get(key);
  if (hit) return hit;
  const fb = entryByEmailLower[key];
  if (fb) console.log(`[provider-dir] getProviderByEmail fallback→PROVIDER_LIST for "${key}"`);
  return fb;
}

export const OFFICE_LOCATIONS: OfficeLocation[] = [
  {
    id: "albuquerque",
    label: "Albuquerque",
    address: "6001 Whiteman Dr NW\nAlbuquerque, NM 87120",
    telehealth: false,
  },
  {
    id: "rio-rancho",
    label: "Rio Rancho",
    address: "2441 Cabezon Blvd SE\nRio Rancho, NM 87124",
    telehealth: false,
  },
  {
    id: "los-lunas",
    label: "Los Lunas",
    address: "2112 Main St NE Suite A\nLos Lunas, NM 87031",
    telehealth: false,
  },
  {
    id: "telehealth",
    label: "Telehealth",
    address: null,
    telehealth: true,
  },
];

export function getLocationById(id: string): OfficeLocation | undefined {
  return OFFICE_LOCATIONS.find((l) => l.id === id);
}
