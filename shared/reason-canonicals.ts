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
