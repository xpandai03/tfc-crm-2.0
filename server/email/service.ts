/**
 * Email Service
 *
 * Handles template rendering, ECC checks, and email sending via Resend.
 * All sends are admin-triggered (no automatic emails).
 */

import { Resend } from "resend";
import {
  EMAIL_TEMPLATES,
  getTemplateById,
  getTemplateMetadataList,
  extractFirstName,
  wrapEmailContent,
  renderBodyContentToHtml,
  type EmailTemplate,
  type TemplateMetadata,
} from "./templates";
import { getProviderEmail, getLocationById } from "./provider-location-config";

// Initialize Resend client (null if key not configured — staging safety)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// From email configuration
// Uses verified domain hipaacheck.ai for production sends
const FROM_EMAIL = process.env.EMAIL_FROM_ADDRESS || process.env.RESEND_FROM_EMAIL || "no-reply@hipaacheck.ai";
const FROM_NAME = "The Family Connection";

// Reply-To configuration (v1: hardcoded, not admin-editable)
// All client replies go to the human-monitored admin inbox
const REPLY_TO_EMAIL = "admindept@nmfamilyconnection.com";

/**
 * Contact data structure for template rendering
 */
export interface ContactForEmail {
  contactId: number;
  name: string;
  email: string | null | undefined;
  modality?: string | null;
  city?: string | null;
  serviceRequested?: string;
  requestingFor?: string | null;
  eccConsent?: boolean | null;
}

/**
 * Rendered email result
 */
export interface RenderedEmail {
  templateId: string;
  templateName: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  recipientEmail: string;
  recipientName: string;
}

/**
 * Send result
 */
export interface SendResult {
  success: boolean;
  error?: string;
  emailId?: string;
  renderedHtml?: string;
  renderedSubject?: string;
  senderEmail?: string;
  recipientEmail?: string;
  ccEmails?: string[];
}

/**
 * Map intake requestingFor field to human-readable therapy type for emails.
 * Keeps email language safe and semantically correct.
 */
function mapServiceType(requestingFor: string | null | undefined): string {
  if (!requestingFor) return "therapy";
  const normalized = requestingFor.trim().toLowerCase();
  if (normalized === "myself") return "therapy";
  if (normalized === "my child") return "child therapy";
  if (normalized === "my partner & myself" || normalized === "my partner and myself") return "couples therapy";
  if (normalized === "my family") return "family therapy";
  return "therapy";
}

/**
 * Build variable map from contact data and optional admin-provided dynamic fields
 */
function buildVariableMap(
  contact: ContactForEmail,
  dynamicFields?: Record<string, string>
): Record<string, string> {
  const map: Record<string, string> = {
    firstName: extractFirstName(contact.name) || "there",
    name: contact.name || "",
    modality: contact.modality || "your preferred modality",
    city: contact.city || "your area",
    serviceRequested: mapServiceType(contact.requestingFor) || contact.serviceRequested || "therapy",
    therapistName: "[Provider Name]",
    appointmentDatetime: "[Appointment Date & Time]",
    appointmentLocationOrModality: contact.modality || "[Location/Modality]",
    surveyLink: "[Survey Link]",
    locationBlock: "",
    locationBlockText: "",
  };

  // Override defaults with admin-provided values (skip non-template keys)
  if (dynamicFields) {
    for (const [key, value] of Object.entries(dynamicFields)) {
      if (key === "locationId" || key === "ccEmail") continue;
      if (key in map && value && value.trim()) {
        map[key] = value.trim();
      }
    }
  }

  // Resolve locationId into locationBlock HTML and plain-text equivalents
  if (dynamicFields?.locationId) {
    const location = getLocationById(dynamicFields.locationId);
    if (location) {
      if (location.telehealth) {
        map.locationBlock =
          `<p style="margin: 0 0 20px 0;">For telehealth sessions, you will receive an email from your provider with a link to join the video session.</p>`;
        map.locationBlockText =
          "For telehealth sessions, you will receive an email from your provider with a link to join the video session.";
      } else {
        const addressHtml = (location.address || "").replace(/\n/g, "<br>");
        map.locationBlock =
          `<p style="margin: 0 0 20px 0;"><strong style="color: #1e3a5f;">Location: ${location.label} Office</strong><br>${addressHtml}</p>`;
        map.locationBlockText =
          `Location: ${location.label} Office\n${location.address || ""}`;
      }
    }
  }

  return map;
}

/**
 * Substitute variables in a string
 * Variables use {{variableName}} pattern
 */
function substituteVariables(
  text: string,
  variables: Record<string, string>
): string {
  let result = text;
  for (const [key, value] of Object.entries(variables)) {
    // Replace all occurrences of {{key}} with value
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    result = result.replace(pattern, value);
  }
  return result;
}

/**
 * Render a template with contact data and optional admin-provided dynamic fields
 */
export async function renderTemplate(
  templateId: string,
  contact: ContactForEmail,
  dynamicFields?: Record<string, string>
): Promise<RenderedEmail | null> {
  const template = await getTemplateById(templateId);
  if (!template) {
    console.error(`[email-service] Template not found: ${templateId}`);
    return null;
  }

  const variables = buildVariableMap(contact, dynamicFields);

  return {
    templateId: template.id,
    templateName: template.name,
    subject: substituteVariables(template.subject, variables),
    bodyHtml: substituteVariables(template.bodyHtml, variables),
    bodyText: substituteVariables(template.bodyText, variables),
    recipientEmail: contact.email || "",
    recipientName: contact.name,
  };
}

/**
 * Render an UNSAVED draft (editor live preview). Reuses the EXACT same render
 * mechanism as a real send: renderBodyContentToHtml() honors the content format
 * (text → newline-converted; html → as-is), wrapEmailContent() applies the
 * branding shell, then substituteVariables() substitutes a sample variable map.
 * Mirrors what createTemplate/updateTemplate bake into body_html, so the editor
 * preview is truthful — same line-break handling the sent email will have.
 */
export function renderDraftPreview(input: {
  subject: string;
  bodyContent: string;
  contentFormat?: "html" | "text";
}): { subject: string; html: string; text: string } {
  const format: "html" | "text" = input.contentFormat === "html" ? "html" : "text";
  const sampleContact: ContactForEmail = {
    contactId: 0,
    name: "Jordan Sample",
    email: "sample@example.com",
    modality: "Telehealth",
    city: "Albuquerque",
    serviceRequested: "therapy",
    requestingFor: "Myself",
    eccConsent: true,
  };
  const variables = buildVariableMap(sampleContact);
  const html = substituteVariables(wrapEmailContent(renderBodyContentToHtml(input.bodyContent, format)), variables);
  return {
    subject: substituteVariables(input.subject, variables),
    html,
    text: substituteVariables(input.bodyContent, variables),
  };
}

/**
 * Get template list for frontend
 */
export async function getTemplateList(): Promise<TemplateMetadata[]> {
  return getTemplateMetadataList();
}

/**
 * Determine ECC status from contact
 */
export function getEccStatus(contact: ContactForEmail): "present" | "missing" {
  // eccConsent === true means present
  // eccConsent === false, null, or undefined means missing
  return contact.eccConsent === true ? "present" : "missing";
}

/**
 * Send a templated email via Resend
 */
export async function sendTemplatedEmail(params: {
  templateId: string;
  contact: ContactForEmail;
  sentByEmail: string;
  eccStatus: "present" | "missing";
  dynamicFields?: Record<string, string>;
}): Promise<SendResult> {
  const { templateId, contact, sentByEmail, eccStatus, dynamicFields } = params;

  // Validate contact has email
  if (!contact.email) {
    console.error(
      `[email-service] Cannot send email: contact ${contact.contactId} has no email address`
    );
    return { success: false, error: "Contact has no email address" };
  }

  // Render template with admin-provided dynamic fields
  const rendered = await renderTemplate(templateId, contact, dynamicFields);
  if (!rendered) {
    return { success: false, error: `Template not found: ${templateId}` };
  }

  if (!resend) {
    console.warn(`[staging] Email send skipped (RESEND_API_KEY not configured) — would have sent "${rendered.templateName}" to ${contact.email}`);
    return {
      success: true,
      renderedHtml: rendered.bodyHtml,
      renderedSubject: rendered.subject,
      senderEmail: FROM_EMAIL,
      recipientEmail: contact.email,
      ccEmails: [],
    };
  }

  try {
    const sender = `${FROM_NAME} <${FROM_EMAIL}>`;

    // Build CC list — qualifying templates also CC the selected provider
    const QUALIFYING_TEMPLATES = ["appointment-confirmation", "post-appointment-survey", "intake-form-reminder"];
    const ccList: string[] = [REPLY_TO_EMAIL];

    if (QUALIFYING_TEMPLATES.includes(templateId) && dynamicFields?.therapistName) {
      const providerEmail = getProviderEmail(dynamicFields.therapistName);
      if (providerEmail) {
        ccList.push(providerEmail);
      } else {
        console.warn(`[email-service] Provider email not found in config: "${dynamicFields.therapistName}"`);
      }
    }

    // Manual CC from admin — silently ignore if empty or invalid
    if (dynamicFields?.ccEmail) {
      const manualCc = dynamicFields.ccEmail.trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(manualCc)) {
        ccList.push(manualCc);
      } else {
        console.warn(`[email-service] Ignoring invalid manual CC: "${manualCc}"`);
      }
    }

    const uniqueCc = Array.from(new Set(ccList));

    console.log(`[email-service] === EMAIL SEND START ===`);
    console.log(`[email-service] FROM: ${sender}`);
    console.log(`[email-service] TO: ${contact.email}`);
    console.log(`[email-service] REPLY-TO: ${REPLY_TO_EMAIL}`);
    console.log(`[email-service] CC: ${uniqueCc.join(", ")}`);
    console.log(`[email-service] Template: ${rendered.templateName}`);
    console.log(`[email-service] Admin (audit only): ${sentByEmail}`);
    console.log(`[email-service] ECC Status: ${eccStatus}`);

    const result = await resend.emails.send({
      from: sender,
      to: contact.email,
      replyTo: REPLY_TO_EMAIL,
      cc: uniqueCc,
      subject: rendered.subject,
      html: rendered.bodyHtml,
      text: rendered.bodyText,
    });

    if (result.error) {
      console.error(`[email-service] Resend API error:`, result.error);
      return { success: false, error: result.error.message };
    }

    console.log(
      `[email-service] Email sent successfully to ${contact.email}, Resend ID: ${result.data?.id}`
    );

    return {
      success: true,
      emailId: result.data?.id,
      renderedHtml: rendered.bodyHtml,
      renderedSubject: rendered.subject,
      senderEmail: FROM_EMAIL,
      recipientEmail: contact.email,
      ccEmails: uniqueCc,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `[email-service] Failed to send email to ${contact.email}:`,
      errorMessage
    );
    return { success: false, error: errorMessage };
  }
}

/**
 * Validate that email service is properly configured
 * Call at startup to warn about missing configuration
 */
export function validateEmailServiceConfig(): {
  configured: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (!process.env.RESEND_API_KEY) {
    warnings.push("RESEND_API_KEY not set — outbound email disabled (staging-safe)");
  }

  // Log the configured sender and reply-to for debugging
  console.log(`[email-service] Configured sender: ${FROM_NAME} <${FROM_EMAIL}>`);
  console.log(`[email-service] Reply-To: ${REPLY_TO_EMAIL}`);

  return {
    configured: warnings.length === 0,
    warnings,
  };
}
