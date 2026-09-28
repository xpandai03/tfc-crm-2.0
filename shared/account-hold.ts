/**
 * Account hold — a MANUAL flag staff set on a contact who cannot be scheduled
 * yet, with the reason why.
 *
 * MANUAL ONLY. Nothing sets a hold except a person pressing the button on the
 * contact page, and nothing clears one except a person pressing Clear. It is
 * never inferred from an empty field: a VA client with no insurance ID is not
 * on hold until someone says so, and custody documents marked "Requested" do
 * not put anyone on hold. If an automatic rule is ever wanted, it is a new
 * feature with its own review — not a change to this file.
 *
 * Three CRM-owned columns on sync_contacts, never written by the n8n sync:
 *   hold_active  BOOLEAN NOT NULL DEFAULT FALSE
 *   hold_reason  TEXT, one of HOLD_REASONS while active, NULL otherwise
 *   hold_note    TEXT, only when the reason is HOLD_REASON_OTHER, else NULL
 *
 * Written only by POST /api/contact/:id/hold and /hold/clear, which log every
 * change to the activity timeline with the reason and the person. The general
 * intake PATCH cannot touch these, so there is no unlogged way to set a hold.
 *
 * Reasons are stored VERBATIM — add, don't rename.
 */
export const HOLD_REASON_OTHER = "Other (see notes)";

export const HOLD_REASONS = [
  "Missing custody documents",
  "Missing VA referral",
  "Missing insurance ID",
  HOLD_REASON_OTHER,
] as const;

export type HoldReason = typeof HOLD_REASONS[number];

/** A hold note is short context, not a second notes field. */
export const HOLD_NOTE_MAX = 500;

export function isValidHoldReason(value: unknown): value is HoldReason {
  return typeof value === "string" && (HOLD_REASONS as readonly string[]).includes(value);
}

/** The minimal shape every surface reads. */
export interface HoldState {
  holdActive?: boolean | null;
  holdReason?: string | null;
}

/** On hold, full stop. A hold with no reason still counts — it was set on purpose. */
export function isOnHold(c: HoldState | null | undefined): boolean {
  return c?.holdActive === true;
}

/**
 * What the waitlist exclamation mark says on hover. "Other" points at the notes
 * rather than repeating free text into a list row.
 */
export function holdHoverText(reason: string | null | undefined): string {
  if (!reason) return "On hold";
  if (reason === HOLD_REASON_OTHER) return "Other: see notes";
  return reason;
}

/** The contact-page banner line. */
export function holdBannerText(reason: string | null | undefined): string {
  return `On hold: ${reason || "no reason given"}`;
}
