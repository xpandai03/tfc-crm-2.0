/**
 * Reminders Database
 *
 * SQLite database for storing email reminders.
 * Uses better-sqlite3 for synchronous, performant access.
 */

import Database from "better-sqlite3";
import path from "path";
import type { Reminder, CreateReminderParams } from "./types";

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
