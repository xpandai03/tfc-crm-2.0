/**
 * Per-IP rate limiting for the public survey endpoint.
 * ============================================================================
 *
 * There is no rate limiting anywhere else in this codebase — no
 * express-rate-limit dependency, no middleware, no counter. (The package name
 * appears in script/build.ts's bundling allowlist, but it is not installed.)
 * The survey is the first endpoint that both accepts free text and is reachable
 * without a session, so this is new work rather than a pattern to follow.
 *
 * IN-MEMORY ON PURPOSE. The app runs as a single Node process (fly.toml sets
 * min_machines_running = 1) and the existing session store is already
 * memorystore, so a process-local counter is consistent with how this server
 * already keeps state. It resets on deploy, which is acceptable: the goal is to
 * blunt junk and accidental double-submits, not to defend a credential.
 * A second machine would each get their own budget — noted, not solved here.
 *
 * SHARED-ADDRESS PROBLEM. A clinic lobby is behind one NAT address, so every
 * QR-code submission from one site arrives from the same IP. A limit tuned for
 * "one person, one submission" would lock out real clients on a busy afternoon.
 * The ceilings below are therefore deliberately loose and env-overridable, so
 * they can be raised from the Fly dashboard without a code change once the
 * client answers what their busiest realistic hour looks like.
 */

import type { Request } from "express";

/** Submissions allowed from one address per rolling hour. */
export const SURVEY_MAX_PER_HOUR = readPositiveInt(
  process.env.SURVEY_RATE_LIMIT_PER_HOUR,
  20,
);

/** Submissions allowed from one address per rolling 24 hours. */
export const SURVEY_MAX_PER_DAY = readPositiveInt(
  process.env.SURVEY_RATE_LIMIT_PER_DAY,
  80,
);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Stop the map growing without bound if a botnet rotates addresses. */
const MAX_TRACKED_ADDRESSES = 5000;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Accept timestamps per address. Trimmed on read, so no sweeper timer. */
const hits = new Map<string, number[]>();

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; window: "hour" | "day" };

/**
 * Extract one client address from the usual proxy headers, following the
 * approach in the DrSnip intake app (api/_lib/rate-limit.ts): x-forwarded-for
 * is a comma-separated chain and the first entry is the original client.
 * server/auth.ts sets `trust proxy` in production, so req.ip resolves too; the
 * header is read directly here so the limiter behaves identically in dev, where
 * trust proxy is off.
 *
 * Returns a fixed sentinel rather than null when no address can be derived, so
 * unattributable requests share one budget instead of escaping the limit.
 */
export function clientIpFromRequest(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(xff) && xff.length > 0) {
    const first = xff[0]?.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  if (typeof req.ip === "string" && req.ip) return req.ip;
  return "unknown";
}

/**
 * Check the address against both windows WITHOUT recording an attempt. Call
 * recordSurveySubmission() only once a submission is actually stored, so a
 * request rejected for a bad payload does not spend a real client's budget.
 */
export function checkSurveyRateLimit(ip: string, now = Date.now()): RateLimitResult {
  const timestamps = trimmed(ip, now);
  if (timestamps.length === 0) return { allowed: true };

  const inHour = timestamps.filter((t) => now - t < HOUR_MS);
  if (inHour.length >= SURVEY_MAX_PER_HOUR) {
    const oldest = inHour[0];
    return {
      allowed: false,
      window: "hour",
      retryAfterSeconds: Math.max(1, Math.ceil((HOUR_MS - (now - oldest)) / 1000)),
    };
  }

  if (timestamps.length >= SURVEY_MAX_PER_DAY) {
    const oldest = timestamps[0];
    return {
      allowed: false,
      window: "day",
      retryAfterSeconds: Math.max(1, Math.ceil((DAY_MS - (now - oldest)) / 1000)),
    };
  }

  return { allowed: true };
}

/** Record one accepted submission against the address. */
export function recordSurveySubmission(ip: string, now = Date.now()): void {
  const timestamps = trimmed(ip, now);
  timestamps.push(now);
  hits.set(ip, timestamps);

  if (hits.size > MAX_TRACKED_ADDRESSES) {
    // Drop the least recently active addresses. Map preserves insertion order
    // and every write re-inserts, so the head is the stalest.
    // Array.from rather than iterating hits.keys() directly: tsconfig targets
    // below es2015 without downlevelIteration, so a bare Map iterator does not
    // typecheck. It also snapshots the keys, which avoids mutating the Map
    // while walking it.
    const excess = hits.size - MAX_TRACKED_ADDRESSES;
    for (const key of Array.from(hits.keys()).slice(0, excess)) {
      hits.delete(key);
    }
  }
}

/** Timestamps for an address with everything outside the day window removed. */
function trimmed(ip: string, now: number): number[] {
  const existing = hits.get(ip);
  if (!existing || existing.length === 0) return [];
  const kept = existing.filter((t) => now - t < DAY_MS);
  if (kept.length === 0) {
    hits.delete(ip);
    return [];
  }
  // Re-insert so the address moves to the tail for the eviction pass above.
  hits.delete(ip);
  hits.set(ip, kept);
  return kept;
}

/** Test seam. Never called by the server. */
export function __resetSurveyRateLimit(): void {
  hits.clear();
}
