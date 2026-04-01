/**
 * Provider Assignments Database
 *
 * CRM-only storage for provider assignment records.
 * Uses the same SQLite database as reminders, intake comments, etc.
 */

import { getDatabase } from "../reminders/db";

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
export function initAssignmentsTable(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_provider_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      contact_name TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      credential TEXT NOT NULL,
      assignment_comment TEXT,
      assigned_by_email TEXT NOT NULL,
      assigned_by_initials TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'manual'
    );

    CREATE INDEX IF NOT EXISTS idx_assignments_contact
      ON contact_provider_assignments(contact_id);
  `);

  console.log("[assignments-db] Assignments table initialized");
}

/**
 * Create a new provider assignment
 */
export function createAssignment(params: CreateAssignmentParams): { assignmentId: number } {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO contact_provider_assignments (
      contact_id, contact_name, provider_name, credential,
      assignment_comment, assigned_by_email, assigned_by_initials, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    params.contactId,
    params.contactName,
    params.providerName,
    params.credential,
    params.assignmentComment || null,
    params.assignedByEmail,
    params.assignedByInitials,
    params.source || "manual",
  );

  const assignmentId = result.lastInsertRowid as number;
  console.log(`[assignments-db] Created assignment ${assignmentId} for contact ${params.contactId}: ${params.providerName}`);

  return { assignmentId };
}

/**
 * Get all assignments for a contact, newest first
 */
export function getAssignmentsByContact(contactId: number): ProviderAssignment[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT
      id,
      contact_id as contactId,
      contact_name as contactName,
      provider_name as providerName,
      credential,
      assignment_comment as assignmentComment,
      assigned_by_email as assignedByEmail,
      assigned_by_initials as assignedByInitials,
      assigned_at as assignedAt,
      source
    FROM contact_provider_assignments
    WHERE contact_id = ?
    ORDER BY assigned_at DESC
  `);

  return stmt.all(contactId) as ProviderAssignment[];
}

/**
 * Get the most recent assignment for a contact (for header badge)
 */
export function getLatestAssignment(contactId: number): ProviderAssignment | null {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT
      id,
      contact_id as contactId,
      contact_name as contactName,
      provider_name as providerName,
      credential,
      assignment_comment as assignmentComment,
      assigned_by_email as assignedByEmail,
      assigned_by_initials as assignedByInitials,
      assigned_at as assignedAt,
      source
    FROM contact_provider_assignments
    WHERE contact_id = ?
    ORDER BY assigned_at DESC
    LIMIT 1
  `);

  return (stmt.get(contactId) as ProviderAssignment) || null;
}

/**
 * Delete an assignment by ID
 */
export function deleteAssignment(assignmentId: number): boolean {
  const db = getDatabase();
  const result = db.prepare(
    `DELETE FROM contact_provider_assignments WHERE id = ?`
  ).run(assignmentId);
  if (result.changes > 0) {
    console.log(`[assignments-db] Deleted assignment ${assignmentId}`);
  }
  return result.changes > 0;
}
