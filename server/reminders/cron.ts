/**
 * Reminder Cron Job
 *
 * Checks for due reminders every minute and sends emails.
 */

import cron from "node-cron";
import { sendMonthlyReport } from "../reports/send";
import { previousPeriod } from "../reports/monthly";
import {
  getDueReminders,
  markReminderSent,
  markReminderFailed,
  getReminderStats,
} from "./db";
import { sendReminderEmail } from "./email";

let isProcessing = false;

/**
 * Process all due reminders
 */
async function processDueReminders(): Promise<void> {
  // Prevent concurrent processing
  if (isProcessing) {
    console.log("[reminder-cron] Skipping - previous run still in progress");
    return;
  }

  isProcessing = true;

  try {
    const dueReminders = await getDueReminders();

    if (dueReminders.length === 0) {
      // Log heartbeat every 15 minutes (when minute is 0, 15, 30, or 45) so we can verify cron is alive
      const minute = new Date().getMinutes();
      if (minute % 15 === 0) {
        const stats = await getReminderStats();
        console.log(`[reminder-cron] Heartbeat — no due reminders. Stats: pending=${stats.pending}, sent=${stats.sent}, failed=${stats.failed}`);
      }
      return;
    }

    console.log(
      `[reminder-cron] Processing ${dueReminders.length} due reminder(s)`
    );

    for (const reminder of dueReminders) {
      try {
        const result = await sendReminderEmail(reminder);

        if (result.success) {
          await markReminderSent(reminder.id);
        } else {
          await markReminderFailed(reminder.id);
          console.warn(
            `[reminder-cron] Failed to send reminder ${reminder.id}: ${result.error}`
          );
        }
      } catch (error) {
        await markReminderFailed(reminder.id);
        console.error(
          `[reminder-cron] Error processing reminder ${reminder.id}:`,
          error
        );
      }
    }

    // Log stats after processing
    const stats = await getReminderStats();
    console.log(
      `[reminder-cron] Stats: pending=${stats.pending}, sent=${stats.sent}, failed=${stats.failed}`
    );
  } finally {
    isProcessing = false;
  }
}

/**
 * Start the cron job
 */
export function startReminderCron(): void {
  console.log("[reminder-cron] Starting reminder cron job (every minute)");

  // Run every minute
  cron.schedule("* * * * *", async () => {
    await processDueReminders();
  });

  // Also run immediately on startup to catch any missed reminders
  console.log("[reminder-cron] Running initial check for overdue reminders...");
  processDueReminders().catch((err) => {
    console.error("[reminder-cron] Error in initial check:", err);
  });
}

/**
 * Manually trigger reminder processing (for testing/debugging)
 */
export async function triggerReminderProcessing(): Promise<void> {
  await processDueReminders();
}

// ============================================================================
// Monthly management report cron
//
// Registered here alongside the reminder cron so there is ONE place to look for
// "what fires on a timer". Follows the same shape: an isProcessing re-entrancy
// guard, and loud logging.
//
// THE THREE THINGS THAT MAKE Sept 1 VERIFIABLE RATHER THAN HOPEFUL
// ----------------------------------------------------------------
// 1. EXPLICIT TIMEZONE. Containers run UTC. "0 8 1 * *" without the timezone
//    option fires at 02:00 Mountain — technically the right day, but the wrong
//    hour, and on a DST boundary it can land on the wrong DAY entirely.
//
// 2. ENV-OVERRIDABLE SCHEDULE. REPORT_CRON_SCHEDULE exists so the schedule can
//    be pointed at a near-future minute IN PRODUCTION, watched to fire with
//    nobody touching it, and then reverted. That rehearsal is the only way to
//    prove unattended firing before the real date, and the real date is the one
//    that cannot be retried.
//
// 3. DUPLICATE-SEND GUARD. In server/reports/db.ts — a claim-before-send row
//    keyed on the period. A restart at the wrong minute must not mean the CEO
//    gets the report twice.
//
// The next-fire time is logged at startup so the deployed schedule can be read
// off the boot log rather than inferred from the cron string.
// ============================================================================

const DEFAULT_REPORT_SCHEDULE = "0 8 1 * *"; // 08:00 on the 1st, Mountain
const REPORT_TIMEZONE = "America/Denver";

let isSendingReport = false;

async function runMonthlyReport(): Promise<void> {
  if (isSendingReport) {
    console.log("[report-cron] Skipping - previous run still in progress");
    return;
  }
  isSendingReport = true;
  try {
    const period = previousPeriod();
    console.log(`[report-cron] Firing for period ${period}`);
    const outcome = await sendMonthlyReport({ trigger: "cron" });
    if (outcome.skipped === "already-sent") {
      console.log(`[report-cron] ${period} already sent — guard held, nothing sent.`);
    } else if (outcome.ok) {
      console.log(`[report-cron] ${period} sent to ${outcome.recipients.join(", ")}`);
    } else {
      console.error(`[report-cron] ${period} FAILED: ${outcome.error}`);
    }
  } catch (error) {
    console.error("[report-cron] Unhandled error:", error);
  } finally {
    isSendingReport = false;
  }
}

/**
 * Human-readable description of when a cron expression next fires.
 * Only handles the shapes we actually use; falls back to the raw expression.
 */
function describeSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== "*" && mon === "*" && dow === "*") {
    return `day ${dom} of every month at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  if (dom === "*" && mon === "*" && dow === "*") {
    return hour === "*" ? `every minute (${min})` : `daily at ${hour}:${min.padStart(2, "0")}`;
  }
  return expr;
}

export function startMonthlyReportCron(): void {
  const schedule = process.env.REPORT_CRON_SCHEDULE || DEFAULT_REPORT_SCHEDULE;
  const isOverridden = Boolean(process.env.REPORT_CRON_SCHEDULE);

  if (!cron.validate(schedule)) {
    console.error(
      `[report-cron] INVALID schedule "${schedule}" — monthly report NOT scheduled. ` +
      `Fix REPORT_CRON_SCHEDULE and redeploy.`,
    );
    return;
  }

  cron.schedule(schedule, () => { void runMonthlyReport(); }, { timezone: REPORT_TIMEZONE });

  console.log(
    `[report-cron] Monthly report scheduled: "${schedule}" (${describeSchedule(schedule)}) ` +
    `timezone=${REPORT_TIMEZONE}${isOverridden ? " [OVERRIDDEN via REPORT_CRON_SCHEDULE]" : " [default]"}`,
  );
  // Phrased carefully: previousPeriod() is evaluated NOW, so on Aug 25 it reads
  // "2026-07" even though the next real fire (Sep 1) will report on August.
  // Saying "next period" here would be actively misleading to someone checking
  // the boot log to confirm the setup — which is the whole reason it is logged.
  console.log(
    `[report-cron] The period is always the calendar month that just ended in ${REPORT_TIMEZONE}. ` +
    `A fire at this moment would report on ${previousPeriod()}; the next scheduled fire is ` +
    `${describeSchedule(schedule)}, which will report on the month ending immediately before it. ` +
    `Recipients are set in server/reports/send.ts`,
  );
}

/** Manual trigger for the endpoint and for local testing. */
export async function triggerMonthlyReport(): Promise<void> {
  await runMonthlyReport();
}
