/**
 * Modality Utilities (shared)
 *
 * Lifted verbatim from the Insights page implementation
 * (client/src/pages/insights.tsx) so the server referral report builder can call
 * the SAME normalizer as the Insights breakdown, with byte-identical logic.
 *
 * NOTE ON DUPLICATION: there is a second, independently-maintained
 * normalizeModality copy in
 * client/src/components/waitlist/waitlist-list-view.tsx (the waitlist modality
 * filter) and a *different* one in client/src/lib/provider-matching-v2.ts
 * (returns a matching-context enum, not a category string). Those were left
 * untouched in this build — see the follow-up consolidation PR (D-C2 from the
 * Insights cleanup audit). Do not merge them without re-checking the waitlist
 * filter behavior.
 *
 * Modality normalization mapping (raw values → canonical categories)
 * Maps form options and historical values to display categories
 */
export const MODALITY_NORMALIZATION_MAP: Record<string, string> = {
  // Hybrid
  "hybrid": "Hybrid",
  "hybrid - ll": "Hybrid",

  // In Person - Albuquerque (ABQ)
  "in person - albuquerque": "In Person ABQ",
  "in person-abq": "In Person ABQ",
  "in person abq": "In Person ABQ",
  "in person- albuquerque": "In Person ABQ",
  "in person - abq": "In Person ABQ",
  "abq": "In Person ABQ",
  "albuquerque": "In Person ABQ",

  // In Person - Rio Rancho (RR)
  "in person - rio rancho": "In Person RR",
  "in person-rio rancho": "In Person RR",
  "in person- rio rancho": "In Person RR",
  "in person - rr": "In Person RR",
  "in person rr": "In Person RR",
  "rio rancho": "In Person RR",

  // In Person - Los Lunas (LL) — split out from generic "In Person" per
  // Insights cleanup Bucket C. Previously rolled into the generic bucket
  // which hid ~118 LL contacts from Amanda's modality breakdown.
  "in person - los lunas": "In Person LL",
  "in person- los lunas": "In Person LL",
  "in person los lunas": "In Person LL",
  "in-person los lunas": "In Person LL",
  "in person ll": "In Person LL",
  "los lunas": "In Person LL",
  "ll": "In Person LL",

  // In Person (generic - combined options, and old values without location)
  "in person": "In Person",
  "in person - albuquerque or rio rancho": "In Person",
  "in person- albuquerque or rio rancho": "In Person",
  "in-person": "In Person",

  // Telehealth
  "telehealth": "Telehealth",
  "th": "Telehealth",
  "tele-health": "Telehealth",
  "tele health": "Telehealth",

  // Flexible/Flex
  "flexible (open to any option)": "Flex",
  "flexible (open to any option).": "Flex",
  "flexible": "Flex",
  "flex": "Flex",
  "open to any option": "Flex",
};

/**
 * Normalize modality to canonical category
 * Pure function: no side effects, deterministic
 * Returns "Unknown" for unmapped values
 */
export function normalizeModality(rawValue: string | null | undefined): string {
  if (!rawValue) return "Unknown";
  const trimmed = rawValue.trim();
  if (!trimmed) return "Unknown";
  const normalized = trimmed.toLowerCase();
  return MODALITY_NORMALIZATION_MAP[normalized] || "Unknown";
}
