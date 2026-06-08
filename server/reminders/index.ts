/**
 * Reminders Module Entry Point
 *
 * Exports all reminder functionality.
 */

export {
  initRemindersTable,
  createReminder,
  getReminderStats,
  getDueReminders,
  markReminderSent,
  markReminderFailed,
  getIntakeComments,
  createIntakeComment,
  getActiveAttentionFlags,
  clearAttentionFlag,
  getAllCrmProviders,
  getCrmProviderById,
  createCrmProvider,
  updateCrmProvider,
  deactivateCrmProvider,
  reactivateCrmProvider,
  getInactiveCrmProviders,
  getProviderOverride,
  getAllProviderOverrides,
  upsertProviderOverride,
  getProviderAvailability,
  getAllProviderAvailability,
  upsertProviderAvailability,
} from "./db";
export type {
  CrmProvider,
  CreateCrmProviderParams,
  ProviderOverride,
  UpsertOverrideParams,
  ProviderAvailability,
  UpsertProviderAvailabilityParams,
} from "./db";
export { startReminderCron, triggerReminderProcessing } from "./cron";
export { sendReminderEmail } from "./email";
export type { Reminder, CreateReminderParams, IntakeComment, AttentionFlag, CreateIntakeCommentParams } from "./types";
