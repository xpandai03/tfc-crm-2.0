/**
 * Provider + Location Configuration
 *
 * Source of truth: tfc-emails-march2026.md (Dawn's email, March 2026)
 * All provider names, credentials, and emails are hardcoded from that file.
 * All office locations and addresses are hardcoded from that file.
 */

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

export const PROVIDERS: ProviderEntry[] = [
  { name: "Abena Marfowaa Owusu-Nkwantabisiah", credential: "LPCC", email: "abena@tfc.health" },
  { name: "Amanda Davison", credential: "LMFT", email: "amanda@tfc.health" },
  { name: "Amaya Castaneda", credential: "Admin", email: "amayac@tfc.health" },
  { name: "Amber Lute", credential: "LAMFT", email: "alute@tfc.health" },
  { name: "Amber Merritt", credential: "LCSW", email: "amber@tfc.health" },
  { name: "Angelica Chavez", credential: "LCSW", email: "angelicac@tfc.health" },
  { name: "Angelica Villicana", credential: "LCSW", email: "angelica@tfc.health" },
  { name: "Anna Aldridge", credential: "LMHC", email: "anna@tfc.health" },
  { name: "Bentley Carbone", credential: "LAMFT", email: "bentley@tfc.health" },
  { name: "Carrie Savedra", credential: "LMSW", email: "carrie@tfc.health" },
  { name: "Cindy Ketchum", credential: "Intern", email: "cindy@tfc.health" },
  { name: "Danielle Dimas", credential: "LPCC", email: "danielle@tfc.health" },
  { name: "Debra Dederich-Elsner", credential: "LPCC", email: "debra@tfc.health" },
  { name: "Elizabeth Lopez", credential: "LCSW", email: "elopez@tfc.health" },
  { name: "Erica Benavidez", credential: "Office Manager", email: "ebenavidez@tfc.health" },
  { name: "Ivory Kahler", credential: "LMSW", email: "ikahler@tfc.health" },
  { name: "Janet Fackrell", credential: "Intern", email: "jfackrell@tfc.health" },
  { name: "Jennifer Bogart", credential: "LPCC", email: "jenniferb@tfc.health" },
  { name: "Jessica Neuhart", credential: "Intern", email: "jneuhart@tfc.health" },
  { name: "Jill Nantze", credential: "LAMFT", email: "jnantze@tfc.health" },
  { name: "Kennedy Hull", credential: "LPCC", email: "kennedy@tfc.health" },
  { name: "Krista Luna", credential: "LMHC", email: "kluna@tfc.health" },
  { name: "Kristi Simmons", credential: "Intern", email: "ksimmons@tfc.health" },
  { name: "Laura Garcia-Rosecrans", credential: "LMHC", email: "lgarcia-rosecrans@tfc.health" },
  { name: "Laurel Muehlmeyer", credential: "Intern", email: "lmuehlmeyer@tfc.health" },
  { name: "Nona Bockius", credential: "Admin", email: "nbockius@tfc.health" },
  { name: "Paula Raley", credential: "LCSW", email: "praley@tfc.health" },
  { name: "Renee Singletary", credential: "LCSW", email: "renee@tfc.health" },
  { name: "Sandra Rivera", credential: "LMFT", email: "sandra@tfc.health" },
  { name: "Tyra Jones", credential: "Intern", email: "tjones@tfc.health" },
  { name: "Victoria Santangelo", credential: "Admin", email: "victoria@tfc.health" },
];

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

export function getProviderByName(name: string): ProviderEntry | undefined {
  return PROVIDERS.find(
    (p) => p.name.toLowerCase() === name.toLowerCase()
  );
}

export function getLocationById(id: string): OfficeLocation | undefined {
  return OFFICE_LOCATIONS.find((l) => l.id === id);
}
