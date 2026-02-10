/**
 * Reminders Module Entry Point
 *
 * Exports all reminder functionality.
 */

export {
  initDatabase,
  createReminder,
  getReminderStats,
  getDueReminders,
  markReminderSent,
  markReminderFailed,
  getIntakeComments,
  createIntakeComment,
  getActiveAttentionFlags,
  clearAttentionFlag,
} from "./db";
export { startReminderCron, triggerReminderProcessing } from "./cron";
export { sendReminderEmail } from "./email";
export type { Reminder, CreateReminderParams, IntakeComment, AttentionFlag, CreateIntakeCommentParams } from "./types";
