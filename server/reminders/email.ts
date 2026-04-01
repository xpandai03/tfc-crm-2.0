/**
 * Reminder Email Service
 *
 * Sends reminder emails via Resend API.
 */

import { Resend } from "resend";
import type { Reminder } from "./types";

// Initialize Resend client (null if key not configured)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const APP_URL = process.env.APP_URL || "https://tfc-crm-2026.fly.dev";

// From email - must be verified domain in Resend, or use onboarding@resend.dev for testing
// Use EMAIL_FROM_ADDRESS (same as server/email/service.ts) with RESEND_FROM_EMAIL as fallback
const FROM_EMAIL = process.env.EMAIL_FROM_ADDRESS || process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
const FROM_NAME = "TFC CRM Reminders";

/**
 * Format date for display
 */
function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleString("en-US", {
    timeZone: "America/Denver",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

/**
 * Generate HTML email content
 */
function generateEmailHtml(reminder: Reminder): string {
  const typeLabel = reminder.isSecondReminder
    ? "1-Day Advance Notice"
    : "Reminder";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); padding: 24px; border-radius: 12px 12px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">
      ${typeLabel}: ${reminder.contactName}
    </h1>
  </div>

  <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
    <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb;">
      <p style="margin: 0 0 16px 0; font-size: 16px;">
        ${reminder.reminderText}
      </p>

      <div style="border-top: 1px solid #e5e7eb; padding-top: 16px; margin-top: 16px;">
        <p style="margin: 0; color: #6b7280; font-size: 14px;">
          <strong>Contact:</strong> ${reminder.contactName}
        </p>
        <p style="margin: 8px 0 0 0; color: #6b7280; font-size: 14px;">
          <strong>Scheduled for:</strong> ${formatDate(reminder.dueAt)}
        </p>
        <p style="margin: 8px 0 0 0;">
          <a href="${APP_URL}/contact/${reminder.contactId}" style="color: #4F46E5; text-decoration: none;">
            View Contact in TFC CRM
          </a>
        </p>
      </div>
    </div>
  </div>

  <div style="text-align: center; padding: 16px; color: #9ca3af; font-size: 12px;">
    <p style="margin: 0;">
      This reminder was created in TFC CRM on ${formatDate(reminder.createdAt)}
    </p>
  </div>
</body>
</html>
  `;
}

/**
 * Generate plain text email content
 */
function generateEmailText(reminder: Reminder): string {
  const typeLabel = reminder.isSecondReminder
    ? "1-Day Advance Notice"
    : "Reminder";

  return `
${typeLabel}: ${reminder.contactName}

${reminder.reminderText}

---
Contact: ${reminder.contactName}
Scheduled for: ${formatDate(reminder.dueAt)}
View Contact: ${APP_URL}/contact/${reminder.contactId}

This reminder was created in TFC CRM on ${formatDate(reminder.createdAt)}.
  `.trim();
}

/**
 * Send reminder email
 */
export async function sendReminderEmail(
  reminder: Reminder
): Promise<{ success: boolean; error?: string }> {
  const typeLabel = reminder.isSecondReminder ? "Advance Notice" : "Reminder";

  if (!resend) {
    console.warn(`[staging] Reminder email skipped (RESEND_API_KEY not configured) — would have sent ${typeLabel} to ${reminder.createdByEmail}`);
    return { success: true, error: undefined };
  }

  try {
    console.log(
      `[reminder-email] Sending ${typeLabel} email for reminder ${reminder.id} to ${reminder.createdByEmail}`
    );

    const result = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: reminder.createdByEmail,
      subject: `${typeLabel}: ${reminder.contactName}`,
      html: generateEmailHtml(reminder),
      text: generateEmailText(reminder),
    });

    if (result.error) {
      console.error(`[reminder-email] Resend API error:`, result.error);
      return { success: false, error: result.error.message };
    }

    console.log(
      `[reminder-email] Email sent successfully for reminder ${reminder.id}, Resend ID: ${result.data?.id}`
    );
    return { success: true };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `[reminder-email] Failed to send email for reminder ${reminder.id}:`,
      errorMessage
    );
    return { success: false, error: errorMessage };
  }
}
