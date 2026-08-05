/**
 * Canonical status_code → legacy-string-slug map (server-side concern).
 *
 * Used to populate `sync_contacts.status` (legacy text column) and the
 * `fromLabel` / `toLabel` fields in `activity_log.metadata` for
 * `status_changed` events. These slugs feed the `formatActivitySummary()`
 * timeline rendering in `server/activity/db.ts` and any consumer that
 * keys off the legacy string status.
 *
 * NOT to be confused with the human-readable DISPLAY labels in
 * `client/src/lib/status-config.ts:STATUS_LABELS` (e.g. "New -- No Outreach"),
 * which are a different concern (UI presentation) and intentionally remain
 * client-side. The two maps are not interchangeable.
 *
 * If a status code is added or renamed, update THIS file — the server-side
 * write paths all import from here.
 */

export const STATUS_CODE_LABELS: Record<number, string> = {
  100: "intake",
  101: "waiting",
  102: "waiting",
  103: "closed",
  104: "closed",
  200: "ready_to_schedule",
  201: "waiting",
  202: "scheduled",
  203: "waiting",
  204: "closed",
  205: "closed",
  206: "waiting",       // Rescheduling Initial Appointment (PS, active)
  300: "on_hold",
  400: "closed",
  402: "closed",        // Referred Out (Inactive)
  403: "closed",        // Deferred Services — temporarily unavailable (Inactive)
  500: "waiting",       // Resources Need to be Sent (Referred To Other Services, active)
};

export function getStatusLabel(code: number): string {
  return STATUS_CODE_LABELS[code] ?? "unknown";
}

// ============================================================================
// Active/inactive + umbrella membership (shared client/server)
//
// These moved here from client/src/lib/status-config.ts so the SERVER can apply
// the same predicate the waitlist list view applies — the waitlist export now
// filters server-side and must agree with the on-screen list exactly. The client
// status-config re-exports these; do not re-declare the literals there.
// ============================================================================

/**
 * Terminal states where no further action is expected. Excluded from "active"
 * counts and hidden by the list view's default "Hide Inactive" toggle.
 *   103 Declined Services (WL) · 104 Inactive -- No Response (WL)
 *   203 No Response (PS)       · 204 Declined (PS)
 *   205 Initial Appt Completed · 400 Insurance Not Accepted (INS)
 *   402 Referred Out           · 403 Deferred Services
 */
export const INACTIVE_STATUS_CODES: number[] = [103, 104, 203, 204, 205, 400, 402, 403];

/** Mirrors the client's isActiveStatus, including its permissive null default. */
export function isActiveStatusCode(statusCode: number | undefined | null): boolean {
  if (statusCode === undefined || statusCode === null) return true; // safe default
  return !INACTIVE_STATUS_CODES.includes(statusCode);
}

/** Umbrella id → member status codes. Mirrors STATUS_UMBRELLAS in status-config. */
export const STATUS_UMBRELLA_CODES: Record<string, readonly number[]> = {
  WL: [100, 101, 102],
  PS: [200, 201, 206],
  SCH: [202],
  REF: [500],
  PMR: [300],
  INS: [103, 104, 203, 204, 205, 400, 402, 403],
};

/** Returns the umbrella id for a status code, or null when it matches none. */
export function getUmbrellaForStatusCode(statusCode: number | undefined | null): string | null {
  if (statusCode === undefined || statusCode === null) return null;
  for (const [id, codes] of Object.entries(STATUS_UMBRELLA_CODES)) {
    if (codes.includes(statusCode)) return id;
  }
  return null;
}
