/**
 * Provider Matching Algorithm
 *
 * Computes compatibility scores between a contact and providers.
 * All matching is deterministic and rule-based.
 *
 * v1.1: Added insurance matching with fallback logic
 */

import {
  Provider,
  AgeGroup,
  Specialty,
  CapabilityLevel,
  ProviderLocation,
  AGE_GROUP_LABELS,
  SPECIALTY_LABELS,
  LOCATION_LABELS,
} from "./providers";
import {
  normalizeInsurance,
  providerAcceptsInsurance,
  isInsuranceAcceptedByTFC,
  type InsuranceCategory,
} from "./insurance-utils";
import type { ProviderWithInsurance } from "./provider-api";
import type { ContactSnapshot } from "@shared/schema";

// Match result for a single provider
export interface ProviderMatch {
  provider: Provider;
  score: number;
  tier: "excellent" | "good" | "fair" | "poor";
  reasons: MatchReason[];
  warnings: string[];
}

// Individual reason for match/mismatch
export interface MatchReason {
  type: "positive" | "neutral" | "warning";
  text: string;
}

// Matching context derived from contact
export interface MatchingContext {
  ageGroup: AgeGroup | null;
  age: number | null;
  primarySpecialty: Specialty | null;
  secondaryKeywords: string[];
  location: string | null;
  modality: string | null;
  insurance: InsuranceCategory; // NEW: Contact's normalized insurance
}

// Scoring constants
const SCORES = {
  BASE: 50,
  PRIMARY_SPECIALTY_MATCH: 30,
  SECONDARY_SPECIALTY_MATCH: 15,
  LOCATION_MATCH: 20,
  MODALITY_MATCH: 10,
  INSURANCE_MATCH: 25, // NEW: Bonus for accepting contact's insurance
  SLOW_PENALTY: -10,
  NO_SPECIALTY_PENALTY: -20,
  MINIMUM_VIABLE: 30,
};

// Map reason keywords to specialties
// Expanded for better matching with detailedReason narratives
const REASON_TO_SPECIALTY: Record<string, Specialty> = {
  // Anxiety spectrum
  "anxiety": "anxiety",
  "anxious": "anxiety",
  "panic": "anxiety",
  "worry": "anxiety",
  "nervous": "anxiety",
  "phobia": "anxiety",
  "ocd": "anxiety",
  "obsessive": "anxiety",

  // Trauma spectrum
  "trauma": "trauma",
  "ptsd": "trauma",
  "traumatic": "trauma",
  "abuse": "trauma",
  "neglect": "trauma",
  "assault": "trauma",

  // Depression spectrum
  "depression": "depression",
  "depressed": "depression",
  "sad": "depression",
  "hopeless": "depression",
  "suicidal": "depression",
  "self-harm": "depression",

  // Grief and loss
  "grief": "grief",
  "loss": "grief",
  "bereavement": "grief",
  "death": "grief",
  "mourning": "grief",
  "dying": "grief",

  // Anger and behavioral
  "anger": "anger_issues",
  "angry": "anger_issues",
  "rage": "anger_issues",
  "tantrums": "anger_issues",
  "outbursts": "anger_issues",
  "acting out": "anger_issues",
  "aggression": "anger_issues",
  "aggressive": "anger_issues",
  "defiant": "anger_issues",
  "oppositional": "anger_issues",

  // Family and parenting
  "family": "family",
  "parenting": "family",
  "custody": "family",
  "divorce": "family",
  "separation": "family",
  "blended": "family",
  "co-parenting": "family",
  "coparenting": "family",
  "sibling": "family",

  // Couples and relationships
  "couples": "couples",
  "relationship": "couples",
  "marriage": "couples",
  "partner": "couples",
  "spouse": "couples",
  "intimacy": "couples",
  "communication": "couples",

  // Stress management
  "stress": "stress_management",
  "overwhelmed": "stress_management",
  "burnout": "stress_management",
  "coping": "stress_management",
  "emotional regulation": "stress_management",
  "dysregulation": "stress_management",
  "self-regulation": "stress_management",
};

// Map city names to provider locations
const CITY_TO_LOCATION: Record<string, ProviderLocation> = {
  "albuquerque": "ABQ",
  "abq": "ABQ",
  "los lunas": "LL",
  "loslunas": "LL",
  "rio rancho": "RR",
  "riorancho": "RR",
};

/**
 * Calculate age from date of birth
 */
function calculateAge(dob: string | null | undefined): number | null {
  if (!dob) return null;

  try {
    const birthDate = new Date(dob);
    if (isNaN(birthDate.getTime())) return null;

    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }

    return age >= 0 ? age : null;
  } catch {
    return null;
  }
}

/**
 * Determine age group from age
 */
function getAgeGroup(age: number | null): AgeGroup | null {
  if (age === null) return null;
  if (age >= 18) return "adults";
  if (age >= 12) return "adolescents";
  if (age >= 6) return "children_6_11";
  if (age >= 0) return "children_0_5";
  return null;
}

/**
 * Parse requesting_for field to infer age group
 */
export function inferAgeGroupFromRequestingFor(requestingFor: string | null | undefined): AgeGroup | null {
  if (!requestingFor) return null;
  const lower = requestingFor.toLowerCase();

  if (lower.includes("child") || lower.includes("son") || lower.includes("daughter")) {
    // Could be any child age group, default to children_6_11
    return "children_6_11";
  }
  if (lower.includes("teen") || lower.includes("adolescent")) {
    return "adolescents";
  }
  if (lower.includes("self") || lower.includes("myself")) {
    return "adults";
  }
  if (lower.includes("family")) {
    return "adults"; // Family therapy typically involves adults
  }

  return null;
}

/**
 * Extract primary specialty from reason for seeking
 */
export function extractPrimarySpecialty(reason: string | null | undefined): Specialty | null {
  if (!reason) return null;
  const lower = reason.toLowerCase();

  for (const [keyword, specialty] of Object.entries(REASON_TO_SPECIALTY)) {
    if (lower.includes(keyword)) {
      return specialty;
    }
  }

  return null;
}

/**
 * Extract secondary keywords from reason
 */
export function extractSecondaryKeywords(reason: string | null | undefined): string[] {
  if (!reason) return [];

  const keywords: string[] = [];
  const lower = reason.toLowerCase();

  // Check for common additional specialties
  const additionalKeywords = [
    "adhd", "add", "attention",
    "bipolar", "bi-polar",
    "emdr",
    "christian", "faith",
    "eating", "anorexia", "bulimia",
    "substance", "addiction", "drug", "alcohol",
    "lgbtq", "gay", "lesbian", "transgender",
    "military", "veteran",
    "conduct", "behavioral",
    "neurodevelopmental", "autism", "asd",
  ];

  for (const keyword of additionalKeywords) {
    if (lower.includes(keyword)) {
      keywords.push(keyword);
    }
  }

  return keywords;
}

/**
 * Map city to provider location
 */
export function mapCityToLocation(city: string | null | undefined): ProviderLocation | null {
  if (!city) return null;
  const lower = city.toLowerCase().trim();

  for (const [cityName, location] of Object.entries(CITY_TO_LOCATION)) {
    if (lower.includes(cityName)) {
      return location;
    }
  }

  return null;
}

/**
 * Build matching context from contact data
 */
export function buildMatchingContext(contact: ContactSnapshot): MatchingContext {
  const age = calculateAge(contact.patientDob);
  let ageGroup = getAgeGroup(age);

  // If no DOB, try to infer from requestingFor
  if (!ageGroup) {
    ageGroup = inferAgeGroupFromRequestingFor(contact.requestingFor);
  }

  // Precedence for specialty extraction:
  // 1. reasonForTherapy - MCQ field from intake form (e.g., "Anxiety, Stress")
  // 2. detailedReason - clinical narrative (INTERNAL - not displayed in UI)
  // 3. reasonForSeeking - free text reason
  // 4. serviceRequested - legacy field
  let primarySpecialty = extractPrimarySpecialty(contact.reasonForTherapy);
  if (!primarySpecialty) {
    primarySpecialty = extractPrimarySpecialty(contact.detailedReason);
  }
  if (!primarySpecialty) {
    primarySpecialty = extractPrimarySpecialty(contact.reasonForSeeking);
  }
  if (!primarySpecialty) {
    primarySpecialty = extractPrimarySpecialty(contact.serviceRequested);
  }

  // Combine keywords from all reason fields (deduplicated)
  const secondaryKeywords = [
    ...extractSecondaryKeywords(contact.reasonForTherapy),
    ...extractSecondaryKeywords(contact.detailedReason),
    ...extractSecondaryKeywords(contact.reasonForSeeking),
  ].filter((v, i, a) => a.indexOf(v) === i);
  const location = mapCityToLocation(contact.city);

  // Normalize contact's insurance payer
  const insurance = normalizeInsurance(contact.insurancePayer);

  return {
    ageGroup,
    age,
    primarySpecialty,
    secondaryKeywords,
    location: contact.city || null,
    modality: contact.modality || null,
    insurance,
  };
}

/**
 * Check if provider serves the given age group
 */
function providerServesAgeGroup(provider: Provider, ageGroup: AgeGroup): boolean {
  return provider.ageGroups.some((ag) => ag.ageGroup === ageGroup);
}

/**
 * Get provider's capability for a specialty in an age group
 */
function getSpecialtyCapability(
  provider: Provider,
  ageGroup: AgeGroup,
  specialty: Specialty
): CapabilityLevel {
  const ageGroupData = provider.ageGroups.find((ag) => ag.ageGroup === ageGroup);
  if (!ageGroupData) return "none";

  const specialtyData = ageGroupData.specialties.find((s) => s.specialty === specialty);
  return specialtyData?.level || "none";
}

/**
 * Check if provider has additional specialty keywords
 */
function hasAdditionalSpecialty(provider: Provider, keywords: string[]): boolean {
  const providerSpecialties = provider.additionalSpecialties.map((s) => s.toLowerCase());

  for (const keyword of keywords) {
    for (const specialty of providerSpecialties) {
      if (specialty.includes(keyword)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Capacity-aware "accepting new patients" check, derived from
 * provider_availability via the GET /api/providers merge.
 *
 *   - acceptingClients undefined → no submission yet, fall through (everyone
 *     passes the filter). Preserves pre-form matching behavior so providers
 *     without a row aren't silently filtered out.
 *   - acceptingClients === 0     → provider has explicitly closed capacity, fail.
 *   - acceptingClients > 0       → provider has open capacity, pass.
 *
 * Phase 2 v1: single integer; supervision/pace from SkillEntry annotations
 * (Phase 1) do NOT affect scoring yet. Lane will revisit.
 */
export function isAcceptingByCapacity(provider: Provider | ProviderWithInsurance): boolean {
  const n = provider.acceptingClients;
  if (typeof n !== "number") return true; // no data → fall through
  return n > 0;
}

/**
 * Compute match score for a single provider
 * @param provider - Provider to score (may include acceptedInsurances)
 * @param context - Matching context derived from contact
 * @param strictInsurance - If true, filter out providers that don't accept insurance
 */
export function computeProviderScore(
  provider: Provider | ProviderWithInsurance,
  context: MatchingContext,
  strictInsurance: boolean = false
): ProviderMatch | null {
  const reasons: MatchReason[] = [];
  const warnings: string[] = [];
  let score = SCORES.BASE;
  let hasSlowMarker = false;

  // Hard constraint: Must be accepting new patients (legacy boolean —
  // historical placeholder, always true today; left in place as belt-and-
  // -suspenders against future data sources that set it to false).
  if (!provider.acceptingNewPatients) {
    return null;
  }

  // Hard constraint: Capacity-aware acceptance check from provider_availability.
  // See isAcceptingByCapacity() above for the no-data fall-through semantics.
  if (!isAcceptingByCapacity(provider)) {
    return null;
  }

  // Hard constraint: Must serve age group (if known)
  if (context.ageGroup) {
    if (!providerServesAgeGroup(provider, context.ageGroup)) {
      return null;
    }
    reasons.push({
      type: "positive",
      text: `Serves ${AGE_GROUP_LABELS[context.ageGroup]}`,
    });
  } else {
    warnings.push("Age unknown - showing all providers");
  }

  // Insurance matching (v1.1)
  // Check if provider has insurance data (only ProviderWithInsurance has this field)
  const providerWithIns = provider as ProviderWithInsurance;
  const hasInsuranceData = providerWithIns.acceptedInsurances && providerWithIns.acceptedInsurances.length > 0;

  if (context.insurance !== "Unknown" && hasInsuranceData) {
    const accepts = providerAcceptsInsurance(providerWithIns.acceptedInsurances, context.insurance);

    if (strictInsurance && !accepts) {
      // In strict mode, filter out providers that don't accept the insurance
      return null;
    }

    if (accepts) {
      score += SCORES.INSURANCE_MATCH;
      reasons.push({
        type: "positive",
        text: `Accepts ${context.insurance}`,
      });
    } else {
      // Non-strict mode: show warning but don't filter
      reasons.push({
        type: "warning",
        text: `May not accept ${context.insurance}`,
      });
    }
  } else if (context.insurance !== "Unknown" && !hasInsuranceData) {
    // Provider has no insurance data — can't confirm or deny coverage
    reasons.push({
      type: "warning",
      text: `Insurance data missing — verify ${context.insurance} coverage`,
    });
  } else if (context.insurance === "Unknown") {
    warnings.push("Insurance unknown - verify coverage before scheduling");
  }

  // Primary specialty match
  if (context.primarySpecialty && context.ageGroup) {
    const capability = getSpecialtyCapability(provider, context.ageGroup, context.primarySpecialty);

    if (capability === "full") {
      score += SCORES.PRIMARY_SPECIALTY_MATCH;
      reasons.push({
        type: "positive",
        text: `${SPECIALTY_LABELS[context.primarySpecialty]} specialist`,
      });
    } else if (capability === "slow") {
      score += SCORES.PRIMARY_SPECIALTY_MATCH + SCORES.SLOW_PENALTY;
      hasSlowMarker = true;
      reasons.push({
        type: "warning",
        text: `${SPECIALTY_LABELS[context.primarySpecialty]} (limited availability)`,
      });
    } else {
      // No specialty match
      score += SCORES.NO_SPECIALTY_PENALTY;
      reasons.push({
        type: "neutral",
        text: `No ${SPECIALTY_LABELS[context.primarySpecialty]} specialty listed`,
      });
    }
  } else if (!context.primarySpecialty) {
    warnings.push("No specific concern identified from intake");
  }

  // Secondary specialty match (from Notes column)
  if (context.secondaryKeywords.length > 0) {
    if (hasAdditionalSpecialty(provider, context.secondaryKeywords)) {
      score += SCORES.SECONDARY_SPECIALTY_MATCH;
      reasons.push({
        type: "positive",
        text: "Additional relevant experience",
      });
    }
  }

  // Location match
  if (context.location) {
    const providerLocation = mapCityToLocation(context.location);
    if (providerLocation && provider.location === providerLocation) {
      score += SCORES.LOCATION_MATCH;
      reasons.push({
        type: "positive",
        text: `${LOCATION_LABELS[provider.location]} location`,
      });
    }
  }

  // Modality match (v1: assume all support telehealth, in-person depends on location)
  if (context.modality?.toLowerCase().includes("in-person")) {
    // In-person preference - location matters more
    if (context.location) {
      const providerLocation = mapCityToLocation(context.location);
      if (providerLocation && provider.location === providerLocation) {
        score += SCORES.MODALITY_MATCH;
      }
    }
  } else {
    // Telehealth - all providers can do this
    score += SCORES.MODALITY_MATCH;
    reasons.push({
      type: "positive",
      text: "Telehealth available",
    });
  }

  // Determine tier based on score (updated thresholds for insurance)
  let tier: ProviderMatch["tier"];
  if (score >= 100) {
    tier = "excellent";
  } else if (score >= 75) {
    tier = "good";
  } else if (score >= 50) {
    tier = "fair";
  } else {
    tier = "poor";
  }

  return {
    provider,
    score,
    tier,
    reasons,
    warnings,
  };
}

/**
 * Compute provider matches for a contact
 * @param contact - Contact snapshot from the waitlist
 * @param providers - Array of providers (from API via useProviders hook)
 */
export function computeProviderMatches(
  contact: ContactSnapshot,
  providers: (Provider | ProviderWithInsurance)[]
): {
  matches: ProviderMatch[];
  context: MatchingContext;
  warnings: string[];
} {
  const context = buildMatchingContext(contact);
  const globalWarnings: string[] = [];

  // Guard: providers must be a valid, non-empty array.
  // No silent fallback to stale hardcoded data — surface the problem.
  if (!Array.isArray(providers) || providers.length === 0) {
    return {
      matches: [],
      context,
      warnings: ["Provider data unavailable — please refresh and try again"],
    };
  }

  // HARD CONSTRAINT: If contact has a known insurance that TFC doesn't accept,
  // return no matches immediately. This is a clinic-level constraint.
  if (context.insurance !== "Unknown" && !isInsuranceAcceptedByTFC(context.insurance)) {
    return {
      matches: [],
      context,
      warnings: [`Insurance "${context.insurance}" is not accepted by TFC`],
    };
  }

  const providerList = providers;

  // Check if any providers have insurance data
  const anyProviderHasInsurance = providerList.some(
    (p) => (p as ProviderWithInsurance).acceptedInsurances?.length > 0
  );

  // Add context-level warnings
  if (!context.ageGroup) {
    globalWarnings.push("Unable to determine age group from intake data");
  }
  // Only show "no primary concern" warning if NO specialty source exists
  // detailedReason is the primary source - if it exists, we have data to work with
  const hasSpecialtySource = !!(contact.detailedReason || contact.reasonForSeeking || contact.serviceRequested);
  if (!context.primarySpecialty && !hasSpecialtySource) {
    globalWarnings.push("Unable to identify primary concern from intake data");
  }

  // Score all providers
  // First pass: strict insurance matching (if contact has known insurance and providers have data)
  const useStrictInsurance = context.insurance !== "Unknown" && anyProviderHasInsurance;
  let scoredProviders: ProviderMatch[] = [];

  for (const provider of providerList) {
    const match = computeProviderScore(provider, context, useStrictInsurance);
    if (match) {
      // Collect warnings from individual matches
      if (match.warnings.length > 0) {
        for (const warning of match.warnings) {
          if (!globalWarnings.includes(warning)) {
            globalWarnings.push(warning);
          }
        }
      }
      scoredProviders.push(match);
    }
  }

  // Fallback: If strict insurance matching yielded no results, try without insurance filter
  if (scoredProviders.length === 0 && useStrictInsurance) {
    globalWarnings.push(`No providers accept ${context.insurance} - showing best matches`);

    for (const provider of providerList) {
      const match = computeProviderScore(provider, context, false);
      if (match) {
        // Collect warnings from individual matches
        if (match.warnings.length > 0) {
          for (const warning of match.warnings) {
            if (!globalWarnings.includes(warning)) {
              globalWarnings.push(warning);
            }
          }
        }
        scoredProviders.push(match);
      }
    }
  }

  // Sort by score (descending), then by presence of slow/warning markers, then alphabetically
  scoredProviders.sort((a, b) => {
    // First by score
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    // Then prefer providers without warnings (slow markers, insurance issues)
    const aHasWarning = a.reasons.some((r) => r.type === "warning");
    const bHasWarning = b.reasons.some((r) => r.type === "warning");
    if (aHasWarning !== bHasWarning) {
      return aHasWarning ? 1 : -1;
    }

    // Finally alphabetically
    return a.provider.name.localeCompare(b.provider.name);
  });

  // Filter out very poor matches unless we have few results
  let matches = scoredProviders.filter((m) => m.score >= SCORES.MINIMUM_VIABLE);

  // If no good matches, include top 3 poor matches
  if (matches.length === 0 && scoredProviders.length > 0) {
    matches = scoredProviders.slice(0, 3);
    globalWarnings.push("No strong matches found - showing best available options");
  }

  return {
    matches,
    context,
    warnings: globalWarnings,
  };
}

/**
 * Format context for display
 */
export function formatContextSummary(context: MatchingContext): string {
  const parts: string[] = [];

  if (context.primarySpecialty) {
    parts.push(SPECIALTY_LABELS[context.primarySpecialty]);
  }

  if (context.ageGroup) {
    if (context.age !== null) {
      parts.push(`Age ${context.age}`);
    } else {
      parts.push(AGE_GROUP_LABELS[context.ageGroup]);
    }
  }

  if (context.modality) {
    parts.push(context.modality);
  }

  if (context.location) {
    parts.push(context.location);
  }

  return parts.join(" · ") || "No intake data available";
}
