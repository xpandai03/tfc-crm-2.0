/**
 * Dashboard status buckets — ONE definition, shared by the dashboard and Insights.
 *
 * WHY THIS EXISTS
 * ---------------
 * "How many active contacts are there?" had three defensible answers in this
 * codebase at once:
 *   - 212  the umbrella definition (WL + PS + SCH), where PS includes 206
 *   - 209  the Insights page's own INSIGHTS_PIPELINE_STATUS_SET, which omitted 206
 *   - 217  every contact not in INACTIVE_STATUS_CODES
 * Two of those were visible on screen simultaneously. This module collapses the
 * first two onto one derivation and makes the third an explicit, DISPLAYED
 * bucket so the arithmetic reconciles in front of the reader:
 *
 *     pipeline (212) + otherActive (5) = active (217)
 *
 * DERIVED, NOT TRANSCRIBED
 * ------------------------
 * Every bucket is built from STATUS_UMBRELLA_CODES below — the same constant the
 * pipeline columns and the waitlist board already key off. Adding a status code
 * to an umbrella there automatically places it here, which is the point: a
 * hand-copied list is exactly how the 206 omission happened in the first place.
 *
 * "otherActive" is REF (500 Resources Need to be Sent) + PMR (300 Submitted for
 * Review). Both are ACTIVE — see STATUS_CODE_LABELS, which maps 500 to "waiting"
 * — but neither belongs to Waitlist, Pending or Scheduled. They were previously
 * uncounted by every pipeline surface, which is why 212 and 217 disagreed with
 * nothing on screen to explain the gap.
 */

import { STATUS_UMBRELLA_CODES, INACTIVE_STATUS_CODES } from "./status-codes";

/** The buckets a contact can land in. Order is display order. */
export const STATUS_BUCKETS = [
  "waitlist",
  "pending",
  "scheduled",
  "otherActive",
] as const;

export type StatusBucket = (typeof STATUS_BUCKETS)[number];

/** Bucket → member status codes, derived from the umbrella definitions. */
export const STATUS_BUCKET_CODES: Record<StatusBucket, readonly number[]> = {
  waitlist: STATUS_UMBRELLA_CODES.WL,
  pending: STATUS_UMBRELLA_CODES.PS,
  scheduled: STATUS_UMBRELLA_CODES.SCH,
  otherActive: [...STATUS_UMBRELLA_CODES.REF, ...STATUS_UMBRELLA_CODES.PMR],
};

/** Human labels for the dashboard column headers. */
export const STATUS_BUCKET_LABELS: Record<StatusBucket, string> = {
  waitlist: "Waitlist",
  pending: "Pending",
  scheduled: "Scheduled",
  otherActive: "Other Active",
};

/**
 * The three buckets that make up PIPELINE. Excludes otherActive by design —
 * the client's definition of Pipeline is Waitlist + Pending + Scheduled, and
 * otherActive exists to account for the remainder, not to join the sum.
 */
export const PIPELINE_BUCKETS: readonly StatusBucket[] = ["waitlist", "pending", "scheduled"];

/**
 * Every status code that counts as PIPELINE. Replaces the hand-maintained
 * INSIGHTS_PIPELINE_STATUS_SET, which drifted from the umbrellas by omitting
 * 206. Derived, so it cannot drift again.
 */
export const PIPELINE_STATUS_CODES: readonly number[] = PIPELINE_BUCKETS.flatMap(
  (b) => [...STATUS_BUCKET_CODES[b]],
);

/**
 * Pipeline minus Scheduled — the contacts still needing scheduling work.
 * Mirrors the Insights page's long-standing "operations" set (it was
 * {100,101,102,200,201}); derived here so it picks up 206 as PS did.
 */
export const OPERATIONS_STATUS_CODES: readonly number[] = (["waitlist", "pending"] as StatusBucket[])
  .flatMap((b) => [...STATUS_BUCKET_CODES[b]]);

/** Every code in any active bucket = pipeline + otherActive. */
export const ACTIVE_BUCKET_STATUS_CODES: readonly number[] = STATUS_BUCKETS.flatMap(
  (b) => [...STATUS_BUCKET_CODES[b]],
);

/**
 * The bucket a status code belongs to, or null when it is inactive/unknown.
 * Null is the correct answer for the 8 INACTIVE_STATUS_CODES — they are
 * excluded from the dashboard's active population, not bucketed.
 */
export function getStatusBucket(statusCode: number | undefined | null): StatusBucket | null {
  if (statusCode === undefined || statusCode === null) return null;
  for (const bucket of STATUS_BUCKETS) {
    if (STATUS_BUCKET_CODES[bucket].includes(statusCode)) return bucket;
  }
  return null;
}

/**
 * Is this code part of the ACTIVE population the dashboard counts by default?
 *
 * Deliberately defined as "has a bucket" rather than "not in
 * INACTIVE_STATUS_CODES". The two agree today, and asserting that is the job of
 * assertBucketCoverage() below — but an unrecognised future code should land
 * OUTSIDE the counted population rather than silently inflating a bucket total.
 */
export function isActiveBucketCode(statusCode: number | undefined | null): boolean {
  return getStatusBucket(statusCode) !== null;
}

/**
 * Every code the system knows, partitioned. Used by the endpoint to prove the
 * partition is total and disjoint before it reports a single number.
 *
 * Throws rather than returning a flag: a bucket overlap or a code that is both
 * active and inactive is a data-model contradiction, and a dashboard that
 * renders confident totals on top of one is worse than a dashboard that fails
 * loudly at startup.
 */
export function assertBucketCoverage(): void {
  const seen = new Map<number, StatusBucket>();
  for (const bucket of STATUS_BUCKETS) {
    for (const code of STATUS_BUCKET_CODES[bucket]) {
      const prior = seen.get(code);
      if (prior) {
        throw new Error(
          `[status-buckets] code ${code} is in both "${prior}" and "${bucket}"`,
        );
      }
      seen.set(code, bucket);
    }
  }
  for (const code of Array.from(seen.keys())) {
    if (INACTIVE_STATUS_CODES.includes(code)) {
      throw new Error(
        `[status-buckets] code ${code} is bucketed as active but also listed INACTIVE`,
      );
    }
  }
}
