/**
 * Email Templates
 *
 * Static, pre-approved email templates for admin-triggered sends.
 * Templates are code-defined (not editable by admins) for security and auditability.
 *
 * Variables use {{variableName}} pattern and are substituted server-side.
 *
 * STORAGE (Build 1): The 6 templates below remain the in-code source of truth
 * AND the fallback. At startup `initEmailTemplatesTable()` creates an
 * `email_templates` table and idempotently seeds it from this constant. The
 * read path (`getTemplateById` / `getTemplateMetadataList`) reads from the
 * table, falling back to this constant if the table is empty or the query
 * fails — so a migration hiccup can never break live sends. Content stored in
 * the table is byte-identical to what this constant holds at runtime
 * (`bodyHtml` here is ALREADY wrapped by `wrapEmailContent()`, so the table
 * stores the pre-wrapped HTML; rendering does not re-wrap).
 */

import { getPool } from "../db/pool";

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
  contentFormat: "html" | "text"; // how bodyContent is authored:
  //   "html" → system templates, authored with <p> markup; rendered as-is
  //   "text" → editor templates, plain text with line breaks; converted to HTML
  //            (escaped + \n\n→paragraph, \n→<br>) at render so typed spacing shows
  bodyContent: string; // inner editable body (no branding shell); EDIT this
  bodyHtml: string;    // derived = wrapEmailContent(renderBodyContentToHtml(bodyContent, contentFormat))
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
export function wrapEmailContent(content: string): string {
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

// ============================================================================
// Body-content rendering: honor editor-typed line breaks for "text" templates
// ============================================================================

/** Escape the 4 HTML-significant chars in user-authored plain text so literal
 *  characters (e.g. "<", "&") render as themselves. {{tokens}} are unaffected
 *  (letters/braces aren't escaped), so variable substitution still works. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convert plain text with line breaks into HTML, preserving the author's
 *  spatial formatting: blank line (\n\n) → paragraph break, single \n → <br>.
 *  Paragraph styling matches the system templates' <p> spacing for visual
 *  consistency. User text is escaped first; {{tokens}} survive escaping and are
 *  substituted later (so variable-injected HTML like {{locationBlock}} / links
 *  still render as HTML, never escaped). */
function textToHtml(text: string): string {
  const normalized = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = normalized
    .split(/\n[ \t]*\n/) // blank line separates paragraphs
    .map((p) => p.replace(/^\n+|\n+$/g, "")) // trim leading/trailing newlines per block
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return "";
  return paragraphs
    .map((p) => `<p style="margin: 0 0 20px 0;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** Render inner body content to HTML for the wrapper. "html" content (system
 *  templates) is already markup → identity. "text" content (editor templates)
 *  is converted so typed line breaks are honored. */
export function renderBodyContentToHtml(content: string, format: "html" | "text"): string {
  return format === "text" ? textToHtml(content) : content;
}

/** Derive the plain-text twin from body content. For "text" templates the
 *  content IS the clean plain text (newlines preserved) — used verbatim. For
 *  "html" templates, strip tags to a readable plain-text approximation. */
export function deriveBodyText(content: string, format: "html" | "text"): string {
  if (format === "text") return content;
  return content
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Source definitions hold the INNER body content; the branded bodyHtml is
// derived once below via wrapEmailContent(). This is byte-identical to the
// previous `bodyHtml: wrapEmailContent(...)` form (verified by the equivalence
// test) and gives every template an editable inner-content field.
const RAW_TEMPLATES: Omit<EmailTemplate, "bodyHtml" | "contentFormat">[] = [
  {
    id: "waitlist-status",
    name: "Waitlist Status",
    description: "General update about waitlist status and next steps",
    subject: "Update on Your Waitlist Status - The Family Connection",
    bodyContent: `
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
    `,
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
    bodyContent: `
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
    `,
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
    bodyContent: `
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
    `,
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
    bodyContent: `
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
    `,
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
    bodyContent: `
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
    `,
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
    bodyContent: `
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
    `,
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

// All 6 system templates are HTML-authored (their bodyContent has <p> markup).
// renderBodyContentToHtml(content, "html") is the identity, so bodyHtml stays
// byte-identical to the prior wrapEmailContent(bodyContent) form (verified by
// the equivalence test).
export const EMAIL_TEMPLATES: EmailTemplate[] = RAW_TEMPLATES.map((t) => ({
  ...t,
  contentFormat: "html" as const,
  bodyHtml: wrapEmailContent(renderBodyContentToHtml(t.bodyContent, "html")),
}));

// ============================================================================
// DB-backed storage (Build 1): email_templates table
// ============================================================================
//
// The constant above stays as both the seed source and the runtime fallback.
// Reads go to the table; on empty/error they fall back to the constant so live
// sends never break. No write path / editor in this build.

/** pg returns jsonb pre-parsed; tolerate string too (defensive). */
function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Map an email_templates row to the EmailTemplate shape used by render/send. */
function rowToTemplate(r: any): EmailTemplate {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    subject: r.subject,
    contentFormat: r.content_format === "html" ? "html" : "text",
    bodyContent: r.body_content ?? "",
    bodyHtml: r.body_html,
    bodyText: r.body_text,
    variables: asArray<string>(r.variables),
    requiredFields: asArray<RequiredField>(r.required_fields),
  };
}

/**
 * Create the email_templates table and idempotently seed it from EMAIL_TEMPLATES.
 * Additive; follows the existing init*Table() startup pattern. Safe to run on
 * every boot — ON CONFLICT DO NOTHING never duplicates or clobbers existing rows
 * (so future editor writes survive re-seeding).
 */
export async function initEmailTemplatesTable(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      subject         TEXT NOT NULL,
      content_format  TEXT NOT NULL DEFAULT 'text',
      body_content    TEXT NOT NULL DEFAULT '',
      body_html       TEXT NOT NULL,
      body_text       TEXT NOT NULL,
      variables       JSONB NOT NULL DEFAULT '[]',
      required_fields JSONB NOT NULL DEFAULT '[]',
      sort_order      INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Additive migrations: existing tables (Build 1/2/3) lack these columns.
  const additiveColumns: Array<[string, string]> = [
    ["body_content", `ALTER TABLE email_templates ADD COLUMN body_content TEXT NOT NULL DEFAULT ''`],
    ["content_format", `ALTER TABLE email_templates ADD COLUMN content_format TEXT NOT NULL DEFAULT 'text'`],
  ];
  for (const [name, sql] of additiveColumns) {
    try {
      await pool.query(sql);
      console.log(`[email-templates-db] Added ${name} column`);
    } catch {
      // Column already exists — expected on subsequent startups
    }
  }

  // Idempotent seed from the constant. sort_order = array index, so the
  // dropdown order is preserved exactly (ORDER BY sort_order on read).
  let seeded = 0;
  for (let i = 0; i < EMAIL_TEMPLATES.length; i++) {
    const t = EMAIL_TEMPLATES[i];
    const result = await pool.query(
      `INSERT INTO email_templates
         (id, name, description, subject, content_format, body_content, body_html, body_text, variables, required_fields, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        t.id,
        t.name,
        t.description,
        t.subject,
        t.contentFormat,
        t.bodyContent,
        t.bodyHtml,
        t.bodyText,
        JSON.stringify(t.variables),
        JSON.stringify(t.requiredFields),
        i,
      ],
    );
    seeded += result.rowCount ?? 0;
  }

  // Backfill the 6 system rows that predate these columns. body_content from the
  // constant (their body_html is the pre-wrapped form); content_format='html'
  // (they are HTML-authored). Idempotent — only fills empties; NEVER touches
  // body_html (render stays byte-identical) or editor-authored rows.
  let backfilled = 0;
  for (const t of EMAIL_TEMPLATES) {
    const r = await pool.query(
      `UPDATE email_templates SET body_content = $2, content_format = 'html'
        WHERE id = $1 AND (body_content IS NULL OR body_content = '')`,
      [t.id, t.bodyContent],
    );
    backfilled += r.rowCount ?? 0;
  }

  console.log(
    `[email-templates-db] Table initialized (${seeded} of ${EMAIL_TEMPLATES.length} newly seeded; ${backfilled} system rows backfilled (content_format=html); body_html untouched)`,
  );
}

/**
 * Get template by ID — reads from the table, falls back to the constant on
 * empty/error so live preview/send never break.
 */
export async function getTemplateById(id: string): Promise<EmailTemplate | undefined> {
  try {
    const pool = getPool();
    const result = await pool.query(`SELECT * FROM email_templates WHERE id = $1`, [id]);
    if (result.rows.length > 0) {
      return rowToTemplate(result.rows[0]);
    }
    console.warn(`[email-templates] id "${id}" not in table — falling back to constant`);
  } catch (err) {
    console.error(`[email-templates] getTemplateById("${id}") query failed — falling back to constant:`, err);
  }
  return EMAIL_TEMPLATES.find((t) => t.id === id);
}

/**
 * Get template metadata list for frontend dropdown — reads from the table
 * (ordered by sort_order to preserve the existing dropdown order), falls back
 * to the constant on empty/error.
 */
export async function getTemplateMetadataList(): Promise<TemplateMetadata[]> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, name, description, required_fields
         FROM email_templates
        ORDER BY sort_order ASC, id ASC`,
    );
    if (result.rows.length > 0) {
      return result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description ?? "",
        requiredFields: asArray<RequiredField>(r.required_fields),
      }));
    }
    console.warn("[email-templates] table empty — falling back to EMAIL_TEMPLATES constant");
  } catch (err) {
    console.error("[email-templates] getTemplateMetadataList query failed — falling back to constant:", err);
  }
  return EMAIL_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    requiredFields: t.requiredFields,
  }));
}

// ============================================================================
// Editor support (Build 2): system-template guard, variable validation, CRUD
// ============================================================================

/**
 * The 6 seeded ids are "system" templates with id-coupled behavior (the CC
 * QUALIFYING_TEMPLATES list in service.ts keys off these ids). They may be
 * edited (name/subject/body) but MUST NOT be deleted or have their ids changed.
 */
export const SYSTEM_TEMPLATE_IDS: ReadonlySet<string> = new Set(EMAIL_TEMPLATES.map((t) => t.id));
export function isSystemTemplate(id: string): boolean {
  return SYSTEM_TEMPLATE_IDS.has(id);
}

/**
 * Known/allowed {{variables}} an editor may use. MUST stay in sync with the
 * keys built in service.ts:buildVariableMap() — any token not in this set would
 * silently fail to substitute at send time, so saves are validated against it.
 * (requiredField-driven keys therapistName/appointmentDatetime/locationBlock*
 * are already included; structural requiredFields are read-only in v1.)
 */
export const KNOWN_TEMPLATE_VARIABLES: readonly string[] = [
  "firstName",
  "name",
  "modality",
  "city",
  "serviceRequested",
  "therapistName",
  "appointmentDatetime",
  "appointmentLocationOrModality",
  "surveyLink",
  "locationBlock",
  "locationBlockText",
];

const VARIABLE_TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Unique list of {{token}} names referenced across the given text blobs. */
export function extractVariables(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of Array.from(text.matchAll(VARIABLE_TOKEN_PATTERN))) {
      found.add(m[1]);
    }
  }
  return Array.from(found);
}

/** Tokens used by the content that are NOT in the known/allowed set. */
export function findUnknownVariables(...texts: Array<string | null | undefined>): string[] {
  const known = new Set(KNOWN_TEMPLATE_VARIABLES);
  return extractVariables(...texts).filter((v) => !known.has(v));
}

/** All templates with full fields (for the editor list/edit forms), table-sourced
 *  with constant fallback. */
export async function getAllTemplatesFull(): Promise<EmailTemplate[]> {
  try {
    const pool = getPool();
    const result = await pool.query(`SELECT * FROM email_templates ORDER BY sort_order ASC, id ASC`);
    if (result.rows.length > 0) {
      return result.rows.map(rowToTemplate);
    }
    console.warn("[email-templates] table empty — getAllTemplatesFull falling back to constant");
  } catch (err) {
    console.error("[email-templates] getAllTemplatesFull query failed — falling back to constant:", err);
  }
  return EMAIL_TEMPLATES;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "template"
  );
}

async function idExists(id: string): Promise<boolean> {
  if (isSystemTemplate(id)) return true; // never reuse a system id
  const pool = getPool();
  const r = await pool.query(`SELECT 1 FROM email_templates WHERE id = $1`, [id]);
  return r.rows.length > 0;
}

/** Generate a unique, non-colliding id for a new template. The "custom-" prefix
 *  guarantees it can never equal one of the 6 system ids. */
async function generateUniqueId(name: string): Promise<string> {
  const base = `custom-${slugify(name)}`;
  let id = base;
  let n = 1;
  while (await idExists(id)) {
    n++;
    id = `${base}-${n}`;
  }
  return id;
}

export interface CreateTemplateInput {
  name: string;
  description: string;
  subject: string;
  bodyContent: string; // inner body (plain text w/ line breaks); branded body_html
  //                      and plain-text twin are derived on save — no hand-entry.
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  subject?: string;
  bodyContent?: string;
}

/** Create an editor-authored template. id is generated (never collides with the
 *  6 system ids); requiredFields default to [] (no structural editor in v1).
 *  Editor templates are content_format="text": body_html = wrapEmailContent of
 *  the newline-converted content (typed line breaks honored, never empty), and
 *  body_text is auto-derived (= the plain-text content). Variables from content. */
export async function createTemplate(input: CreateTemplateInput): Promise<EmailTemplate> {
  const pool = getPool();
  const id = await generateUniqueId(input.name);
  const format: "html" | "text" = "text";
  const bodyHtml = wrapEmailContent(renderBodyContentToHtml(input.bodyContent, format));
  const bodyText = deriveBodyText(input.bodyContent, format);
  const variables = extractVariables(input.subject, input.bodyContent);
  const orderRes = await pool.query(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM email_templates`);
  const sortOrder = orderRes.rows[0].next;

  await pool.query(
    `INSERT INTO email_templates
       (id, name, description, subject, content_format, body_content, body_html, body_text, variables, required_fields, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '[]'::jsonb, $10)`,
    [
      id,
      input.name,
      input.description,
      input.subject,
      format,
      input.bodyContent,
      bodyHtml,
      bodyText,
      JSON.stringify(variables),
      sortOrder,
    ],
  );

  const created = await getTemplateById(id);
  if (!created) throw new Error(`createTemplate: row not found after insert (${id})`);
  return created;
}

/** Update an existing template's editable fields (name/description/subject/body).
 *  Never changes id, required_fields, or content_format. body_html is re-derived
 *  from the merged bodyContent honoring the row's content_format (text → newline
 *  conversion; html → as-is, so system templates aren't distorted). body_text is
 *  re-derived for text templates; preserved as-authored for html (system) ones.
 *  Returns null if the id doesn't exist. */
export async function updateTemplate(id: string, patch: UpdateTemplateInput): Promise<EmailTemplate | null> {
  const existing = await getTemplateById(id);
  if (!existing) return null;

  const merged = {
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    subject: patch.subject ?? existing.subject,
    bodyContent: patch.bodyContent ?? existing.bodyContent,
  };
  const format = existing.contentFormat;
  const bodyHtml = wrapEmailContent(renderBodyContentToHtml(merged.bodyContent, format));
  // text → content IS the plain text; html (system) → keep the authored body_text
  // (its {{locationBlockText}} etc. must not be lost to tag-stripping).
  const bodyText = format === "text" ? deriveBodyText(merged.bodyContent, format) : existing.bodyText;
  const variables = extractVariables(merged.subject, merged.bodyContent);

  const pool = getPool();
  await pool.query(
    `UPDATE email_templates
        SET name = $2, description = $3, subject = $4, body_content = $5, body_html = $6,
            body_text = $7, variables = $8::jsonb, updated_at = NOW()
      WHERE id = $1`,
    [id, merged.name, merged.description, merged.subject, merged.bodyContent, bodyHtml, bodyText, JSON.stringify(variables)],
  );

  return (await getTemplateById(id)) ?? null;
}

/** Delete a template. Caller MUST block system ids first (isSystemTemplate). */
export async function deleteTemplate(id: string): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(`DELETE FROM email_templates WHERE id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}
