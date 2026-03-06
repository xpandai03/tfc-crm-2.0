/**
 * Provider Email + Location Configuration
 *
 * Email map source: tfc-emails-march2026.md (Dawn's email, March 2026)
 * Provider dropdown source: /api/providers (spreadsheet-backed, self-maintaining)
 *
 * This file provides:
 * - PROVIDER_EMAIL_MAP: name → email lookup for CC resolution
 * - OFFICE_LOCATIONS: location list for the location dropdown
 *
 * The provider *list* for the dropdown comes from the Provider Skills
 * Spreadsheet ("Current" sheet) via /api/providers. This file is only
 * used for email resolution — it does NOT control who appears in the dropdown.
 */

export interface OfficeLocation {
  id: string;
  label: string;
  address: string | null;
  telehealth: boolean;
}

/**
 * Provider name → email address.
 * Used for CC resolution when sending emails.
 * Names are stored as-is from the md file; lookup is case-insensitive.
 */
export const PROVIDER_EMAIL_MAP: Record<string, string> = {
  "Abena Marfowaa Owusu-Nkwantabisiah": "abena@tfc.health",
  "Amanda Davison": "amanda@tfc.health",
  "Amaya Castaneda": "amayac@tfc.health",
  "Amber Lute": "alute@tfc.health",
  "Amber Merritt": "amber@tfc.health",
  "Angelica Chavez": "angelicac@tfc.health",
  "Angelica Villicana": "angelica@tfc.health",
  "Anna Aldridge": "anna@tfc.health",
  "Bentley Carbone": "bentley@tfc.health",
  "Carrie Savedra": "carrie@tfc.health",
  "Cindy Ketchum": "cindy@tfc.health",
  "Danielle Dimas": "danielle@tfc.health",
  "Debra Dederich-Elsner": "debra@tfc.health",
  "Elizabeth Lopez": "elopez@tfc.health",
  "Erica Benavidez": "ebenavidez@tfc.health",
  "Ivory Kahler": "ikahler@tfc.health",
  "Janet Fackrell": "jfackrell@tfc.health",
  "Jennifer Bogart": "jenniferb@tfc.health",
  "Jessica Neuhart": "jneuhart@tfc.health",
  "Jill Nantze": "jnantze@tfc.health",
  "Kennedy Hull": "kennedy@tfc.health",
  "Krista Luna": "kluna@tfc.health",
  "Kristi Simmons": "ksimmons@tfc.health",
  "Laura Garcia-Rosecrans": "lgarcia-rosecrans@tfc.health",
  "Laurel Muehlmeyer": "lmuehlmeyer@tfc.health",
  "Nona Bockius": "nbockius@tfc.health",
  "Paula Raley": "praley@tfc.health",
  "Renee Singletary": "renee@tfc.health",
  "Sandra Rivera": "sandra@tfc.health",
  "Tyra Jones": "tjones@tfc.health",
  "Victoria Santangelo": "victoria@tfc.health",
};

// Case-insensitive index built once at import time
const emailMapLower: Record<string, string> = {};
for (const [name, email] of Object.entries(PROVIDER_EMAIL_MAP)) {
  emailMapLower[name.toLowerCase()] = email;
}

/**
 * Resolve a provider name to their email address.
 * Case-insensitive. Returns undefined if no match.
 */
export function getProviderEmail(name: string): string | undefined {
  return emailMapLower[name.toLowerCase()];
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
