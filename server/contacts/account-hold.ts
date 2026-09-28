/**
 * Manual account hold — the decisions behind POST /api/contact/:id/hold and
 * /hold/clear, kept out of routes.ts so a test can run them against a
 * throwaway database. The routes only parse the id, call these, and send the
 * result.
 *
 * These are the ONLY writers of hold_active / hold_reason / hold_note. Nothing
 * else calls setContactHold or clearContactHold, and the intake PATCH cannot
 * reach the columns, so there is no unlogged path and no automatic one. See
 * shared/account-hold.ts.
 *
 * The free-text note is stored on the contact and never copied into the
 * activity log or a log line; the activity entry carries the reason only.
 */

import {
  HOLD_NOTE_MAX,
  HOLD_REASONS,
  HOLD_REASON_OTHER,
  isValidHoldReason,
} from "@shared/account-hold";
import { clearContactHold, getSyncContactById, setContactHold } from "../sync/db";
import { logActivity } from "../activity/db";

export interface HoldResult {
  status: number;
  body: Record<string, unknown>;
}

export async function putContactOnHold(
  contactId: number,
  input: { reason?: unknown; note?: unknown },
  actorEmail: string,
): Promise<HoldResult> {
  const { reason, note } = input;
  if (!isValidHoldReason(reason)) {
    return {
      status: 400,
      body: {
        error: "validation_error",
        field: "reason",
        message: "reason must be one of the allowed hold reasons",
        allowedValues: HOLD_REASONS,
      },
    };
  }
  // A note belongs only to "Other"; any other reason stores none.
  const cleanNote =
    reason === HOLD_REASON_OTHER && typeof note === "string" && note.trim()
      ? note.trim()
      : null;
  if (cleanNote && cleanNote.length > HOLD_NOTE_MAX) {
    return {
      status: 400,
      body: {
        error: "validation_error",
        field: "note",
        message: `note must be ${HOLD_NOTE_MAX} characters or fewer`,
      },
    };
  }

  const result = await setContactHold(contactId, reason, cleanNote);
  if (result.notFound) return { status: 404, body: { error: "Contact not found", contactId } };

  await logActivity({
    type: "contact_hold_set",
    actorEmail,
    entityType: "contact",
    entityId: String(contactId),
    entityName: (await getSyncContactById(contactId))?.name || "",
    metadata: {
      reason,
      // Set on a contact already on hold means the reason changed.
      previousReason: result.previous?.holdActive ? result.previous.holdReason : null,
    },
  });

  return {
    status: 200,
    body: { success: true, contactId, holdActive: true, holdReason: reason, holdNote: cleanNote },
  };
}

export async function takeContactOffHold(contactId: number, actorEmail: string): Promise<HoldResult> {
  const result = await clearContactHold(contactId);
  if (result.notFound) return { status: 404, body: { error: "Contact not found", contactId } };

  // Clearing a contact that was not on hold changes nothing; log nothing.
  if (result.previous?.holdActive) {
    await logActivity({
      type: "contact_hold_cleared",
      actorEmail,
      entityType: "contact",
      entityId: String(contactId),
      entityName: (await getSyncContactById(contactId))?.name || "",
      metadata: { reason: result.previous.holdReason },
    });
  }
  return { status: 200, body: { success: true, contactId, holdActive: false } };
}
