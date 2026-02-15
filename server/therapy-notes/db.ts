/**
 * TherapyNotes Database
 *
 * SQLite storage for TN patient creation records.
 * Reuses the same database instance from reminders/db.ts.
 */

import { getDatabase } from "../reminders/db";
import type { TherapyNotesRecord, CreateTnRecordParams } from "./types";

/**
 * Initialize the therapy_notes_records table (call at startup after initDatabase)
 */
export function initTherapyNotesTable(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS therapy_notes_records (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id       INTEGER NOT NULL UNIQUE,
      contact_name     TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      tn_status        TEXT NOT NULL DEFAULT 'in_progress',
      tn_patient_url   TEXT,
      tn_patient_id    TEXT,
      failure_reason   TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tn_contact_id
      ON therapy_notes_records(contact_id);
  `);

  console.log("[therapy-notes-db] Table initialized");
}

/**
 * Get TN record for a contact
 */
export function getTnRecord(contactId: number): TherapyNotesRecord | null {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT
      id,
      contact_id       as contactId,
      contact_name     as contactName,
      created_by_email as createdByEmail,
      tn_status        as tnStatus,
      tn_patient_url   as tnPatientUrl,
      tn_patient_id    as tnPatientId,
      failure_reason   as failureReason,
      created_at       as createdAt,
      updated_at       as updatedAt
    FROM therapy_notes_records
    WHERE contact_id = ?
  `).get(contactId) as TherapyNotesRecord | undefined;

  return row ?? null;
}

/**
 * Create a new TN record with status 'in_progress'
 */
export function createTnRecord(params: CreateTnRecordParams): number {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO therapy_notes_records (contact_id, contact_name, created_by_email, tn_status)
    VALUES (?, ?, ?, 'in_progress')
  `).run(params.contactId, params.contactName, params.createdByEmail);

  const id = result.lastInsertRowid as number;
  console.log(`[therapy-notes-db] Created record ${id} for contact ${params.contactId}`);
  return id;
}

/**
 * Update TN record status with optional URL/ID or failure reason
 */
export function updateTnStatus(
  contactId: number,
  status: "created" | "failed",
  opts?: { url?: string; id?: string; failureReason?: string }
): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE therapy_notes_records
    SET tn_status = ?,
        tn_patient_url = COALESCE(?, tn_patient_url),
        tn_patient_id = COALESCE(?, tn_patient_id),
        failure_reason = ?,
        updated_at = datetime('now')
    WHERE contact_id = ?
  `).run(
    status,
    opts?.url ?? null,
    opts?.id ?? null,
    opts?.failureReason ?? null,
    contactId
  );

  console.log(`[therapy-notes-db] Updated contact ${contactId} → ${status}`);
}

/**
 * Manually reset a "created" link (e.g. patient deleted in TherapyNotes)
 */
export function resetTnLink(contactId: number): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE therapy_notes_records
    SET tn_status = 'failed',
        tn_patient_url = NULL,
        tn_patient_id = NULL,
        failure_reason = 'Manually reset',
        updated_at = datetime('now')
    WHERE contact_id = ?
  `).run(contactId);

  console.log(`[therapy-notes-db] Manually reset link for contact ${contactId}`);
}

/**
 * Reset a failed or stale record for retry (UPDATE, never DELETE)
 */
export function resetTnRecordForRetry(contactId: number): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE therapy_notes_records
    SET tn_status = 'in_progress',
        failure_reason = NULL,
        updated_at = datetime('now')
    WHERE contact_id = ?
  `).run(contactId);

  console.log(`[therapy-notes-db] Reset contact ${contactId} for retry`);
}

/**
 * Check if a record is stale (in_progress for more than 5 minutes)
 */
export function isStaleInProgress(record: TherapyNotesRecord): boolean {
  if (record.tnStatus !== "in_progress") return false;

  const updatedAt = new Date(record.updatedAt + "Z").getTime();
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  return updatedAt < fiveMinutesAgo;
}
