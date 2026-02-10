/**
 * Reminder Types
 *
 * Defines the data model for email reminders.
 */

export interface Reminder {
  id: number;
  contactId: number;
  contactName: string;
  createdByEmail: string;
  reminderText: string;
  dueAt: string;
  status: "pending" | "sent" | "failed";
  retryCount: number;
  isSecondReminder: boolean;
  parentReminderId: number | null;
  createdAt: string;
  sentAt: string | null;
}

export interface CreateReminderParams {
  contactId: number;
  contactName: string;
  createdByEmail: string;
  reminderText: string;
  reminderDateTime: string;
  secondReminderDateTime?: string;
}

// ============================================================================
// Intake Comments & Attention Flags
// ============================================================================

export interface IntakeComment {
  id: number;
  contactId: number;
  contactName: string;
  authorEmail: string;
  authorInitials: string;
  commentText: string;
  createdAt: string;
}

export interface AttentionFlag {
  id: number;
  contactId: number;
  flaggedByEmail: string;
  flaggedAt: string;
  clearedByEmail: string | null;
  clearedAt: string | null;
}

export interface CreateIntakeCommentParams {
  contactId: number;
  contactName: string;
  authorEmail: string;
  authorInitials: string;
  commentText: string;
}
