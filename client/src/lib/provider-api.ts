/**
 * Provider API Module
 *
 * Fetches provider data from the spreadsheet-backed API endpoint
 * and transforms it into the format expected by the matching algorithm.
 */

import { useQuery } from "@tanstack/react-query";
import {
  type InsuranceCategory,
  parseInsuranceList,
} from "./insurance-utils";
import {
  getProviderInsurances,
  hasProviderInsuranceData,
  PROVIDERS_WITHOUT_INSURANCE_DATA,
} from "./provider-insurance-data";
import {
  type Provider,
  type AgeGroup,
  type Specialty,
  type CapabilityLevel,
  type ProviderLocation,
  type AgeGroupCapabilities,
  type SpecialtyCapability,
} from "./providers";

/**
 * Raw provider data as returned from /api/providers
 */
interface ApiProvider {
  id: number;
  nameWithCredentials: string;
  name: string;
  credentials: string;
  location: string;
  ageGroups: {
    "Adults (18+)": Record<string, string>;
    "Adolescents (12-17)": Record<string, string>;
    "Children (6-11)": Record<string, string>;
    "Children (0-5)": Record<string, string>;
  };
  notes: string;
  acceptedInsurances?: string; // Column 30 - comma-separated string
}

interface ApiResponse {
  providers: ApiProvider[];
  _source: string;
  lastModified?: string;
}

/**
 * Extended Provider interface with insurance data
 */
export interface ProviderWithInsurance extends Provider {
  acceptedInsurances: InsuranceCategory[];
}

/**
 * Map API age group key to internal AgeGroup type
 */
function mapAgeGroupKey(key: string): AgeGroup | null {
  switch (key) {
    case "Adults (18+)":
      return "adults";
    case "Adolescents (12-17)":
      return "adolescents";
    case "Children (6-11)":
      return "children_6_11";
    case "Children (0-5)":
      return "children_0_5";
    default:
      return null;
  }
}

/**
 * Map API specialty name to internal Specialty type
 */
function mapSpecialtyName(name: string): Specialty | null {
  const mapping: Record<string, Specialty> = {
    "Anger Issues": "anger_issues",
    "Anxiety": "anxiety",
    "Couples": "couples",
    "Depression": "depression",
    "Family": "family",
    "Grief": "grief",
    "Trauma": "trauma",
    "Stress Management": "stress_management",
  };
  return mapping[name] || null;
}

/**
 * Parse raw capability value ("x", "x - Slow", empty) to CapabilityLevel
 */
function parseCapability(value: string | undefined): CapabilityLevel {
  if (!value || value.trim() === "") return "none";
  const lower = value.toLowerCase().trim();
  if (lower.includes("slow")) return "slow";
  if (lower === "x" || lower === "x ") return "full";
  return "none";
}

/**
 * Map API location string to ProviderLocation
 * Note: "Corp" (Corporate) is mapped to "ABQ" - TFC only has 3 locations: ABQ, LL, RR
 */
function mapLocation(location: string): ProviderLocation {
  const loc = location.toLowerCase().trim();
  // Corp/Corporate maps to ABQ (not a separate location)
  if (loc.includes("corp") || loc.includes("corporate")) return "ABQ";
  if (loc.includes("abq") || loc.includes("albuquerque")) return "ABQ";
  if (loc.includes("ll") || loc.includes("los lunas") || loc.includes("loslunas")) return "LL";
  if (loc.includes("rr") || loc.includes("rio rancho") || loc.includes("riorancho")) return "RR";
  // Default to ABQ if unclear
  return "ABQ";
}

/**
 * Parse notes into additional specialties
 * Extracts keywords like ADHD, EMDR, etc. from notes column
 */
function parseAdditionalSpecialties(notes: string): string[] {
  if (!notes) return [];

  const keywords = [
    "ADHD", "ADD",
    "EMDR",
    "Bi-polar", "Bipolar",
    "Conduct behavioral", "Conduct Behavioral", "Conduct disorder",
    "Personality disorder", "Personality Disorder",
    "Substance abuse", "Substance Use",
    "Christian Counseling",
    "Eating Disorders", "Eating disorders", "Eating Disorder",
    "Neurodevelopmental",
    "RTM",
    "Military Life", "Military life",
    "LGBTQ", "Gay/Lesbian", "Gender Identity",
    "Spanish",
    "Russian",
    "IMH",
    "Parenting",
    "Complex Medical",
  ];

  const found: string[] = [];
  const notesLower = notes.toLowerCase();

  for (const keyword of keywords) {
    if (notesLower.includes(keyword.toLowerCase())) {
      found.push(keyword);
    }
  }

  return found;
}

/**
 * Transform API provider to internal Provider format
 */
export function transformApiProvider(api: ApiProvider): ProviderWithInsurance {
  // Build age groups array
  const ageGroups: AgeGroupCapabilities[] = [];

  for (const [ageGroupKey, specialtiesMap] of Object.entries(api.ageGroups)) {
    const ageGroup = mapAgeGroupKey(ageGroupKey);
    if (!ageGroup) continue;

    const specialties: SpecialtyCapability[] = [];

    for (const [specialtyName, rawValue] of Object.entries(specialtiesMap)) {
      const specialty = mapSpecialtyName(specialtyName);
      if (!specialty) continue;

      const level = parseCapability(rawValue);
      if (level !== "none") {
        specialties.push({ specialty, level });
      }
    }

    // Only add age group if it has at least one specialty
    if (specialties.length > 0) {
      ageGroups.push({ ageGroup, specialties });
    }
  }

  // Parse additional specialties from notes
  const additionalSpecialties = parseAdditionalSpecialties(api.notes);

  // Get accepted insurances from provider insurance snapshot data (primary source)
  // Falls back to Column 30 from spreadsheet, then to clinic-level as last resort
  let acceptedInsurances: InsuranceCategory[] = [];

  // Priority 1: Provider Insurance Snapshot (hardcoded data from Jan 2026)
  const snapshotInsurances = getProviderInsurances(api.name);
  if (snapshotInsurances && snapshotInsurances.length > 0) {
    acceptedInsurances = snapshotInsurances;
  }
  // Priority 2: Column 30 from Provider Skills Spreadsheet
  else if (api.acceptedInsurances) {
    acceptedInsurances = parseInsuranceList(api.acceptedInsurances);
  }
  // No fallback: providers without insurance data get an empty array.
  // The matching algorithm will flag these with a warning instead of
  // silently assuming they accept all insurances.
  if (acceptedInsurances.length === 0 && PROVIDERS_WITHOUT_INSURANCE_DATA.includes(api.name)) {
    console.debug(`[Provider API] ${api.name}: No insurance data available (not in snapshot, Column 30 empty)`);
  }

  return {
    name: api.name,
    credentials: api.credentials,
    location: mapLocation(api.location),
    acceptingNewPatients: true, // Assume all in "Current" sheet are accepting
    ageGroups,
    additionalSpecialties,
    acceptedInsurances,
  };
}

/**
 * Fetch providers from the API
 */
async function fetchProviders(): Promise<ProviderWithInsurance[]> {
  const response = await fetch("/api/providers");

  if (!response.ok) {
    throw new Error(`Failed to fetch providers: ${response.status}`);
  }

  const data: ApiResponse = await response.json();

  if (!data.providers || !Array.isArray(data.providers)) {
    throw new Error("Invalid provider data format");
  }

  // Transform all providers
  return data.providers.map(transformApiProvider);
}

/**
 * React Query hook for fetching providers
 * Caches provider data for 5 minutes
 */
export function useProviders() {
  const query = useQuery({
    queryKey: ["/api/providers", "transformed"],
    queryFn: fetchProviders,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });

  return {
    providers: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * Check if providers have any insurance data
 * Useful for displaying a warning if Column 30 isn't populated
 */
export function hasInsuranceData(providers: ProviderWithInsurance[]): boolean {
  return providers.some(p => p.acceptedInsurances.length > 0);
}
