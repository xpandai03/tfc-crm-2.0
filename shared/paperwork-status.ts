/**
 * Paperwork Status — a plain CRM-owned field on the contact record.
 *
 * NOT a status code. It has nothing to do with the status-code/umbrella cluster
 * system (STATUS_CODE_LABELS, STATUS_UMBRELLAS, the kanban columns), it does not
 * move a contact through the pipeline, and it is deliberately absent from every
 * n8n sync payload. It tracks one operational fact — whether intake paperwork
 * has gone out and come back — and nothing keys off it.
 *
 * DATA-DRIVEN ON PURPOSE: the clinic expects to add options (a "Partially
 * Received" / "Not Required" style value has already come up). Adding one here
 * is the whole change — the contact-card dropdown, the list column and the
 * server-side validation all read this list.
 *
 * NULL is the meaningful empty state ("not tracked yet") and is always allowed;
 * it is not a member of this list. Clearing the dropdown writes NULL.
 *
 * Values are stored VERBATIM, so renaming one orphans existing rows. Add, don't
 * rename.
 */
export const PAPERWORK_STATUSES = ["Sent", "Received"] as const;

export type PaperworkStatus = typeof PAPERWORK_STATUSES[number];

/** True for a storable value: a known option, or null/empty meaning "not set". */
export function isValidPaperworkStatus(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  return (
    typeof value === "string" &&
    (PAPERWORK_STATUSES as readonly string[]).includes(value.trim())
  );
}
