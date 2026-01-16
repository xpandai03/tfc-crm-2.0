/**
 * Provider Matching Algorithm
 *
 * Computes compatibility scores between a contact and providers.
 * All matching is deterministic and rule-based.
 */

import {
  PROVIDERS,
  Provider,
  AgeGroup,
  Specialty,
  CapabilityLevel,
  ProviderLocation,
  AGE_GROUP_LABELS,
  SPECIALTY_LABELS,
  LOCATION_LABELS,
} from "./providers";
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
}

// Scoring constants
const SCORES = {
  BASE: 50,
  PRIMARY_SPECIALTY_MATCH: 30,
  SECONDARY_SPECIALTY_MATCH: 15,
  LOCATION_MATCH: 20,
  MODALITY_MATCH: 10,
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
function inferAgeGroupFromRequestingFor(requestingFor: string | null | undefined): AgeGroup | null {
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
function extractPrimarySpecialty(reason: string | null | undefined): Specialty | null {
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
function extractSecondaryKeywords(reason: string | null | undefined): string[] {
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
function mapCityToLocation(city: string | null | undefined): ProviderLocation | null {
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

  // Precedence: detailedReason → reasonForSeeking → serviceRequested
  // detailedReason is the primary clinical narrative (INTERNAL - not displayed in UI)
  let primarySpecialty = extractPrimarySpecialty(contact.detailedReason);
  if (!primarySpecialty) {
    primarySpecialty = extractPrimarySpecialty(contact.reasonForSeeking);
  }
  if (!primarySpecialty) {
    primarySpecialty = extractPrimarySpecialty(contact.serviceRequested);
  }

  // Combine keywords from detailedReason and reasonForSeeking (deduplicated)
  const secondaryKeywords = [
    ...extractSecondaryKeywords(contact.detailedReason),
    ...extractSecondaryKeywords(contact.reasonForSeeking),
  ].filter((v, i, a) => a.indexOf(v) === i);
  const location = mapCityToLocation(contact.city);

  return {
    ageGroup,
    age,
    primarySpecialty,
    secondaryKeywords,
    location: contact.city || null,
    modality: contact.modality || null,
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
 * Compute match score for a single provider
 */
function computeProviderScore(
  provider: Provider,
  context: MatchingContext
): ProviderMatch | null {
  const reasons: MatchReason[] = [];
  const warnings: string[] = [];
  let score = SCORES.BASE;
  let hasSlowMarker = false;

  // Hard constraint: Must be accepting new patients
  if (!provider.acceptingNewPatients) {
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

  // Determine tier based on score
  let tier: ProviderMatch["tier"];
  if (score >= 90) {
    tier = "excellent";
  } else if (score >= 70) {
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
 */
export function computeProviderMatches(contact: ContactSnapshot): {
  matches: ProviderMatch[];
  context: MatchingContext;
  warnings: string[];
} {
  const context = buildMatchingContext(contact);
  const globalWarnings: string[] = [];

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
  const scoredProviders: ProviderMatch[] = [];

  for (const provider of PROVIDERS) {
    const match = computeProviderScore(provider, context);
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

  // Sort by score (descending), then by presence of slow markers, then alphabetically
  scoredProviders.sort((a, b) => {
    // First by score
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    // Then prefer non-slow providers
    const aHasSlow = a.reasons.some((r) => r.type === "warning");
    const bHasSlow = b.reasons.some((r) => r.type === "warning");
    if (aHasSlow !== bHasSlow) {
      return aHasSlow ? 1 : -1;
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
