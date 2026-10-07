/**
 * The patient-portal step's outcome, stored on the contact.
 * ============================================================================
 *
 * After booking, the TherapyNotes agent sends the portal welcome email and
 * shares the intake documents for the contact's service type. It reports the
 * result as its own progress phase, `portal`, ALWAYS with status "ok" — a
 * portal problem must never turn a booked appointment into a failed run — and
 * the real outcome in metadata:
 *
 *   portalStatus     "done" | "dry_run" | "failed" | "skipped"
 *   portalStep       the step it stopped at (failed) — e.g. "share_documents"
 *   portalReason     a code: the skip reason, or why a step failed
 *   portalDocuments  names shared (done) or that WOULD be shared (dry_run)
 *   portalMissing    table names not found in TherapyNotes (shared the rest)
 *   welcomeEmail     "sent" | "already_sent" | "unavailable" | "would_send" | "not_attempted"
 *
 * Stored as portal_status / portal_documents / portal_sent_at / portal_detail.
 * portal_sent_at is set only when something was actually sent (status done).
 *
 * Document names are TherapyNotes template names (practice forms), not patient
 * data. Nothing here logs a patient value.
 */
import { getPool } from "../db/pool";
import { PORTAL_STATUSES, type PortalStatus } from "@shared/portal-service-type";

export async function initPortalColumns(): Promise<void> {
  try {
    await getPool().query(
      `ALTER TABLE sync_contacts
         ADD COLUMN IF NOT EXISTS portal_status TEXT,
         ADD COLUMN IF NOT EXISTS portal_documents TEXT,
         ADD COLUMN IF NOT EXISTS portal_sent_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS portal_detail TEXT`,
    );
  } catch (e) {
    console.error("[portal] sync_contacts portal columns migration FAILED:", e instanceof Error ? e.message : "unknown");
  }
}

export interface PortalOutcome {
  status: PortalStatus;
  documents: string[];
  detail: {
    step: string | null;
    reason: string | null;
    missing: string[];
    welcomeEmail: string | null;
    runId: string;
  };
}

const names = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").map((x) => x.replace(/\s+/g, " ").trim().slice(0, 120)).filter(Boolean).slice(0, 30)
    : [];
const code = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null;

/** The outcome in a progress callback's metadata, or null when there is none (or it is malformed). */
export function portalOutcomeFromMeta(meta: Record<string, unknown>, runId: string): PortalOutcome | null {
  const status = meta.portalStatus;
  if (typeof status !== "string" || !(PORTAL_STATUSES as readonly string[]).includes(status)) return null;
  return {
    status: status as PortalStatus,
    documents: names(meta.portalDocuments),
    detail: {
      step: code(meta.portalStep),
      reason: code(meta.portalReason),
      missing: names(meta.portalMissing),
      welcomeEmail: code(meta.welcomeEmail),
      runId,
    },
  };
}

export async function storePortalOutcome(contactId: number, o: PortalOutcome): Promise<void> {
  await getPool().query(
    `UPDATE sync_contacts
        SET portal_status = $2, portal_documents = $3, portal_detail = $4,
            portal_sent_at = CASE WHEN $2 = 'done' THEN NOW() ELSE portal_sent_at END
      WHERE contact_id = $1`,
    [contactId, o.status, JSON.stringify(o.documents), JSON.stringify(o.detail)],
  );
}

/** The contact's stored portal outcome, for the scheduling card. Null when none. */
export function portalStateOf(c: {
  portalStatus?: string | null; portalDocuments?: string | null;
  portalSentAt?: string | null; portalDetail?: string | null;
}): {
  status: PortalStatus; documents: string[]; sentAt: string | null;
  step: string | null; reason: string | null; missing: string[]; welcomeEmail: string | null;
} | null {
  if (!c.portalStatus || !(PORTAL_STATUSES as readonly string[]).includes(c.portalStatus)) return null;
  const parse = (raw: string | null | undefined): unknown => { try { return JSON.parse(raw ?? "null"); } catch { return null; } };
  const detail = (parse(c.portalDetail) ?? {}) as Record<string, unknown>;
  return {
    status: c.portalStatus as PortalStatus,
    documents: names(parse(c.portalDocuments)),
    sentAt: c.portalSentAt ? new Date(c.portalSentAt).toISOString() : null,
    step: code(detail.step),
    reason: code(detail.reason),
    missing: names(detail.missing),
    welcomeEmail: code(detail.welcomeEmail),
  };
}

/** PORTAL_LIVE=true is the only way to a live send; everything else is a dry run. */
export function portalDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PORTAL_LIVE ?? "").trim().toLowerCase() !== "true";
}
