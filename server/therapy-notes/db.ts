/**
 * TherapyNotes Database
 *
 * PostgreSQL storage for TN patient creation records.
 * Uses the shared connection pool from ../db/pool.
 */

import { getPool } from "../db/pool";
import type { TherapyNotesRecord, CreateTnRecordParams } from "./types";

/**
 * Initialize the therapy_notes_records table (call at startup after pool is ready)
 */
export async function initTherapyNotesTable(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS therapy_notes_records (
      id               SERIAL PRIMARY KEY,
      contact_id       INTEGER NOT NULL UNIQUE,
      contact_name     TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      tn_status        TEXT NOT NULL DEFAULT 'in_progress',
      tn_patient_url   TEXT,
      tn_patient_id    TEXT,
      failure_reason   TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tn_contact_id
      ON therapy_notes_records(contact_id);
  `);

  console.log("[therapy-notes-db] Table initialized");
}

/**
 * Get TN record for a contact
 */
export async function getTnRecord(contactId: number): Promise<TherapyNotesRecord | null> {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      id,
      contact_id       as "contactId",
      contact_name     as "contactName",
      created_by_email as "createdByEmail",
      tn_status        as "tnStatus",
      tn_patient_url   as "tnPatientUrl",
      tn_patient_id    as "tnPatientId",
      failure_reason   as "failureReason",
      created_at       as "createdAt",
      updated_at       as "updatedAt"
    FROM therapy_notes_records
    WHERE contact_id = $1
  `, [contactId]);

  return result.rows[0] ?? null;
}

/**
 * Create a new TN record with status 'in_progress'
 */
export async function createTnRecord(params: CreateTnRecordParams): Promise<number> {
  const pool = getPool();

  const result = await pool.query(`
    INSERT INTO therapy_notes_records (contact_id, contact_name, created_by_email, tn_status)
    VALUES ($1, $2, $3, 'in_progress')
    RETURNING id
  `, [params.contactId, params.contactName, params.createdByEmail]);

  const id = result.rows[0].id as number;
  console.log(`[therapy-notes-db] Created record ${id} for contact ${params.contactId}`);
  return id;
}

/**
 * Update TN record status with optional URL/ID or failure reason
 */
export async function updateTnStatus(
  contactId: number,
  status: "created" | "failed",
  opts?: { url?: string; id?: string; failureReason?: string }
): Promise<void> {
  const pool = getPool();

  await pool.query(`
    UPDATE therapy_notes_records
    SET tn_status = $1,
        tn_patient_url = COALESCE($2, tn_patient_url),
        tn_patient_id = COALESCE($3, tn_patient_id),
        failure_reason = $4,
        updated_at = NOW()
    WHERE contact_id = $5
  `, [
    status,
    opts?.url ?? null,
    opts?.id ?? null,
    opts?.failureReason ?? null,
    contactId
  ]);

  console.log(`[therapy-notes-db] Updated contact ${contactId} → ${status}`);
}

/**
 * Manually reset a "created" link (e.g. patient deleted in TherapyNotes)
 */
export async function resetTnLink(contactId: number): Promise<void> {
  const pool = getPool();

  await pool.query(`
    UPDATE therapy_notes_records
    SET tn_status = 'failed',
        tn_patient_url = NULL,
        tn_patient_id = NULL,
        failure_reason = 'Manually reset',
        updated_at = NOW()
    WHERE contact_id = $1
  `, [contactId]);

  console.log(`[therapy-notes-db] Manually reset link for contact ${contactId}`);
}

/**
 * Reset a failed or stale record for retry (UPDATE, never DELETE)
 */
export async function resetTnRecordForRetry(contactId: number): Promise<void> {
  const pool = getPool();

  await pool.query(`
    UPDATE therapy_notes_records
    SET tn_status = 'in_progress',
        failure_reason = NULL,
        updated_at = NOW()
    WHERE contact_id = $1
  `, [contactId]);

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
