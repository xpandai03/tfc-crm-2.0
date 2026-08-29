/**
 * Durable record of every report send attempt, and what became of it.
 *
 * WHY THIS IS A SEPARATE TABLE FROM report_sends
 * ----------------------------------------------
 * `report_sends` is the duplicate-send GUARD: one row per period, claimed
 * before sending, `report_key` as the primary key. Its whole job is to stop the
 * CEO receiving the same report twice.
 *
 * The obvious way to record test sends would have been to add an `is_test`
 * column to that table and filter it out of the guard query. That would have
 * meant altering the primary key of the table the Sept 1 send depends on, three
 * days before it fires, so that a test row and a real row for the same period
 * could coexist. Get the partial index subtly wrong and the cron finds a claim
 * that should not be there and SILENTLY SKIPS — which is precisely the failure
 * this build exists to prevent.
 *
 * So the guard table is not touched at all. Test sends are recorded HERE and
 * never write to `report_sends`, which makes "a test never claims a period" a
 * structural property rather than a predicate someone has to keep correct.
 *
 * NO PHI. Recipients and actors are staff email addresses. The report itself is
 * aggregate counts only and none of its content is stored here. Delivery events
 * contribute a status and a short reason string, never a message body.
 */

import { getPool } from "../db/pool";

export type SendOutcome = "accepted" | "failed";
export type DeliveryStatus =
  | "delivered" | "bounced" | "complained" | "delivery_delayed" | "opened" | "clicked" | "sent";

export interface SendLogEntry {
  reportKind: string;
  period: string;
  isTest: boolean;
  trigger: "cron" | "manual";
  actor: string | null;
  recipients: string[];
  outcome: SendOutcome;
  /** The provider's id — the join key between our records and their dashboard. */
  messageId: string | null;
  providerError: string | null;
}

export async function initReportSendLogTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_send_log (
      id              SERIAL PRIMARY KEY,
      report_kind     TEXT        NOT NULL,
      period          TEXT        NOT NULL,
      is_test         BOOLEAN     NOT NULL DEFAULT false,
      trigger         TEXT        NOT NULL,
      actor           TEXT,
      recipients      TEXT        NOT NULL,
      attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      outcome         TEXT        NOT NULL,
      message_id      TEXT,
      provider_error  TEXT,
      delivery_status TEXT,
      delivery_at     TIMESTAMPTZ,
      delivery_detail TEXT
    )
  `);
  // message_id is how a webhook event finds its send.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_report_send_log_message ON report_send_log(message_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_report_send_log_period ON report_send_log(report_kind, period)`,
  );
  console.log("[report-send-log] Table initialized");
}

/**
 * Record an attempt. Called for EVERY send — cron or manual, test or real,
 * accepted or failed. A send that threw before reaching the provider is
 * recorded with outcome 'failed' and a null message_id, so "we tried and it
 * never left" is distinguishable from "we never tried".
 *
 * Never throws: a logging failure must not cost the client the report.
 */
export async function recordSendAttempt(entry: SendLogEntry): Promise<number | null> {
  try {
    const res = await getPool().query<{ id: number }>(
      `INSERT INTO report_send_log
         (report_kind, period, is_test, trigger, actor, recipients,
          outcome, message_id, provider_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        entry.reportKind, entry.period, entry.isTest, entry.trigger, entry.actor,
        entry.recipients.join(", "), entry.outcome, entry.messageId, entry.providerError,
      ],
    );
    return res.rows[0]?.id ?? null;
  } catch (error) {
    console.error("[report-send-log] Failed to record attempt:",
      error instanceof Error ? error.message : "unknown");
    return null;
  }
}

/**
 * Terminal states outrank transient ones, so events arriving OUT OF ORDER
 * settle on the meaningful outcome rather than the last one to show up.
 *
 * A bounce that arrives after a delivered event still wins: the message did not
 * reach the person. A delivered event arriving after a bounce does not overwrite
 * it. Equal ranks overwrite, so a later 'opened' replaces an earlier 'opened'.
 */
const STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  opened: 4,
  clicked: 4,
  complained: 9,
  bounced: 10,
};

/**
 * Apply a delivery event to whichever attempt carries that message id.
 * Returns the number of rows updated — 0 means the event was for a message this
 * system did not send, which is normal and not an error.
 */
export async function applyDeliveryEvent(params: {
  messageId: string;
  status: string;
  detail?: string | null;
  occurredAt?: string | null;
}): Promise<number> {
  const rank = STATUS_RANK[params.status] ?? 0;
  const res = await getPool().query(
    `UPDATE report_send_log
        SET delivery_status = $2,
            delivery_at     = COALESCE($4::timestamptz, NOW()),
            delivery_detail = $3
      WHERE message_id = $1
        AND COALESCE(
              CASE delivery_status
                WHEN 'sent' THEN 1 WHEN 'delivery_delayed' THEN 2
                WHEN 'delivered' THEN 3 WHEN 'opened' THEN 4 WHEN 'clicked' THEN 4
                WHEN 'complained' THEN 9 WHEN 'bounced' THEN 10 ELSE 0 END, 0) <= $5`,
    [params.messageId, params.status, params.detail ?? null, params.occurredAt ?? null, rank],
  );
  return res.rowCount ?? 0;
}

/** Recent attempts, for the pre-Sept-1 check and for future UI. */
export async function getRecentSendLog(limit = 20): Promise<Record<string, unknown>[]> {
  const res = await getPool().query(
    `SELECT id, report_kind, period, is_test, trigger, actor, recipients,
            attempted_at, outcome, message_id, provider_error,
            delivery_status, delivery_at, delivery_detail
       FROM report_send_log
      ORDER BY attempted_at DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows;
}
