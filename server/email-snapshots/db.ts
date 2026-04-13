/**
 * Email Snapshots Database
 *
 * PostgreSQL storage for rendered email HTML captured at send time.
 * Uses the shared connection pool from ../db/pool.
 */

import { getPool } from "../db/pool";
import type { EmailSnapshot, CreateEmailSnapshotParams } from "./types";

/**
 * Initialize the email_snapshots table (call at startup after pool is ready)
 */
export async function initEmailSnapshotsTable(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_snapshots (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      template_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      sent_by_email TEXT NOT NULL,
      sender_email TEXT,
      recipient_email TEXT,
      cc_emails TEXT NOT NULL DEFAULT '[]',
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_snapshots_contact
      ON email_snapshots(contact_id)
  `);

  // Additive migrations for existing tables
  const additiveColumns: Array<[string, string]> = [
    ["cc_emails", `ALTER TABLE email_snapshots ADD COLUMN cc_emails TEXT NOT NULL DEFAULT '[]'`],
    ["sender_email", `ALTER TABLE email_snapshots ADD COLUMN sender_email TEXT`],
    ["recipient_email", `ALTER TABLE email_snapshots ADD COLUMN recipient_email TEXT`],
  ];
  for (const [name, sql] of additiveColumns) {
    try {
      await pool.query(sql);
      console.log(`[email-snapshots-db] Added ${name} column`);
    } catch {
      // Column already exists — expected on subsequent startups
    }
  }

  console.log("[email-snapshots-db] Table initialized");
}

/**
 * Save a rendered email snapshot. Returns the new row ID.
 */
export async function saveEmailSnapshot(params: CreateEmailSnapshotParams): Promise<number> {
  const pool = getPool();

  const ccJson = JSON.stringify(params.ccEmails || []);

  const result = await pool.query(
    `INSERT INTO email_snapshots (contact_id, template_id, subject, body_html, sent_by_email, sender_email, recipient_email, cc_emails)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      params.contactId,
      params.templateId,
      params.subject,
      params.bodyHtml,
      params.sentByEmail,
      params.senderEmail,
      params.recipientEmail,
      ccJson,
    ]
  );

  const id = result.rows[0].id as number;
  console.log(`[email-snapshots-db] Saved snapshot ${id} for contact ${params.contactId} (${params.templateId}), CC: ${ccJson}`);
  return id;
}

/**
 * Get a single snapshot by ID (includes bodyHtml for download)
 */
export async function getEmailSnapshot(id: number): Promise<EmailSnapshot | null> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT
      id,
      contact_id    as "contactId",
      template_id   as "templateId",
      subject,
      body_html     as "bodyHtml",
      sent_by_email as "sentByEmail",
      sender_email  as "senderEmail",
      recipient_email as "recipientEmail",
      cc_emails     as "ccEmails",
      sent_at       as "sentAt"
    FROM email_snapshots
    WHERE id = $1`,
    [id]
  );

  const row = result.rows[0] as EmailSnapshot | undefined;
  return row ?? null;
}

/**
 * Get all snapshots for a contact (metadata only, no bodyHtml)
 */
export async function getSnapshotsForContact(contactId: number): Promise<Omit<EmailSnapshot, "bodyHtml">[]> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT
      id,
      contact_id   as "contactId",
      template_id  as "templateId",
      subject,
      sent_by_email as "sentByEmail",
      sent_at      as "sentAt"
    FROM email_snapshots
    WHERE contact_id = $1
    ORDER BY sent_at DESC`,
    [contactId]
  );

  return result.rows as Omit<EmailSnapshot, "bodyHtml">[];
}
