/**
 * Modality Utilities (shared)
 *
 * Lifted verbatim from the Insights page implementation
 * (client/src/pages/insights.tsx) so the server referral report builder can call
 * the SAME normalizer as the Insights breakdown, with byte-identical logic.
 *
 * NOTE ON DUPLICATION: the waitlist list-view copy
 * (client/src/components/waitlist/waitlist-list-view.tsx) and the kanban card
 * copy (client/src/components/kanban/draggable-card.tsx) were consolidated onto
 * this module. Two copies remain and are intentionally NOT merged:
 *   - client/src/lib/provider-matching-v2.ts — returns a matching-context enum,
 *     not a category string. Clinical matching logic; do not touch.
 *   - client/src/components/ui/priority-card.tsx — substring-based display
 *     formatter, same shape as the old draggable-card copy.
 *
 * MULTI-VALUE MODALITY
 * --------------------
 * Modality is stored as a single free-text column that carries MULTIPLE
 * selections comma-joined (e.g. "In Person - Albuquerque, Telehealth"). The
 * original whole-string lookup could never match a comma-joined value, so every
 * multi-select fell into the "Unknown" bucket. normalizeModalityTokens() splits
 * first and normalizes each token, which is what actually resolves those rows.
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
  // Formatting variants observed in production (Deploy 1).
  "in-person albuquerque": "In Person ABQ",
  "in - person abq": "In Person ABQ",

  // In Person - Rio Rancho (RR)
  "in person - rio rancho": "In Person RR",
  "in person-rio rancho": "In Person RR",
  "in person- rio rancho": "In Person RR",
  "in person - rr": "In Person RR",
  "in person rr": "In Person RR",
  "rio rancho": "In Person RR",
  // Formatting variants observed in production (Deploy 1). Same three offices,
  // different hyphen/spacing/casing — previously fell through to "Unknown".
  "in-person rio rancho": "In Person RR",
  "in person -rio rancho": "In Person RR",

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
  // Formatting variants observed in production (Deploy 1).
  "in person - ll": "In Person LL",
  // Missing-comma variant: a single token that names BOTH LL and Telehealth.
  // Mapped to LL (the in-person half) so the row lands in a real location
  // bucket; the Telehealth half is unrecoverable from this string alone.
  "in person - los lunas telehealth": "In Person LL",

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
  // Malformed production value: "(Open toTelehealth)" — a broken
  // "Flexible (Open to Any Option)" / Telehealth merge. The only recoverable
  // signal is Telehealth.
  "(open totelehealth)": "Telehealth",

  // Flexible/Flex
  "flexible (open to any option)": "Flex",
  "flexible (open to any option).": "Flex",
  "flexible": "Flex",
  "flex": "Flex",
  "open to any option": "Flex",
};

/**
 * Canonical modality buckets, in display order.
 *
 * The single source of truth for every staff-facing modality option list and
 * for the reporting agent's filter enum. Import this instead of re-declaring
 * the values — divergent hand-maintained copies are what produced the
 * non-canonical "Virtual" / "Either" options on the staff review form.
 *
 * "Unknown" is last and is a RESIDUAL bucket, not a selectable intent: it means
 * "nothing in this row resolved". Option lists that must not offer it should
 * use MODALITY_OPTIONS below.
 */
export const MODALITIES = [
  "Telehealth",
  "In Person ABQ",
  "In Person RR",
  "In Person LL",
  "In Person",
  "Hybrid",
  "Flex",
  "Unknown",
] as const;

export type Modality = typeof MODALITIES[number];

/** Selectable buckets (canonical 8 minus the residual "Unknown"). */
export const MODALITY_OPTIONS = MODALITIES.filter((m) => m !== "Unknown");

/** Compact labels for dense UI (kanban cards, table badges). */
export const MODALITY_SHORT_LABELS: Record<string, string> = {
  "Telehealth": "TH",
  "In Person ABQ": "ABQ",
  "In Person RR": "RR",
  "In Person LL": "LL",
  "In Person": "In Person",
  "Hybrid": "Hybrid",
  "Flex": "Flex",
  "Unknown": "Unknown",
};

/** Canonical buckets that represent a physical office location. */
const IN_PERSON_MODALITIES: readonly string[] = [
  "In Person ABQ",
  "In Person RR",
  "In Person LL",
  "In Person",
];

export function isInPersonModality(bucket: string): boolean {
  return IN_PERSON_MODALITIES.includes(bucket);
}

/**
 * Normalize a SINGLE already-split token to its canonical bucket.
 * Returns null when the token doesn't resolve (caller decides what that means).
 */
function normalizeToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  return MODALITY_NORMALIZATION_MAP[trimmed.toLowerCase()] ?? null;
}

/**
 * Split a raw modality value into its canonical buckets.
 *
 * Separators are "," and "&" — the only two observed in production data.
 * Tokens that don't resolve are DROPPED (they carry no bucket), so a row whose
 * every token is unmappable returns []. Order is the order the contact chose,
 * deduped; that ordering is informational only today and is NOT a priority
 * ranking — the explicit priority columns land in Deploy 2.
 *
 * Pure function: no side effects, deterministic.
 */
export function normalizeModalityTokens(rawValue: string | null | undefined): string[] {
  if (!rawValue) return [];
  const out: string[] = [];
  for (const part of String(rawValue).split(/[,&]/)) {
    const bucket = normalizeToken(part);
    if (bucket && !out.includes(bucket)) out.push(bucket);
  }
  return out;
}

/**
 * Normalize modality to a single canonical category (the PRIMARY bucket).
 *
 * Primary = the first in-person bucket if the row has one, else the first
 * canonical bucket, else "Unknown". In-person wins because a contact who will
 * travel to an office is an office-capacity data point, and the location is the
 * scarce resource; Telehealth alongside it is the fallback, not the headline.
 *
 * INTERIM RULE — this is a heuristic standing in for an explicit ranking. Once
 * Deploy 2 adds modality_p1..p4, priority-1 becomes the source of truth for all
 * counting/filtering and this function should be reduced to a display helper.
 * Do not build new counting logic on it.
 *
 * Returns "Unknown" when nothing resolves.
 */
export function normalizeModality(rawValue: string | null | undefined): string {
  const tokens = normalizeModalityTokens(rawValue);
  if (tokens.length === 0) return "Unknown";
  return tokens.find(isInPersonModality) ?? tokens[0];
}
