/**
 * Reminders Database
 *
 * SQLite database for storing email reminders.
 * Uses better-sqlite3 for synchronous, performant access.
 */

import Database from "better-sqlite3";
import path from "path";
import type { Reminder, CreateReminderParams, IntakeComment, AttentionFlag, CreateIntakeCommentParams } from "./types";

// Database path - uses /data volume in production (Fly.io)
// Falls back to local directory in development
const DB_PATH =
  process.env.NODE_ENV === "production"
    ? "/data/reminders.db"
    : path.join(process.cwd(), "reminders.db");

let db: Database.Database | null = null;

/**
 * Initialize the database and create tables if needed
 */
export function initDatabase(): Database.Database {
  if (db) return db;

  console.log(`[reminders-db] Initializing database at: ${DB_PATH}`);

  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  // Create reminders table
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      contact_name TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      reminder_text TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      is_second_reminder INTEGER NOT NULL DEFAULT 0,
      parent_reminder_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      FOREIGN KEY (parent_reminder_id) REFERENCES reminders(id)
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_due_status
      ON reminders(due_at, status);

    CREATE INDEX IF NOT EXISTS idx_reminders_status
      ON reminders(status);
  `);

  // Create intake_comments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS intake_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      contact_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      author_initials TEXT NOT NULL,
      comment_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_intake_comments_contact
      ON intake_comments(contact_id);
  `);

  // Create attention_flags table
  db.exec(`
    CREATE TABLE IF NOT EXISTS attention_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      flagged_by_email TEXT NOT NULL,
      flagged_at TEXT NOT NULL DEFAULT (datetime('now')),
      cleared_by_email TEXT,
      cleared_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attention_flags_contact
      ON attention_flags(contact_id);

    CREATE INDEX IF NOT EXISTS idx_attention_flags_active
      ON attention_flags(cleared_at);
  `);

  console.log("[reminders-db] Database initialized successfully");
  return db;
}

/**
 * Get the database instance (initializes if needed)
 */
export function getDatabase(): Database.Database {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * Create a new reminder (and optional second reminder)
 */
export function createReminder(params: CreateReminderParams): {
  id: number;
  secondId?: number;
} {
  const db = getDatabase();

  const insertStmt = db.prepare(`
    INSERT INTO reminders (
      contact_id, contact_name, created_by_email, reminder_text,
      due_at, is_second_reminder, parent_reminder_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Insert primary reminder
  const result = insertStmt.run(
    params.contactId,
    params.contactName,
    params.createdByEmail,
    params.reminderText,
    params.reminderDateTime,
    0, // is_second_reminder = false
    null
  );

  const primaryId = result.lastInsertRowid as number;
  let secondId: number | undefined;

  // Insert second reminder if provided
  if (params.secondReminderDateTime) {
    const secondResult = insertStmt.run(
      params.contactId,
      params.contactName,
      params.createdByEmail,
      params.reminderText,
      params.secondReminderDateTime,
      1, // is_second_reminder = true
      primaryId
    );
    secondId = secondResult.lastInsertRowid as number;
  }

  console.log(
    `[reminders-db] Created reminder ${primaryId}${secondId ? ` with second reminder ${secondId}` : ""}`
  );

  return { id: primaryId, secondId };
}

/**
 * Get all pending reminders that are due
 */
export function getDueReminders(): Reminder[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT
      id,
      contact_id as contactId,
      contact_name as contactName,
      created_by_email as createdByEmail,
      reminder_text as reminderText,
      due_at as dueAt,
      status,
      retry_count as retryCount,
      is_second_reminder as isSecondReminder,
      parent_reminder_id as parentReminderId,
      created_at as createdAt,
      sent_at as sentAt
    FROM reminders
    WHERE status = 'pending'
      AND datetime(due_at) <= datetime('now')
      AND retry_count < 3
    ORDER BY due_at ASC
  `);

  const rows = stmt.all() as Record<string, unknown>[];

  // Convert SQLite integers to booleans
  return rows.map((row) => ({
    ...row,
    isSecondReminder: row.isSecondReminder === 1,
  })) as Reminder[];
}

/**
 * Mark reminder as sent
 */
export function markReminderSent(id: number): void {
  const db = getDatabase();

  db.prepare(
    `
    UPDATE reminders
    SET status = 'sent', sent_at = datetime('now')
    WHERE id = ?
  `
  ).run(id);

  console.log(`[reminders-db] Marked reminder ${id} as sent`);
}

/**
 * Mark reminder as failed and increment retry count
 */
export function markReminderFailed(id: number): void {
  const db = getDatabase();

  db.prepare(
    `
    UPDATE reminders
    SET status = CASE WHEN retry_count >= 2 THEN 'failed' ELSE 'pending' END,
        retry_count = retry_count + 1
    WHERE id = ?
  `
  ).run(id);

  console.log(`[reminders-db] Marked reminder ${id} as failed, incremented retry count`);
}

/**
 * Get reminder stats for monitoring
 */
export function getReminderStats(): {
  pending: number;
  sent: number;
  failed: number;
} {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT
      status,
      COUNT(*) as count
    FROM reminders
    GROUP BY status
  `);

  const rows = stmt.all() as { status: string; count: number }[];

  const stats = { pending: 0, sent: 0, failed: 0 };
  rows.forEach((row) => {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = row.count;
    }
  });

  return stats;
}

// ============================================================================
// Intake Comments
// ============================================================================

/**
 * Get all comments for a contact, newest first
 */
export function getIntakeComments(contactId: number): IntakeComment[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT
      id,
      contact_id as contactId,
      contact_name as contactName,
      author_email as authorEmail,
      author_initials as authorInitials,
      comment_text as commentText,
      created_at as createdAt
    FROM intake_comments
    WHERE contact_id = ?
    ORDER BY created_at DESC
  `);

  return stmt.all(contactId) as IntakeComment[];
}

/**
 * Create a new intake comment and auto-create attention flag if none active
 */
export function createIntakeComment(params: CreateIntakeCommentParams): {
  commentId: number;
  flagCreated: boolean;
} {
  const db = getDatabase();

  // Insert comment
  const insertStmt = db.prepare(`
    INSERT INTO intake_comments (contact_id, contact_name, author_email, author_initials, comment_text)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = insertStmt.run(
    params.contactId,
    params.contactName,
    params.authorEmail,
    params.authorInitials,
    params.commentText
  );

  const commentId = result.lastInsertRowid as number;

  // Auto-create attention flag if no active flag exists
  let flagCreated = false;
  const existingFlag = db.prepare(`
    SELECT id FROM attention_flags
    WHERE contact_id = ? AND cleared_at IS NULL
  `).get(params.contactId);

  if (!existingFlag) {
    db.prepare(`
      INSERT INTO attention_flags (contact_id, flagged_by_email)
      VALUES (?, ?)
    `).run(params.contactId, params.authorEmail);
    flagCreated = true;
    console.log(`[intake-comments] Auto-created attention flag for contact ${params.contactId}`);
  }

  console.log(`[intake-comments] Created comment ${commentId} for contact ${params.contactId}`);
  return { commentId, flagCreated };
}

// ============================================================================
// Attention Flags
// ============================================================================

/**
 * Get all active (uncleared) attention flags
 */
export function getActiveAttentionFlags(): AttentionFlag[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT
      id,
      contact_id as contactId,
      flagged_by_email as flaggedByEmail,
      flagged_at as flaggedAt,
      cleared_by_email as clearedByEmail,
      cleared_at as clearedAt
    FROM attention_flags
    WHERE cleared_at IS NULL
    ORDER BY flagged_at DESC
  `);

  return stmt.all() as AttentionFlag[];
}

/**
 * Clear an attention flag for a contact
 */
export function clearAttentionFlag(contactId: number, clearedByEmail: string): boolean {
  const db = getDatabase();

  const result = db.prepare(`
    UPDATE attention_flags
    SET cleared_by_email = ?, cleared_at = datetime('now')
    WHERE contact_id = ? AND cleared_at IS NULL
  `).run(clearedByEmail, contactId);

  const cleared = result.changes > 0;
  if (cleared) {
    console.log(`[attention-flags] Cleared flag for contact ${contactId} by ${clearedByEmail}`);
  }
  return cleared;
}
