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
  500: "waiting",       // Resources Need to be Sent (Referred To Other Services, active)
};

export function getStatusLabel(code: number): string {
  return STATUS_CODE_LABELS[code] ?? "unknown";
}
