/**
 * Monthly-report send tracking.
 *
 * ONE JOB: stop the CEO receiving the same report twice.
 *
 * The cron fires on a schedule, and a machine restart at the wrong minute, a
 * future scale-out, or a manual re-run can all replay it. `min_machines_running
 * = 1` makes the multi-machine case unlikely TODAY, which is not the same as
 * safe — and the failure is visible to exactly the person this whole build is
 * meant to reassure.
 *
 * The guard is a claim-before-send row keyed on the reporting period, so two
 * concurrent senders race for a unique-key insert rather than both reading
 * "not sent yet" and both sending. Same shape as markReminderSent.
 *
 * NO CLIENT DATA. This table holds a period string, a timestamp, the recipient
 * addresses and who triggered it. Nothing about any contact.
 */

import { getPool } from "../db/pool";

export type SendTrigger = "cron" | "manual";

export interface ReportSend {
  reportKey: string;
  period: string;
  sentAt: string;
  recipients: string;
  trigger: SendTrigger;
  actor: string | null;
}

/** Composite key, so a future weekly/quarterly report cannot collide. */
export function reportKey(kind: string, period: string): string {
  return `${kind}:${period}`;
}

export async function initReportSendsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS report_sends (
      report_key  TEXT        PRIMARY KEY,
      period      TEXT        NOT NULL,
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recipients  TEXT        NOT NULL,
      trigger     TEXT        NOT NULL,
      actor       TEXT
    )
  `);
  console.log("[report-sends] Table initialized");
}

/** Has this period already gone out? */
export async function wasReportSent(key: string): Promise<ReportSend | null> {
  const res = await getPool().query(
    `SELECT report_key AS "reportKey", period, sent_at AS "sentAt",
            recipients, trigger, actor
       FROM report_sends WHERE report_key = $1`,
    [key],
  );
  return res.rows[0] ?? null;
}

/**
 * Atomically CLAIM a period before sending.
 *
 * Returns true when this caller won the claim and should send; false when a row
 * already existed, meaning someone else already sent (or is sending) it.
 *
 * Claim-then-send, not send-then-record: two machines that both check
 * `wasReportSent` and both get null would both send. `ON CONFLICT DO NOTHING`
 * makes the database the arbiter, so exactly one caller can ever win.
 *
 * The trade is that a send which then FAILS leaves a claim behind and blocks the
 * automatic retry. That is deliberate: a duplicate report to the CEO is worse
 * than a missing one, and a missing one is visible via the failure log and
 * fixable with the manual trigger, which bypasses this guard.
 */
export async function claimReportSend(
  key: string, period: string, recipients: string[],
  trigger: SendTrigger, actor: string | null,
): Promise<boolean> {
  const res = await getPool().query(
    `INSERT INTO report_sends (report_key, period, recipients, trigger, actor)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (report_key) DO NOTHING`,
    [key, period, recipients.join(", "), trigger, actor],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Release a claim after a failed send, so the next cron tick can retry.
 * Only ever called on the failure path.
 */
export async function releaseReportClaim(key: string): Promise<void> {
  await getPool().query(`DELETE FROM report_sends WHERE report_key = $1`, [key]);
  console.warn(`[report-sends] released claim ${key} after a failed send`);
}

/** Record a manual send that deliberately bypassed the guard. */
export async function recordManualSend(
  key: string, period: string, recipients: string[], actor: string | null,
): Promise<void> {
  await getPool().query(
    `INSERT INTO report_sends (report_key, period, recipients, trigger, actor)
     VALUES ($1, $2, $3, 'manual', $4)
     ON CONFLICT (report_key) DO UPDATE SET
       sent_at = NOW(), recipients = EXCLUDED.recipients,
       trigger = 'manual', actor = EXCLUDED.actor`,
    [key, period, recipients.join(", "), actor],
  );
}
