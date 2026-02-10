/**
 * Reminder Cron Job
 *
 * Checks for due reminders every minute and sends emails.
 */

import cron from "node-cron";
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
    const dueReminders = getDueReminders();

    if (dueReminders.length === 0) {
      // Log heartbeat every 15 minutes (when minute is 0, 15, 30, or 45) so we can verify cron is alive
      const minute = new Date().getMinutes();
      if (minute % 15 === 0) {
        const stats = getReminderStats();
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
          markReminderSent(reminder.id);
        } else {
          markReminderFailed(reminder.id);
          console.warn(
            `[reminder-cron] Failed to send reminder ${reminder.id}: ${result.error}`
          );
        }
      } catch (error) {
        markReminderFailed(reminder.id);
        console.error(
          `[reminder-cron] Error processing reminder ${reminder.id}:`,
          error
        );
      }
    }

    // Log stats after processing
    const stats = getReminderStats();
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
