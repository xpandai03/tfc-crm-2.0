/**
 * Provider Matching Algorithm v2
 *
 * Improved matching for CRM 2.0 structured intake data.
 * Key differences from v1:
 *   - Multi-specialty scoring with decay (no single-keyword-wins bias)
 *   - Direct MCQ value parsing (no free-text keyword scanning)
 *   - Nearby location matching (not limited to 3 exact cities)
 *   - No penalty for unmatched specialties (decay handles ranking naturally)
 *
 * This file runs ALONGSIDE v1 for comparison. It does NOT replace v1.
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
import type { ProviderMatch, MatchReason } from "./provider-matching";

// ============================================================================
// v2 Matching Context
// ============================================================================

export interface MatchingContextV2 {
  age: number | null;
  ageGroup: AgeGroup | null;
  specialties: Specialty[];
  secondaryKeywords: string[];
  insurance: InsuranceCategory;
  location: ProviderLocation | null;
  rawCity: string | null;
  modality: "in-person" | "telehealth" | "hybrid" | null;
}

// ============================================================================
// v2 Scoring Constants
// ============================================================================

const SCORES_V2 = {
  BASE: 50,
  SPECIALTY_WEIGHT: 30,
  SPECIALTY_DECAY: 0.65,
  SLOW_PENALTY: -10,
  SECONDARY_MATCH: 15,
  INSURANCE_MATCH: 25,
  LOCATION_EXACT: 20,
  LOCATION_NEARBY: 10,
  MODALITY_MATCH: 10,
  MODALITY_NEARBY: 5,
  MINIMUM_VIABLE: 30,
};

// v2 tier thresholds (adjusted for higher score ceiling)
const TIER_THRESHOLDS = {
  EXCELLENT: 120,
  GOOD: 85,
  FAIR: 55,
};

// ============================================================================
// MCQ Value → Specialty Mapping
// ============================================================================

const MCQ_TO_SPECIALTY: Record<string, Specialty> = {
  "anxiety": "anxiety",
  "trauma": "trauma",
  "depression": "depression",
  "grief": "grief",
  "loss": "grief",
  "anger": "anger_issues",
  "anger issues": "anger_issues",
  "behavioral issues": "anger_issues",
  "behavioral": "anger_issues",
  "family": "family",
  "family conflict": "family",
  "parenting": "family",
  "custody": "family",
  "divorce": "family",
  "couples": "couples",
  "relationship": "couples",
  "marriage": "couples",
  "stress": "stress_management",
  "stress management": "stress_management",
  "coping": "stress_management",
  "emotional regulation": "stress_management",
};

// ============================================================================
// Location Regions (expanded beyond 3 cities)
// ============================================================================

interface LocationRegion {
  exact: string[];
  nearby: string[];
}

const LOCATION_REGIONS: Record<ProviderLocation, LocationRegion> = {
  ABQ: {
    exact: ["albuquerque", "abq"],
    nearby: [
      "corrales", "bernalillo", "edgewood", "tijeras", "cedar crest",
      "placitas", "bosque farms", "peralta", "santa fe", "moriarty",
    ],
  },
  LL: {
    exact: ["los lunas", "loslunas"],
    nearby: ["belen", "bosque farms", "peralta", "socorro", "tome"],
  },
  RR: {
    exact: ["rio rancho", "riorancho"],
    nearby: ["corrales", "bernalillo", "placitas"],
  },
};

// Secondary keywords (same as v1 — these cover specialties outside the primary 8)
const ADDITIONAL_KEYWORDS = [
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

// ============================================================================
// Context Construction
// ============================================================================

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

function getAgeGroup(age: number | null): AgeGroup | null {
  if (age === null) return null;
  if (age >= 18) return "adults";
  if (age >= 12) return "adolescents";
  if (age >= 6) return "children_6_11";
  if (age >= 0) return "children_0_5";
  return null;
}

/**
 * Parse MCQ comma-separated values into an ordered array of specialties.
 * Returns ALL matched specialties, preserving order from the MCQ input.
 */
function parseSpecialtiesFromMCQ(reasonForTherapy: string | null | undefined): Specialty[] {
  if (!reasonForTherapy) return [];

  const parts = reasonForTherapy.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const seen = new Set<Specialty>();
  const result: Specialty[] = [];

  for (const part of parts) {
    const specialty = MCQ_TO_SPECIALTY[part];
    if (specialty && !seen.has(specialty)) {
      seen.add(specialty);
      result.push(specialty);
    }
  }

  // If no MCQ values matched directly, fall back to substring scanning
  // (handles legacy data or non-standard values)
  if (result.length === 0) {
    const lower = reasonForTherapy.toLowerCase();
    for (const [keyword, specialty] of Object.entries(MCQ_TO_SPECIALTY)) {
      if (lower.includes(keyword) && !seen.has(specialty)) {
        seen.add(specialty);
        result.push(specialty);
      }
    }
  }

  return result;
}

function extractSecondaryKeywordsV2(reasonForTherapy: string | null | undefined): string[] {
  if (!reasonForTherapy) return [];
  const lower = reasonForTherapy.toLowerCase();
  return ADDITIONAL_KEYWORDS.filter((kw) => lower.includes(kw));
}

/**
 * Map a city to an exact provider location.
 */
function mapCityToRegion(city: string | null | undefined): ProviderLocation | null {
  if (!city) return null;
  const lower = city.toLowerCase().trim();
  for (const [loc, region] of Object.entries(LOCATION_REGIONS) as [ProviderLocation, LocationRegion][]) {
    if (region.exact.some((c) => lower.includes(c))) {
      return loc;
    }
  }
  return null;
}

/**
 * Check if a city is nearby a provider location (not exact, but adjacent).
 */
function isNearbyLocation(city: string | null | undefined, providerLocation: ProviderLocation): boolean {
  if (!city) return false;
  const lower = city.toLowerCase().trim();
  const region = LOCATION_REGIONS[providerLocation];
  return region.nearby.some((c) => lower.includes(c));
}

function normalizeModality(modality: string | null | undefined): MatchingContextV2["modality"] {
  if (!modality) return null;
  const lower = modality.toLowerCase();
  if (lower.includes("hybrid")) return "hybrid";
  if (lower.includes("in-person") || lower.includes("in person")) return "in-person";
  if (lower.includes("telehealth") || lower.includes("virtual")) return "telehealth";
  return null;
}

export function buildMatchingContextV2(contact: ContactSnapshot): MatchingContextV2 {
  const age = calculateAge(contact.patientDob);
  let ageGroup = getAgeGroup(age);

  // Fallback for missing DOB (same heuristic as v1, kept for backward compat)
  if (!ageGroup && contact.requestingFor) {
    const lower = contact.requestingFor.toLowerCase();
    if (lower.includes("child") || lower.includes("son") || lower.includes("daughter")) {
      ageGroup = "children_6_11";
    } else if (lower.includes("teen") || lower.includes("adolescent")) {
      ageGroup = "adolescents";
    } else if (lower.includes("self") || lower.includes("myself") || lower.includes("family")) {
      ageGroup = "adults";
    }
  }

  const specialties = parseSpecialtiesFromMCQ(contact.reasonForTherapy);

  // Secondary keywords from all reason fields (same breadth as v1)
  const secondaryKeywords = [
    ...extractSecondaryKeywordsV2(contact.reasonForTherapy),
    ...extractSecondaryKeywordsV2(contact.detailedReason),
    ...extractSecondaryKeywordsV2(contact.reasonForSeeking),
  ].filter((v, i, a) => a.indexOf(v) === i);

  const insurance = normalizeInsurance(contact.insurancePayer);
  const location = mapCityToRegion(contact.city);
  const modality = normalizeModality(contact.modality);

  return {
    age,
    ageGroup,
    specialties,
    secondaryKeywords,
    insurance,
    location,
    rawCity: contact.city || null,
    modality,
  };
}

// ============================================================================
// v2 Scoring
// ============================================================================

function providerServesAgeGroup(provider: Provider, ageGroup: AgeGroup): boolean {
  return provider.ageGroups.some((ag) => ag.ageGroup === ageGroup);
}

function getSpecialtyCapability(
  provider: Provider,
  ageGroup: AgeGroup,
  specialty: Specialty
): CapabilityLevel {
  const ag = provider.ageGroups.find((g) => g.ageGroup === ageGroup);
  if (!ag) return "none";
  const s = ag.specialties.find((sp) => sp.specialty === specialty);
  return s?.level || "none";
}

function hasAdditionalSpecialty(provider: Provider, keywords: string[]): boolean {
  const providerSpecs = provider.additionalSpecialties.map((s) => s.toLowerCase());
  return keywords.some((kw) => providerSpecs.some((ps) => ps.includes(kw)));
}

export function computeProviderScoreV2(
  provider: Provider | ProviderWithInsurance,
  context: MatchingContextV2,
  strictInsurance: boolean = false
): ProviderMatch | null {
  const reasons: MatchReason[] = [];
  const warnings: string[] = [];
  let score = SCORES_V2.BASE;

  // --- Hard filters ---

  if (!provider.acceptingNewPatients) return null;

  if (context.ageGroup) {
    if (!providerServesAgeGroup(provider, context.ageGroup)) return null;
    reasons.push({ type: "positive", text: `Serves ${AGE_GROUP_LABELS[context.ageGroup]}` });
  } else {
    warnings.push("Age unknown - showing all providers");
  }

  // Insurance
  const providerWithIns = provider as ProviderWithInsurance;
  const hasInsData = providerWithIns.acceptedInsurances && providerWithIns.acceptedInsurances.length > 0;

  if (context.insurance !== "Unknown" && hasInsData) {
    const accepts = providerAcceptsInsurance(providerWithIns.acceptedInsurances, context.insurance);
    if (strictInsurance && !accepts) return null;
    if (accepts) {
      score += SCORES_V2.INSURANCE_MATCH;
      reasons.push({ type: "positive", text: `Accepts ${context.insurance}` });
    } else {
      reasons.push({ type: "warning", text: `May not accept ${context.insurance}` });
    }
  } else if (context.insurance !== "Unknown" && !hasInsData) {
    reasons.push({ type: "warning", text: `Insurance data missing — verify ${context.insurance} coverage` });
  } else if (context.insurance === "Unknown") {
    warnings.push("Insurance unknown - verify coverage before scheduling");
  }

  // --- Multi-specialty scoring (v2 core change) ---

  if (context.specialties.length > 0 && context.ageGroup) {
    let specialtyTotal = 0;
    const specialtyReasons: string[] = [];

    for (let i = 0; i < context.specialties.length; i++) {
      const specialty = context.specialties[i];
      const weight = Math.round(SCORES_V2.SPECIALTY_WEIGHT * Math.pow(SCORES_V2.SPECIALTY_DECAY, i));
      const capability = getSpecialtyCapability(provider, context.ageGroup, specialty);

      if (capability === "full") {
        specialtyTotal += weight;
        specialtyReasons.push(`${SPECIALTY_LABELS[specialty]} specialist`);
      } else if (capability === "slow") {
        specialtyTotal += Math.max(0, weight + SCORES_V2.SLOW_PENALTY);
        specialtyReasons.push(`${SPECIALTY_LABELS[specialty]} (limited)`);
      }
      // "none" → no score change and no penalty (v2 design: decay handles it)
    }

    score += specialtyTotal;

    if (specialtyReasons.length > 0) {
      reasons.push({ type: "positive", text: specialtyReasons.join(", ") });
    } else {
      reasons.push({
        type: "neutral",
        text: `No match for ${context.specialties.map((s) => SPECIALTY_LABELS[s]).join(", ")}`,
      });
    }
  } else if (context.specialties.length === 0) {
    warnings.push("No specific concern identified from intake");
  }

  // Secondary keywords
  if (context.secondaryKeywords.length > 0 && hasAdditionalSpecialty(provider, context.secondaryKeywords)) {
    score += SCORES_V2.SECONDARY_MATCH;
    reasons.push({ type: "positive", text: "Additional relevant experience" });
  }

  // --- Location (v2: exact + nearby) ---

  const exactLocationMatch = context.location !== null && provider.location === context.location;
  const nearbyMatch = !exactLocationMatch && isNearbyLocation(context.rawCity, provider.location);

  if (exactLocationMatch) {
    score += SCORES_V2.LOCATION_EXACT;
    reasons.push({ type: "positive", text: `${LOCATION_LABELS[provider.location]} location` });
  } else if (nearbyMatch) {
    score += SCORES_V2.LOCATION_NEARBY;
    reasons.push({ type: "positive", text: `Near ${LOCATION_LABELS[provider.location]}` });
  }

  // --- Modality (v2: hybrid awareness) ---

  if (context.modality === "telehealth") {
    score += SCORES_V2.MODALITY_MATCH;
    reasons.push({ type: "positive", text: "Telehealth available" });
  } else if (context.modality === "in-person" || context.modality === "hybrid") {
    if (exactLocationMatch) {
      score += SCORES_V2.MODALITY_MATCH;
    } else if (nearbyMatch) {
      score += SCORES_V2.MODALITY_NEARBY;
    }
    if (context.modality === "hybrid") {
      score += SCORES_V2.MODALITY_NEARBY;
      reasons.push({ type: "positive", text: "Telehealth + in-person" });
    }
  } else {
    // null modality → assume telehealth OK (same as v1)
    score += SCORES_V2.MODALITY_MATCH;
    reasons.push({ type: "positive", text: "Telehealth available" });
  }

  // --- Tier ---

  let tier: ProviderMatch["tier"];
  if (score >= TIER_THRESHOLDS.EXCELLENT) tier = "excellent";
  else if (score >= TIER_THRESHOLDS.GOOD) tier = "good";
  else if (score >= TIER_THRESHOLDS.FAIR) tier = "fair";
  else tier = "poor";

  return { provider, score, tier, reasons, warnings };
}

// ============================================================================
// v2 Orchestration
// ============================================================================

export function computeProviderMatchesV2(
  contact: ContactSnapshot,
  providers: (Provider | ProviderWithInsurance)[]
): {
  matches: ProviderMatch[];
  context: MatchingContextV2;
  warnings: string[];
} {
  const context = buildMatchingContextV2(contact);
  const globalWarnings: string[] = [];

  if (!Array.isArray(providers) || providers.length === 0) {
    return { matches: [], context, warnings: ["Provider data unavailable"] };
  }

  if (context.insurance !== "Unknown" && !isInsuranceAcceptedByTFC(context.insurance)) {
    return { matches: [], context, warnings: [`Insurance "${context.insurance}" is not accepted by TFC`] };
  }

  if (!context.ageGroup) globalWarnings.push("Unable to determine age group from intake data");
  if (context.specialties.length === 0) globalWarnings.push("Unable to identify concerns from intake data");

  // Two-pass: strict insurance first, fallback if 0 results
  const anyHasIns = providers.some((p) => ((p as ProviderWithInsurance).acceptedInsurances?.length ?? 0) > 0);
  const useStrict = context.insurance !== "Unknown" && anyHasIns;
  let scored: ProviderMatch[] = [];

  for (const p of providers) {
    const m = computeProviderScoreV2(p, context, useStrict);
    if (m) {
      for (const w of m.warnings) {
        if (!globalWarnings.includes(w)) globalWarnings.push(w);
      }
      scored.push(m);
    }
  }

  if (scored.length === 0 && useStrict) {
    globalWarnings.push(`No providers accept ${context.insurance} - showing best matches`);
    for (const p of providers) {
      const m = computeProviderScoreV2(p, context, false);
      if (m) {
        for (const w of m.warnings) {
          if (!globalWarnings.includes(w)) globalWarnings.push(w);
        }
        scored.push(m);
      }
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aw = a.reasons.some((r) => r.type === "warning");
    const bw = b.reasons.some((r) => r.type === "warning");
    if (aw !== bw) return aw ? 1 : -1;
    return a.provider.name.localeCompare(b.provider.name);
  });

  let matches = scored.filter((m) => m.score >= SCORES_V2.MINIMUM_VIABLE);
  if (matches.length === 0 && scored.length > 0) {
    matches = scored.slice(0, 3);
    globalWarnings.push("No strong matches found - showing best available options");
  }

  return { matches, context, warnings: globalWarnings };
}

// ============================================================================
// v2 Context Summary (for debug display)
// ============================================================================

export function formatContextSummaryV2(context: MatchingContextV2): string {
  const parts: string[] = [];

  if (context.specialties.length > 0) {
    parts.push(context.specialties.map((s) => SPECIALTY_LABELS[s]).join(", "));
  }

  if (context.ageGroup) {
    parts.push(context.age !== null ? `Age ${context.age}` : AGE_GROUP_LABELS[context.ageGroup]);
  }

  if (context.modality) {
    const labels: Record<string, string> = {
      "in-person": "In-Person",
      "telehealth": "Telehealth",
      "hybrid": "Hybrid",
    };
    parts.push(labels[context.modality] || context.modality);
  }

  if (context.rawCity) parts.push(context.rawCity);

  return parts.join(" · ") || "No intake data available";
}
