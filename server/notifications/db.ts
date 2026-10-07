/**
 * Teams notification queue + per-person mute.
 *
 * CRM-ONLY TABLES, created on boot (CREATE TABLE IF NOT EXISTS — no migration
 * step). The n8n sync never touches them.
 *
 * notifications — one row per (event, recipient). Rows that were never meant to
 * leave (muted, deduped, kill switch, self, no webhook) are KEPT with that
 * status, so the admin log shows what WOULD have gone out. That is how staff
 * get switched on: watch the log for a day, then unmute.
 *
 * notification_preferences — keyed on email (there is no users table; identity
 * is the Azure AD session). No row = not muted. Every rule recipient is seeded
 * MUTED on first boot, so nothing reaches staff until someone unmutes them.
 * ON CONFLICT DO NOTHING: a later boot never re-mutes a person who was unmuted.
 */
import { getPool } from "../db/pool";
import { notificationRecipients, type NotificationContact } from "@shared/notification-rules";

export type NotificationStatus =
  | "pending"   // queued, waiting for the worker
  | "sending"   // claimed by the worker
  | "sent"      // webhook accepted it
  | "failed"    // out of attempts
  | "muted"     // recipient muted — not sent
  | "deduped"   // same recipient + event + contact within the window — not sent
  | "disabled"  // NOTIFICATIONS_ENABLED=false — not sent
  | "self"      // the recipient made the change themselves — not sent
  | "no_url"    // TEAMS_NOTIFY_URL unset — dropped
  | "blocked";  // text tripped the PHI backstop — never sent

export const DEDUPE_WINDOW_MINUTES = 10;
export const MAX_ATTEMPTS = 4; // the first try + 3 retries

export interface NotificationRow {
  id: number;
  recipient: string;
  text: string;
  event: string;
  dedupeKey: string;
  ruleIds: string[];
  contactId: number | null;
  submissionId: number | null;
  status: NotificationStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastHttpStatus: number | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

const COLS = `
  id, recipient, text, event, dedupe_key AS "dedupeKey", rule_ids AS "ruleIds",
  contact_id AS "contactId", submission_id AS "submissionId", status, attempts,
  next_attempt_at AS "nextAttemptAt", last_http_status AS "lastHttpStatus", error,
  created_at AS "createdAt", sent_at AS "sentAt"`;

/** Developer address: never seeded muted. */
export const NOTIFICATION_UNMUTED_BY_DEFAULT = ["raunek@tfc.health"];

export async function initNotificationTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id               SERIAL PRIMARY KEY,
      recipient        TEXT        NOT NULL,
      text             TEXT        NOT NULL,
      event            TEXT        NOT NULL,
      dedupe_key       TEXT        NOT NULL,
      rule_ids         TEXT[]      NOT NULL DEFAULT '{}',
      contact_id       INTEGER,
      submission_id    INTEGER,
      status           TEXT        NOT NULL,
      attempts         INTEGER     NOT NULL DEFAULT 0,
      next_attempt_at  TIMESTAMPTZ,
      last_http_status INTEGER,
      error            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at          TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_due
      ON notifications(next_attempt_at) WHERE status = 'pending'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_dedupe
      ON notifications(recipient, dedupe_key, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      email      TEXT        PRIMARY KEY,
      muted      BOOLEAN     NOT NULL DEFAULT FALSE,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const seed = notificationRecipients().filter((e) => !NOTIFICATION_UNMUTED_BY_DEFAULT.includes(e));
  if (seed.length > 0) {
    await pool.query(
      `INSERT INTO notification_preferences (email, muted, updated_by)
       SELECT unnest($1::text[]), TRUE, 'seed'
       ON CONFLICT (email) DO NOTHING`,
      [seed],
    );
  }
  // A crash mid-send leaves rows in 'sending'. Put them back; at worst one
  // message is delivered twice, which beats never.
  await pool.query(
    `UPDATE notifications SET status = 'pending', next_attempt_at = NOW()
      WHERE status = 'sending' AND next_attempt_at < NOW() - INTERVAL '5 minutes'`,
  );
  console.log("[notify] Tables initialized");
}

// ---------------------------------------------------------------------------
// Mute
// ---------------------------------------------------------------------------

export async function isMuted(email: string): Promise<boolean> {
  const r = await getPool().query(
    `SELECT muted FROM notification_preferences WHERE email = $1`,
    [email.trim().toLowerCase()],
  );
  return r.rows[0]?.muted === true;
}

export async function setMuted(email: string, muted: boolean, updatedBy: string): Promise<void> {
  await getPool().query(
    `INSERT INTO notification_preferences (email, muted, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (email) DO UPDATE SET muted = EXCLUDED.muted,
       updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [email.trim().toLowerCase(), muted, updatedBy],
  );
}

export async function listPreferences(): Promise<Array<{ email: string; muted: boolean; updatedBy: string | null; updatedAt: string }>> {
  const r = await getPool().query(
    `SELECT email, muted, updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM notification_preferences ORDER BY email`,
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  recipient: string;
  text: string;
  event: string;
  dedupeKey: string;
  ruleIds: string[];
  contactId: number | null;
  submissionId: number | null;
  /** Decided by the caller (mute, kill switch, …). 'pending' may still become 'deduped'. */
  status: NotificationStatus;
}

/**
 * Insert one row. A 'pending' row is checked against the dedupe window under a
 * per-key advisory lock, so two events racing for the same person and contact
 * cannot both get through.
 */
export async function enqueueNotification(input: EnqueueInput): Promise<{ id: number; status: NotificationStatus }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let status = input.status;
    if (status === "pending") {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${input.recipient}|${input.dedupeKey}`]);
      const dup = await client.query(
        `SELECT 1 FROM notifications
          WHERE recipient = $1 AND dedupe_key = $2
            AND status IN ('pending', 'sending', 'sent')
            AND created_at > NOW() - make_interval(mins => $3)
          LIMIT 1`,
        [input.recipient, input.dedupeKey, DEDUPE_WINDOW_MINUTES],
      );
      if (dup.rows.length > 0) status = "deduped";
    }
    const r = await client.query(
      `INSERT INTO notifications
         (recipient, text, event, dedupe_key, rule_ids, contact_id, submission_id, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 = 'pending' THEN NOW() ELSE NULL END)
       RETURNING id`,
      [input.recipient, input.text, input.event, input.dedupeKey, input.ruleIds,
       input.contactId, input.submissionId, status],
    );
    await client.query("COMMIT");
    return { id: r.rows[0].id, status };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Claim due rows (SKIP LOCKED: safe if a second machine ever runs the worker). */
export async function claimDueNotifications(limit: number): Promise<NotificationRow[]> {
  const r = await getPool().query(
    `UPDATE notifications SET status = 'sending'
      WHERE id IN (
        SELECT id FROM notifications
         WHERE status = 'pending' AND next_attempt_at <= NOW()
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING ${COLS}`,
    [limit],
  );
  return r.rows;
}

export async function markNotificationSent(id: number, attempts: number, httpStatus: number): Promise<void> {
  await getPool().query(
    `UPDATE notifications SET status = 'sent', attempts = $2, last_http_status = $3,
            error = NULL, sent_at = NOW(), next_attempt_at = NULL
      WHERE id = $1`,
    [id, attempts, httpStatus],
  );
}

export async function markNotificationRetry(
  id: number, attempts: number, delayMs: number, httpStatus: number | null, error: string,
): Promise<void> {
  await getPool().query(
    `UPDATE notifications SET status = 'pending', attempts = $2,
            next_attempt_at = NOW() + make_interval(secs => $3::double precision / 1000),
            last_http_status = $4, error = $5
      WHERE id = $1`,
    [id, attempts, delayMs, httpStatus, error],
  );
}

export async function markNotificationFailed(
  id: number, attempts: number, httpStatus: number | null, error: string,
): Promise<void> {
  await getPool().query(
    `UPDATE notifications SET status = 'failed', attempts = $2, last_http_status = $3,
            error = $4, next_attempt_at = NULL
      WHERE id = $1`,
    [id, attempts, httpStatus, error],
  );
}

export async function getNotificationById(id: number): Promise<NotificationRow | null> {
  const r = await getPool().query(`SELECT ${COLS} FROM notifications WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function getRecentNotifications(limit = 200): Promise<NotificationRow[]> {
  const r = await getPool().query(
    `SELECT ${COLS} FROM notifications ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return r.rows;
}

/** The contact fields rules and templates read — and nothing else. */
export async function loadNotificationContact(contactId: number): Promise<NotificationContact | null> {
  const r = await getPool().query(
    `SELECT contact_id AS "contactId", name, status_code AS "statusCode",
            assigned_to AS "assignedTo", insurance_payer AS "insurancePayer"
       FROM sync_contacts WHERE contact_id = $1`,
    [contactId],
  );
  return r.rows[0] ?? null;
}
