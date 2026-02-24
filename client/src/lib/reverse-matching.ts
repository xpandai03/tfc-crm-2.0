/**
 * Reverse Matching — Provider → Patient
 *
 * Given a provider, finds and ranks active waitlist contacts
 * that are compatible. Reuses computeProviderScore() with zero
 * algorithm duplication.
 */

import {
  computeProviderScore,
  inferAgeGroupFromRequestingFor,
  extractPrimarySpecialty,
  extractSecondaryKeywords,
  mapCityToLocation,
  type MatchingContext,
  type MatchReason,
} from "./provider-matching";
import { normalizeInsurance } from "./insurance-utils";
import { isActiveStatus } from "./status-config";
import type { ProviderWithInsurance } from "./provider-api";
import type { WaitlistContact } from "@shared/schema";

export interface PatientMatch {
  contact: WaitlistContact;
  score: number;
  tier: "excellent" | "good" | "fair" | "poor";
  reasons: MatchReason[];
  warnings: string[];
}

export interface PatientMatchResult {
  matches: PatientMatch[];
  warnings: string[];
}

/**
 * Extract city name from modality string.
 * "In Person - Albuquerque" → "Albuquerque"
 * "In Person - Rio Rancho"  → "Rio Rancho"
 * "Telehealth" / null       → null
 */
function extractLocationFromModality(modality: string | null | undefined): string | null {
  if (!modality) return null;
  if (modality.toLowerCase().includes("telehealth")) return null;

  // Match "In Person - <City>" or "In Person-<City>" (dash/en-dash/em-dash)
  const match = modality.match(/[-–—]\s*(.+)$/);
  return match ? match[1].trim() : null;
}

/**
 * Build a MatchingContext from a WaitlistContact.
 * Maps the lighter WaitlistContact fields to the same context
 * structure that computeProviderScore expects.
 */
export function buildMatchingContextFromWaitlistContact(
  contact: WaitlistContact
): MatchingContext {
  const reasonString = contact.reasonForTherapy?.join(", ") || null;

  return {
    ageGroup: inferAgeGroupFromRequestingFor(contact.serviceRequested),
    age: null,
    primarySpecialty: extractPrimarySpecialty(reasonString),
    secondaryKeywords: extractSecondaryKeywords(reasonString),
    location: extractLocationFromModality(contact.modality),
    modality: contact.modality || null,
    insurance: normalizeInsurance(contact.insurancePayer),
  };
}

/**
 * Score all active waitlist contacts against a single provider.
 * Returns up to 25 results sorted by score desc, then days waiting desc,
 * then unassigned contacts first.
 */
export function computePatientMatches(
  provider: ProviderWithInsurance,
  contacts: WaitlistContact[]
): PatientMatchResult {
  const globalWarnings: string[] = [];
  const results: PatientMatch[] = [];

  // Use same strictInsurance logic as forward matching:
  // strict only when provider has per-provider insurance data
  const providerHasInsurance = provider.acceptedInsurances?.length > 0;

  for (const contact of contacts) {
    // Only score active contacts
    if (!isActiveStatus(contact.statusCode)) continue;

    const context = buildMatchingContextFromWaitlistContact(contact);

    // Hard constraint: In-person patients must match provider's location
    if (context.location) {
      const contactLocation = mapCityToLocation(context.location);
      if (contactLocation && contactLocation !== provider.location) continue;
    }

    const useStrict = context.insurance !== "Unknown" && providerHasInsurance;
    const match = computeProviderScore(provider, context, useStrict);

    if (!match) continue;

    // Determine tier
    let tier: PatientMatch["tier"];
    if (match.score >= 100) tier = "excellent";
    else if (match.score >= 75) tier = "good";
    else if (match.score >= 50) tier = "fair";
    else tier = "poor";

    results.push({
      contact,
      score: match.score,
      tier,
      reasons: match.reasons,
      warnings: match.warnings,
    });

    // Collect unique warnings
    for (const w of match.warnings) {
      if (!globalWarnings.includes(w)) globalWarnings.push(w);
    }
  }

  // Sort: score desc → daysOnWaitlist desc → unassigned first
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.contact.daysOnWaitlist !== a.contact.daysOnWaitlist)
      return b.contact.daysOnWaitlist - a.contact.daysOnWaitlist;
    const aAssigned = a.contact.assignedTo ? 1 : 0;
    const bAssigned = b.contact.assignedTo ? 1 : 0;
    return aAssigned - bAssigned;
  });

  return {
    matches: results.slice(0, 25),
    warnings: globalWarnings,
  };
}
