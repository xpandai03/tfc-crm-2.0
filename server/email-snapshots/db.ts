/**
 * Email Snapshots Database
 *
 * SQLite storage for rendered email HTML captured at send time.
 * Reuses the same database instance from reminders/db.ts.
 */

import { getDatabase } from "../reminders/db";
import type { EmailSnapshot, CreateEmailSnapshotParams } from "./types";

/**
 * Initialize the email_snapshots table (call at startup after initDatabase)
 */
export function initEmailSnapshotsTable(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      template_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      sent_by_email TEXT NOT NULL,
      cc_emails TEXT NOT NULL DEFAULT '[]',
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_contact
      ON email_snapshots(contact_id);
  `);

  // Additive migration: add cc_emails column if missing (existing tables)
  try {
    db.exec(`ALTER TABLE email_snapshots ADD COLUMN cc_emails TEXT NOT NULL DEFAULT '[]'`);
    console.log("[email-snapshots-db] Added cc_emails column");
  } catch {
    // Column already exists — expected on subsequent startups
  }

  console.log("[email-snapshots-db] Table initialized");
}

/**
 * Save a rendered email snapshot. Returns the new row ID.
 */
export function saveEmailSnapshot(params: CreateEmailSnapshotParams): number {
  const db = getDatabase();

  const ccJson = JSON.stringify(params.ccEmails || []);

  const result = db.prepare(`
    INSERT INTO email_snapshots (contact_id, template_id, subject, body_html, sent_by_email, cc_emails)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.contactId,
    params.templateId,
    params.subject,
    params.bodyHtml,
    params.sentByEmail,
    ccJson,
  );

  const id = result.lastInsertRowid as number;
  console.log(`[email-snapshots-db] Saved snapshot ${id} for contact ${params.contactId} (${params.templateId}), CC: ${ccJson}`);
  return id;
}

/**
 * Get a single snapshot by ID (includes bodyHtml for download)
 */
export function getEmailSnapshot(id: number): EmailSnapshot | null {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT
      id,
      contact_id   as contactId,
      template_id  as templateId,
      subject,
      body_html    as bodyHtml,
      sent_by_email as sentByEmail,
      cc_emails    as ccEmails,
      sent_at      as sentAt
    FROM email_snapshots
    WHERE id = ?
  `).get(id) as EmailSnapshot | undefined;

  return row ?? null;
}

/**
 * Get all snapshots for a contact (metadata only, no bodyHtml)
 */
export function getSnapshotsForContact(contactId: number): Omit<EmailSnapshot, "bodyHtml">[] {
  const db = getDatabase();

  return db.prepare(`
    SELECT
      id,
      contact_id   as contactId,
      template_id  as templateId,
      subject,
      sent_by_email as sentByEmail,
      sent_at      as sentAt
    FROM email_snapshots
    WHERE contact_id = ?
    ORDER BY sent_at DESC
  `).all(contactId) as Omit<EmailSnapshot, "bodyHtml">[];
}
