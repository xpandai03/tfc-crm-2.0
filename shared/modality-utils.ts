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
 * Every modality bucket the system RECOGNISES, in display order.
 *
 * This is the ACCEPTANCE list, not the offer list — it stays wide on purpose.
 * The intake endpoint validates against it, and the public RFS form still sends
 * the legacy values, so narrowing this would start rejecting real submissions.
 * Historical records also still hold the legacy values and must keep rendering.
 *
 * For anything a human PICKS FROM, use MODALITY_OPTIONS below.
 *
 * "Unknown" is a RESIDUAL bucket, not an intent: it means "nothing in this row
 * resolved".
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

/**
 * Values RETIRED from selection. Still recognised, still displayed on the
 * records that hold them, but no longer offered anywhere a human picks a
 * modality — the clinic stopped using them and wants intake steered to a
 * specific location or Telehealth.
 *
 * "In Person" here is the GENERIC value only. The location-specific
 * "In Person ABQ/RR/LL" options are unaffected and remain selectable.
 *
 * Retiring a value is display/selection-only and never rewrites stored data.
 * To retire another, add it here — do not delete it from MODALITIES, or intake
 * will start rejecting submissions that legitimately carry it.
 */
export const RETIRED_MODALITY_OPTIONS: readonly string[] = ["Flex", "Hybrid", "In Person"];

/**
 * Buckets a human may SELECT: canonical values minus the residual "Unknown"
 * and minus anything retired. This is what every dropdown should render.
 */
export const MODALITY_OPTIONS = MODALITIES.filter(
  (m) => m !== "Unknown" && !RETIRED_MODALITY_OPTIONS.includes(m),
);

/** True for a value that is still stored/displayed but no longer selectable. */
export function isRetiredModality(value: string | null | undefined): boolean {
  return !!value && RETIRED_MODALITY_OPTIONS.includes(value.trim());
}

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

// ============================================================================
// Modality priorities (modality_p1..p4)
// ============================================================================
//
// A contact's modality selections as an ORDERED list, p1 = top choice.
//
// FILTERING IS PRIORITY-1 ONLY, EVERYWHERE. Pipeline, list, export, referral
// reports and Insights all key off p1, so a contact is counted and found under
// exactly one modality: their top choice.
//
// This narrowed deliberately. The pipeline filter originally matched ANY of
// p1..p4 so a contact surfaced under every location they would attend, but that
// made filtered counts exceed the contact count and disagreed with what the
// reports said. The client asked for one consistent meaning.
//
// DISPLAY IS UNCHANGED: a row still shows the contact's full p1..p4 set (see
// getModalityPriorities). Only which rows a filter RETURNS narrowed.
//
// FALLBACK: rows the backfill left alone (Flex, Fax Referral, out-of-area
// multi-office) and any row created before the priority columns existed have a
// NULL p1. Every accessor below falls back to parsing the legacy `modality`
// string, so those rows behave exactly as they did before priorities shipped.
// Never read modality_p1 directly — go through these.
//
// PRIORITY ORDER IS AUTHORITATIVE AND IS NEVER REORDERED. The zip-distance
// heuristic that produced the initial ordering was a ONE-TIME BACKFILL device
// for historical rows that never stated a preference. Once a contact states an
// order (RFS form, or staff entry), that order is what we store and what we
// show — no proximity rule, no re-ranking, ever.

/** The shape any priority accessor needs. Both DB rows and API contacts fit. */
export interface ModalityPriorityFields {
  modalityP1?: string | null;
  modalityP2?: string | null;
  modalityP3?: string | null;
  modalityP4?: string | null;
  modality?: string | null;
}

/**
 * A contact's modality selections in priority order.
 * Falls back to normalizing the legacy `modality` string when no priority is
 * set. Returns [] only when nothing resolves at all (e.g. Fax Referral).
 */
export function getModalityPriorities(c: ModalityPriorityFields): string[] {
  const explicit = [c.modalityP1, c.modalityP2, c.modalityP3, c.modalityP4]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
  if (explicit.length > 0) return explicit;
  return normalizeModalityTokens(c.modality);
}

/**
 * The single bucket a contact counts under, everywhere: reports, Insights, and
 * every filter. p1 when set, else the primary bucket of the legacy string, else
 * "Unknown".
 */
export function getPrimaryModality(c: ModalityPriorityFields): string {
  const p1 = typeof c.modalityP1 === "string" ? c.modalityP1.trim() : "";
  if (p1) return p1;
  return normalizeModality(c.modality);
}

/**
 * Does this contact belong under `bucket` when filtering?
 *
 * PRIORITY-1 ONLY. A contact whose p1 is Albuquerque and p2 is Rio Rancho is
 * returned by an Albuquerque filter and NOT by a Rio Rancho one — even though
 * their row still displays both. Rows that resolve to nothing match only an
 * explicit "Unknown" (getPrimaryModality returns "Unknown" for them).
 *
 * This is THE filter predicate: the list view and the server-side export
 * predicate both call it, so the export can never drift from the view it is
 * supposed to reproduce. Do not inline this comparison at a call site.
 */
export function matchesPrimaryModality(c: ModalityPriorityFields, bucket: string): boolean {
  return getPrimaryModality(c) === bucket;
}

/** Comma-joined priority list, matching the legacy `modality` raw format. */
export function joinModalityPriorities(values: (string | null | undefined)[]): string | null {
  const clean = values.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
  return clean.length ? clean.join(", ") : null;
}
