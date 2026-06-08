/**
 * Provider Assignments Database
 *
 * CRM-only storage for provider assignment records.
 * Uses PostgreSQL via the shared pool.
 */

import { getPool } from "../db/pool";

export interface ProviderAssignment {
  id: number;
  contactId: number;
  contactName: string;
  providerName: string;
  credential: string;
  assignmentComment: string | null;
  assignedByEmail: string;
  assignedByInitials: string;
  assignedAt: string;
  source: string;
}

export interface CreateAssignmentParams {
  contactId: number;
  contactName: string;
  providerName: string;
  credential: string;
  assignmentComment?: string;
  assignedByEmail: string;
  assignedByInitials: string;
  source?: string;
}

/**
 * Initialize the assignments table (idempotent)
 */
export async function initAssignmentsTable(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_provider_assignments (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      contact_name TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      credential TEXT NOT NULL,
      assignment_comment TEXT,
      assigned_by_email TEXT NOT NULL,
      assigned_by_initials TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL DEFAULT 'manual'
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_assignments_contact
      ON contact_provider_assignments(contact_id);
  `);

  console.log("[assignments-db] Assignments table initialized");
}

/**
 * Create a new provider assignment
 */
export async function createAssignment(params: CreateAssignmentParams): Promise<{ assignmentId: number }> {
  const pool = getPool();

  const result = await pool.query(
    `INSERT INTO contact_provider_assignments (
      contact_id, contact_name, provider_name, credential,
      assignment_comment, assigned_by_email, assigned_by_initials, source
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id`,
    [
      params.contactId,
      params.contactName,
      params.providerName,
      params.credential,
      params.assignmentComment || null,
      params.assignedByEmail,
      params.assignedByInitials,
      params.source || "manual",
    ]
  );

  const assignmentId = result.rows[0].id as number;
  console.log(`[assignments-db] Created assignment ${assignmentId} for contact ${params.contactId}: ${params.providerName}`);

  return { assignmentId };
}

/**
 * Get all assignments for a contact, newest first
 */
export async function getAssignmentsByContact(contactId: number): Promise<ProviderAssignment[]> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT
      id,
      contact_id AS "contactId",
      contact_name AS "contactName",
      provider_name AS "providerName",
      credential,
      assignment_comment AS "assignmentComment",
      assigned_by_email AS "assignedByEmail",
      assigned_by_initials AS "assignedByInitials",
      assigned_at AS "assignedAt",
      source
    FROM contact_provider_assignments
    WHERE contact_id = $1
    ORDER BY assigned_at DESC`,
    [contactId]
  );

  return result.rows as ProviderAssignment[];
}

/**
 * Get the most recent assignment for a contact (for header badge)
 */
export async function getLatestAssignment(contactId: number): Promise<ProviderAssignment | null> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT
      id,
      contact_id AS "contactId",
      contact_name AS "contactName",
      provider_name AS "providerName",
      credential,
      assignment_comment AS "assignmentComment",
      assigned_by_email AS "assignedByEmail",
      assigned_by_initials AS "assignedByInitials",
      assigned_at AS "assignedAt",
      source
    FROM contact_provider_assignments
    WHERE contact_id = $1
    ORDER BY assigned_at DESC
    LIMIT 1`,
    [contactId]
  );

  return (result.rows[0] as ProviderAssignment) || null;
}

/**
 * Delete an assignment by ID
 */
export async function deleteAssignment(assignmentId: number): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM contact_provider_assignments WHERE id = $1`,
    [assignmentId]
  );
  if (result.rowCount && result.rowCount > 0) {
    console.log(`[assignments-db] Deleted assignment ${assignmentId}`);
  }
  return (result.rowCount ?? 0) > 0;
}

/**
 * Get the latest provider assignment for every contact that has one.
 * Returns a map of contactId → providerName for efficient bulk lookups.
 */
export async function getLatestAssignmentsByAllContacts(): Promise<Map<number, string>> {
  const pool = getPool();

  const result = await pool.query(`
    SELECT DISTINCT ON (contact_id)
      contact_id AS "contactId",
      provider_name AS "providerName"
    FROM contact_provider_assignments
    ORDER BY contact_id, assigned_at DESC
  `);

  const map = new Map<number, string>();
  for (const row of result.rows) {
    map.set(row.contactId as number, row.providerName as string);
  }
  return map;
}

/**
 * Get the latest (current) provider assignment for every contact that has
 * one, with the assignment timestamp. One entry per contact — the newest
 * row, via the same DISTINCT ON pattern as getLatestAssignmentsByAllContacts.
 *
 * Used to compute each provider's effective accepting-count: the number of
 * contacts currently assigned to them since their last availability-form
 * submission.
 */
export async function getLatestAssignmentsWithDates(): Promise<
  { providerName: string; assignedAt: Date }[]
> {
  const pool = getPool();

  const result = await pool.query(`
    SELECT DISTINCT ON (contact_id)
      provider_name AS "providerName",
      assigned_at AS "assignedAt"
    FROM contact_provider_assignments
    ORDER BY contact_id, assigned_at DESC
  `);

  return result.rows.map((row) => ({
    providerName: row.providerName as string,
    assignedAt: new Date(row.assignedAt as string),
  }));
}

/**
 * Count contacts whose CURRENT assignment points at the given provider.
 * "Current" = the latest row per contact, the same DISTINCT ON (contact_id)
 * ORDER BY assigned_at DESC definition used for effective accepting-count.
 * There is no closed/active status column on assignments, so this latest-row
 * notion is the established "currently assigned" definition.
 *
 * Name match is credential-insensitive: assignment provider_name may carry a
 * ", Credential" suffix while crm_providers.name does not, so we compare the
 * bare name (text before the first comma), trimmed and lowercased — mirroring
 * the normalizeProviderName logic used in the providers read path.
 */
export async function countActiveAssignmentsForProvider(providerName: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM (
       SELECT DISTINCT ON (contact_id) provider_name
       FROM contact_provider_assignments
       ORDER BY contact_id, assigned_at DESC
     ) latest
     WHERE lower(trim(split_part(latest.provider_name, ',', 1)))
         = lower(trim(split_part($1, ',', 1)))`,
    [providerName]
  );
  return (result.rows[0]?.n as number) ?? 0;
}
