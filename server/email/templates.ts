/**
 * Email Templates
 *
 * Static, pre-approved email templates for admin-triggered sends.
 * Templates are code-defined (not editable by admins) for security and auditability.
 *
 * Variables use {{variableName}} pattern and are substituted server-side.
 */

export interface RequiredField {
  key: string;          // Variable name in template (e.g., "therapistName")
  label: string;        // Display label for admin input (e.g., "Provider Name")
  type: "text" | "datetime" | "provider-select" | "location-select";
  defaultText: string;  // Placeholder text shown in preview when unfilled (e.g., "[Provider Name]")
}

export interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  variables: string[]; // List of variable names used in this template
  requiredFields: RequiredField[]; // Admin-filled fields (empty = fully auto-populated)
}

export interface TemplateMetadata {
  id: string;
  name: string;
  description: string;
  requiredFields: RequiredField[];
}

/**
 * Extract first name from full name
 */
export function extractFirstName(fullName: string | null | undefined): string {
  if (!fullName || typeof fullName !== "string") return "";
  const trimmed = fullName.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/\s+/);
  return parts[0] || "";
}

/**
 * Email Templates Registry
 *
 * v1 Templates:
 * - waitlist-status: General waitlist status update
 * - scheduling-followup: Follow-up for scheduling appointments
 *
 * Brand Guidelines:
 * - Logo: Hosted at production URL for email client compatibility
 * - Colors: Navy blue (#1e3a5f) accent, clean white/gray backgrounds
 * - Typography: System font stack for cross-client compatibility
 * - Layout: Table-based for email client safety
 */

const APP_URL = process.env.APP_URL || "https://tfc-crm-2-0.fly.dev";
const LOGO_URL = `${APP_URL}/tfc-logo.jpg`;
const SURVEY_URL = process.env.SURVEY_URL || "https://customer-feedback-tfc.replit.app";

// Shared email wrapper for consistent branding
function wrapEmailContent(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The Family Connection</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <!-- Outer wrapper - clean white background -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #ffffff;">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <!-- Main email container - white, no shadow for cleaner look -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff;">
          
          <!-- Header with logo - clean, no border -->
          <tr>
            <td style="padding: 24px 32px 16px 32px; background-color: #ffffff;">
              <img src="${LOGO_URL}" alt="The Family Connection" width="180" style="display: block; max-width: 180px; height: auto;" />
            </td>
          </tr>
          
          <!-- Email body content -->
          <tr>
            <td style="padding: 32px; color: #374151; font-size: 15px; line-height: 1.7;">
              ${content}
            </td>
          </tr>
          
          <!-- Footer - clean white with subtle separator -->
          <tr>
            <td style="padding: 24px 32px; background-color: #ffffff; border-top: 1px solid #e5e7eb;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="color: #6b7280; font-size: 13px; line-height: 1.5;">
                    <p style="margin: 0 0 4px 0; font-weight: 600; color: #374151;">The Family Connection</p>
                    <p style="margin: 0; color: #9ca3af;">Albuquerque, New Mexico</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
        </table>
        
        <!-- Below-footer note -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px;">
          <tr>
            <td style="padding: 16px 32px; text-align: center; color: #9ca3af; font-size: 12px;">
              <p style="margin: 0;">This email was sent by The Family Connection CRM.</p>
            </td>
          </tr>
        </table>
        
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: "waitlist-status",
    name: "Waitlist Status",
    description: "General update about waitlist status and next steps",
    subject: "Update on Your Waitlist Status - The Family Connection",
    bodyHtml: wrapEmailContent(`
      <p style="margin: 0 0 20px 0;">
        Hi {{firstName}},
      </p>

      <p style="margin: 0 0 20px 0;">
        Thank you for your patience while on our waitlist. We wanted to reach out with an update on your status.
      </p>

      <p style="margin: 0 0 20px 0;">
        We are actively working to match you with a provider who fits your needs. Your preferred service type is <strong style="color: #1e3a5f;">{{serviceRequested}}</strong> and your preferred modality is <strong style="color: #1e3a5f;">{{modality}}</strong>.
      </p>

      <p style="margin: 0 0 20px 0;">
        If any of your preferences have changed, or if you have questions about your waitlist status, please don't hesitate to reach out to us.
      </p>

      <p style="margin: 0;">
        Warm regards,<br>
        <strong>The Family Connection Team</strong>
      </p>
    `),
    bodyText: `
Hi {{firstName}},

Thank you for your patience while on our waitlist. We wanted to reach out with an update on your status.

We are actively working to match you with a provider who fits your needs. Your preferred service type is {{serviceRequested}} and your preferred modality is {{modality}}.

If any of your preferences have changed, or if you have questions about your waitlist status, please don't hesitate to reach out to us.

Warm regards,
The Family Connection Team

---
The Family Connection
Albuquerque, New Mexico
    `.trim(),
    variables: ["firstName", "serviceRequested", "modality"],
    requiredFields: [],
  },
  {
    id: "scheduling-followup",
    name: "Scheduling Follow-up",
    description: "Follow-up to schedule an appointment with a matched provider",
    subject: "Ready to Schedule Your Appointment - The Family Connection",
    bodyHtml: wrapEmailContent(`
      <p style="margin: 0 0 20px 0;">
        Hi {{firstName}},
      </p>

      <p style="margin: 0 0 20px 0;">
        Great news! We've identified a provider who may be a good fit for you, and we're ready to help you schedule your first appointment.
      </p>

      <p style="margin: 0 0 20px 0;">
        Your appointment will be for <strong style="color: #1e3a5f;">{{serviceRequested}}</strong> services via <strong style="color: #1e3a5f;">{{modality}}</strong>.
      </p>

      <p style="margin: 0 0 20px 0;">
        Please give us a call or reply to this email at your earliest convenience so we can find a time that works for you.
      </p>

      <p style="margin: 0 0 20px 0;">
        We look forward to connecting you with care!
      </p>

      <p style="margin: 0;">
        Warm regards,<br>
        <strong>The Family Connection Team</strong>
      </p>
    `),
    bodyText: `
Hi {{firstName}},

Great news! We've identified a provider who may be a good fit for you, and we're ready to help you schedule your first appointment.

Your appointment will be for {{serviceRequested}} services via {{modality}}.

Please give us a call or reply to this email at your earliest convenience so we can find a time that works for you.

We look forward to connecting you with care!

Warm regards,
The Family Connection Team

---
The Family Connection
Albuquerque, New Mexico
    `.trim(),
    variables: ["firstName", "serviceRequested", "modality"],
    requiredFields: [],
  },
  {
    id: "portal-enrollment",
    name: "Therapy Notes Portal (New Patients)",
    description: "Portal enrollment instructions for new patients",
    subject: "Therapy Notes Portal -- The Family Connection",
    bodyHtml: wrapEmailContent(`
      <p style="margin: 0 0 20px 0;">
        Hello {{firstName}},
      </p>

      <p style="margin: 0 0 20px 0;">
        Thank you for choosing our services. To prepare for your upcoming appointment, please complete the portal enrollment process using the steps below:
      </p>

      <ol style="margin: 0 0 20px 0; padding-left: 20px; color: #374151; line-height: 1.8;">
        <li>You should have received an email inviting you to enroll in our client portal.</li>
        <li>Click the link in that email to create your password.</li>
        <li>Once your password is set, you will automatically log into the portal.</li>
        <li>Your required intake documents will appear on your dashboard.</li>
      </ol>

      <p style="margin: 0 0 20px 0;">
        Please complete the documents prior to your initial appointment. If you did not receive the enrollment email or need assistance, feel free to reach out via phone <strong>505-717-1155</strong> or email <a href="mailto:admindept@nmfamilyconnection.com" style="color: #1e3a5f;">admindept@nmfamilyconnection.com</a> and we'll be happy to help.
      </p>

      <p style="margin: 0;">
        Warm regards,<br>
        <strong>The Family Connection Team</strong>
      </p>
    `),
    bodyText: `
Hello {{firstName}},

Thank you for choosing our services. To prepare for your upcoming appointment, please complete the portal enrollment process using the steps below:

1. You should have received an email inviting you to enroll in our client portal.
2. Click the link in that email to create your password.
3. Once your password is set, you will automatically log into the portal.
4. Your required intake documents will appear on your dashboard.

Please complete the documents prior to your initial appointment. If you did not receive the enrollment email or need assistance, feel free to reach out via phone 505-717-1155 or email admindept@nmfamilyconnection.com and we'll be happy to help.

Warm regards,
The Family Connection Team

---
The Family Connection
Albuquerque, New Mexico
    `.trim(),
    variables: ["firstName"],
    requiredFields: [],
  },
  {
    id: "appointment-confirmation",
    name: "Initial Appointment Confirmation",
    description: "Confirm initial appointment details with the client",
    subject: "Initial Appointment Confirmation -- The Family Connection",
    bodyHtml: wrapEmailContent(`
      <p style="margin: 0 0 20px 0;">
        Hello {{firstName}},
      </p>

      <p style="margin: 0 0 20px 0;">
        Thank you again for reaching out to The Family Connection and allowing us to serve you.
      </p>

      <p style="margin: 0 0 20px 0;">
        To confirm, you are scheduled with <strong style="color: #1e3a5f;">{{therapistName}}</strong> on <strong style="color: #1e3a5f;">{{appointmentDatetime}}</strong>.
      </p>

      {{locationBlock}}

      <p style="margin: 0 0 20px 0;">
        If you have a copayment or coinsurance, the amount is due 2 hours prior to your scheduled appointment. If your credit card is not on file, please reach out to our Administrative Department with a payment method 2 hours prior to your appointment.
      </p>

      <p style="margin: 0 0 20px 0;">
        If you need to cancel your appointment, we ask that you call our office at <strong>505-717-1155</strong>. Please be advised The Family Connection has a 24-hour cancellation policy.
      </p>

      <p style="margin: 0 0 20px 0;">
        Thank you again for allowing us to serve you.
      </p>

      <p style="margin: 0;">
        Warm regards,<br>
        <strong>The Family Connection Team</strong>
      </p>
    `),
    bodyText: `
Hello {{firstName}},

Thank you again for reaching out to The Family Connection and allowing us to serve you.

To confirm, you are scheduled with {{therapistName}} on {{appointmentDatetime}}.

{{locationBlockText}}

If you have a copayment or coinsurance, the amount is due 2 hours prior to your scheduled appointment. If your credit card is not on file, please reach out to our Administrative Department with a payment method 2 hours prior to your appointment.

If you need to cancel your appointment, we ask that you call our office at 505-717-1155. Please be advised The Family Connection has a 24-hour cancellation policy.

Thank you again for allowing us to serve you.

Warm regards,
The Family Connection Team

---
The Family Connection
Albuquerque, New Mexico
    `.trim(),
    variables: ["firstName", "therapistName", "appointmentDatetime", "locationBlock", "locationBlockText"],
    requiredFields: [
      { key: "therapistName", label: "Provider Name", type: "provider-select", defaultText: "[Provider Name]" },
      { key: "appointmentDatetime", label: "Appointment Date & Time", type: "datetime", defaultText: "[Appointment Date & Time]" },
      { key: "locationId", label: "Appointment Location", type: "location-select", defaultText: "[Location]" },
    ],
  },
  {
    id: "post-appointment-survey",
    name: "Initial Appointment Survey",
    description: "Post-appointment feedback survey request",
    subject: "Initial Appointment Survey -- The Family Connection",
    bodyHtml: wrapEmailContent(`
      <p style="margin: 0 0 20px 0;">
        Hello {{firstName}},
      </p>

      <p style="margin: 0 0 20px 0;">
        Your feedback matters to us!
      </p>

      <p style="margin: 0 0 20px 0;">
        Please take a moment to tell us about your experience by completing our brief survey. It should take about 1&ndash;2 minutes.
      </p>

      <!-- Outlook-safe button: table wrapper + anchor with inline styles -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 20px 0;">
        <tr>
          <td align="center" bgcolor="#1e3a5f" style="border-radius: 6px;">
            <a href="${SURVEY_URL}" target="_blank"
               style="display: inline-block; padding: 12px 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 15px; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
              Take the Survey
            </a>
          </td>
        </tr>
      </table>

      <p style="margin: 0 0 20px 0;">
        Thank you so much for your time.
      </p>

      <p style="margin: 0;">
        Warm regards,<br>
        <strong>The Family Connection Team</strong>
      </p>
    `),
    bodyText: `
Hello {{firstName}},

Your feedback matters to us!

Please take a moment to tell us about your experience by completing our brief survey. It should take about 1-2 minutes.

Take the Survey: ${SURVEY_URL}

Thank you so much for your time.

Warm regards,
The Family Connection Team

---
The Family Connection
Albuquerque, New Mexico
    `.trim(),
    variables: ["firstName"],
    requiredFields: [],
  },
  {
    id: "intake-form-reminder",
    name: "Intake Form Reminder",
    description: "Reminder to complete intake forms before appointment",
    subject: "Intake Form Reminder -- The Family Connection",
    bodyHtml: wrapEmailContent(`
      <p style="margin: 0 0 20px 0;">
        Hello {{firstName}},
      </p>

      <p style="margin: 0 0 20px 0;">
        This is a friendly reminder to please complete your intake forms prior to your upcoming appointment.
      </p>

      <p style="margin: 0 0 20px 0;">
        If you have already completed the forms, thank you &mdash; no further action is needed.
      </p>

      <p style="margin: 0 0 20px 0;">
        If you need assistance or did not receive the intake email, please contact us at <strong>505-717-1155</strong> or <a href="mailto:admindept@nmfamilyconnection.com" style="color: #1e3a5f;">admindept@nmfamilyconnection.com</a>.
      </p>

      <p style="margin: 0;">
        Warm regards,<br>
        <strong>The Family Connection Team</strong>
      </p>
    `),
    bodyText: `
Hello {{firstName}},

This is a friendly reminder to please complete your intake forms prior to your upcoming appointment.

If you have already completed the forms, thank you -- no further action is needed.

If you need assistance or did not receive the intake email, please contact us at 505-717-1155 or admindept@nmfamilyconnection.com.

Warm regards,
The Family Connection Team

---
The Family Connection
Albuquerque, New Mexico
    `.trim(),
    variables: ["firstName"],
    requiredFields: [],
  },
];

/**
 * Get template by ID
 */
export function getTemplateById(id: string): EmailTemplate | undefined {
  return EMAIL_TEMPLATES.find((t) => t.id === id);
}

/**
 * Get template metadata list for frontend dropdown
 */
export function getTemplateMetadataList(): TemplateMetadata[] {
  return EMAIL_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    requiredFields: t.requiredFields,
  }));
}
