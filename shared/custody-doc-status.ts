/**
 * Custody Document Status — a plain CRM-owned field on the contact record.
 *
 * Same shape as shared/paperwork-status.ts, and for the same reasons: NOT a
 * status code, never in an n8n sync payload, and nothing keys off it. In
 * particular it does NOT put an account on hold or take one off — the hold is
 * a separate, manual control (shared/account-hold.ts). "Requested" with no hold
 * is a normal state; so is a hold for missing custody documents while this is
 * still blank.
 *
 * NULL is the default ("not tracked") and is always allowed; clearing the
 * dropdown writes NULL. Values are stored VERBATIM — add, don't rename.
 *
 * NOT the `custody` column. That one arrives from the intake form through the
 * n8n sync (the custody arrangement the family described) and a sync overwrites
 * it; this one is staff-owned and a sync never touches it.
 */
export const CUSTODY_DOC_STATUSES = ["Not needed", "Requested", "Received"] as const;

export type CustodyDocStatus = typeof CUSTODY_DOC_STATUSES[number];

/** True for a storable value: a known option, or null/empty meaning "not set". */
export function isValidCustodyDocStatus(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  return (
    typeof value === "string" &&
    (CUSTODY_DOC_STATUSES as readonly string[]).includes(value.trim())
  );
}
