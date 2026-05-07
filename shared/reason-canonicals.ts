/**
 * Canonical reason-for-therapy values
 *
 * Authoritative list of MCQ reasons used for the Insights breakdown,
 * staff referral form dropdown, and /api/intake server-side validation.
 *
 * History: this list was implicit (only the website Jotform knew about
 * it) until Bucket A of the insights cleanup audit (May 2026), which
 * pulled it into shared code so the staff referral form and the server
 * could both validate against it. ADHD was added at that time as the
 * 26th canonical (D-A4). The 25 prior values matched the website
 * Jotform's MCQ checkboxes.
 *
 * Adding a value:
 *   1. Append to REASON_CANONICALS below.
 *   2. The staff referral form picks it up automatically.
 *   3. Coordinate with the website Jotform admin (out-of-codebase) to
 *      add a matching MCQ option there too.
 *   4. If you also want existing free-text values remapped to the new
 *      canonical, add a one-off migration UPDATE.
 *
 * "Other" handling:
 *   - The migration label for unmappable legacy free-text is the
 *     constant REASON_OTHER_LEGACY below.
 *   - The staff form's "Other" option produces values prefixed with
 *     "Other: " (e.g., "Other: brain fog"). These should still
 *     aggregate into the single "Other" Insights bucket — the helper
 *     bucketReason() handles the rollup.
 */

export const REASON_CANONICALS = [
  "Addiction",
  "ADHD",
  "Anger Management",
  "Anxiety",
  "Bipolar Disorder",
  "Career Challenges",
  "Chronic Pain",
  "Communication Problems",
  "Depression",
  "Eating Disorders",
  "Family Conflict",
  "Financial Stress",
  "Grief/Loss",
  "Identity Issues",
  "Life Transitions",
  "OCD",
  "Parenting Issues",
  "PTSD",
  "Relationship Issues",
  "Self-esteem",
  "Sexual Problems",
  "Sleep Problems",
  "Stress",
  "Suicidal Thoughts",
  "Trauma",
  "Work Stress",
] as const;

export type ReasonCanonical = (typeof REASON_CANONICALS)[number];

/** Display label and migration target for unmappable legacy values. */
export const REASON_OTHER_LEGACY = "Other (legacy free-text)";

const REASON_SET: Set<string> = new Set(REASON_CANONICALS);

/** True if the value is exactly one of the 26 canonical reasons. */
export function isCanonicalReason(value: string): value is ReasonCanonical {
  return REASON_SET.has(value);
}

/**
 * Roll a raw reason token into its display bucket.
 *
 *   - Canonical → returned as-is
 *   - Anything starting with "Other" (the migration label and the staff
 *     form's "Other: <text>" prefix) → REASON_OTHER_LEGACY
 *   - Anything else → REASON_OTHER_LEGACY (defensive — post-migration
 *     this branch should rarely fire; the staff dropdown + server
 *     validation prevent it going forward)
 */
export function bucketReason(rawToken: string): ReasonCanonical | typeof REASON_OTHER_LEGACY {
  const t = rawToken.trim();
  if (isCanonicalReason(t)) return t;
  return REASON_OTHER_LEGACY;
}

/**
 * Normalize an inbound reasonForTherapy value (string or array) into a
 * canonical comma-separated string. Used by /api/intake to validate
 * submissions.
 *
 * Behavior per token (after split + trim):
 *   - Empty → skipped.
 *   - Canonical (in REASON_CANONICALS) → kept as-is.
 *   - "Other: <text>" or "Other (legacy free-text)" or bare "Other" →
 *     kept verbatim (the staff form's Other-with-text path).
 *   - Anything else → dropped from the normalized output AND added to
 *     the `unknown` array so the caller can decide whether to warn or
 *     reject (D-A6: staff path warns, website path rejects).
 *
 * Dedupes within the cell. Order follows REASON_CANONICALS for the
 * canonical tokens; "Other" tokens are appended afterward.
 */
export function normalizeReasonForTherapy(raw: unknown): {
  normalized: string;
  unknown: string[];
} {
  if (raw == null) return { normalized: "", unknown: [] };
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        for (const part of item.split(",")) tokens.push(part);
      }
    }
  } else if (typeof raw === "string") {
    for (const part of raw.split(",")) tokens.push(part);
  } else {
    return { normalized: "", unknown: [] };
  }

  const accepted = new Set<string>();
  const otherTokens: string[] = [];
  const unknown: string[] = [];
  for (const part of tokens) {
    const t = part.trim();
    if (!t) continue;
    if (REASON_SET.has(t)) {
      accepted.add(t);
    } else if (t.startsWith("Other:") || t === REASON_OTHER_LEGACY || t === "Other") {
      // Preserve the Other-prefixed token verbatim, dedupe within cell.
      if (!otherTokens.includes(t)) otherTokens.push(t);
    } else {
      unknown.push(t);
    }
  }

  // Order canonical tokens stably (REASON_CANONICALS order), then Other tokens.
  const orderedCanonicals = REASON_CANONICALS.filter((c) => accepted.has(c));
  const normalized = [...orderedCanonicals, ...otherTokens].join(", ");
  return { normalized, unknown };
}
