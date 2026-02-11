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
  type EmailTemplate,
  type TemplateMetadata,
} from "./templates";

// Initialize Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

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
    serviceRequested: contact.serviceRequested || "therapy",
    // Appointment confirmation variables — admin fills these contextually
    therapistName: "[Provider Name]",
    appointmentDatetime: "[Appointment Date & Time]",
    appointmentLocationOrModality: contact.modality || "[Location/Modality]",
    // Survey variable
    surveyLink: "[Survey Link]",
  };

  // Override defaults with admin-provided values
  if (dynamicFields) {
    for (const [key, value] of Object.entries(dynamicFields)) {
      if (key in map && value && value.trim()) {
        map[key] = value.trim();
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
export function renderTemplate(
  templateId: string,
  contact: ContactForEmail,
  dynamicFields?: Record<string, string>
): RenderedEmail | null {
  const template = getTemplateById(templateId);
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
 * Get template list for frontend
 */
export function getTemplateList(): TemplateMetadata[] {
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
  const rendered = renderTemplate(templateId, contact, dynamicFields);
  if (!rendered) {
    return { success: false, error: `Template not found: ${templateId}` };
  }

  // Check Resend API key
  if (!process.env.RESEND_API_KEY) {
    console.error("[email-service] RESEND_API_KEY not configured");
    return { success: false, error: "Email service not configured" };
  }

  try {
    // Defensive logging - verify sender configuration
    const sender = `${FROM_NAME} <${FROM_EMAIL}>`;
    console.log(`[email-service] === EMAIL SEND START ===`);
    console.log(`[email-service] FROM: ${sender}`);
    console.log(`[email-service] TO: ${contact.email}`);
    console.log(`[email-service] REPLY-TO: ${REPLY_TO_EMAIL}`);
    console.log(`[email-service] Template: ${rendered.templateName}`);
    console.log(`[email-service] Admin (audit only): ${sentByEmail}`);
    console.log(`[email-service] ECC Status: ${eccStatus}`);

    const result = await resend.emails.send({
      from: sender,
      to: contact.email,
      replyTo: REPLY_TO_EMAIL, // All replies routed to admin inbox (camelCase required by Resend SDK v6+)
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
    warnings.push("RESEND_API_KEY not set - email sending will fail");
  }

  // Log the configured sender and reply-to for debugging
  console.log(`[email-service] Configured sender: ${FROM_NAME} <${FROM_EMAIL}>`);
  console.log(`[email-service] Reply-To: ${REPLY_TO_EMAIL}`);

  return {
    configured: warnings.length === 0,
    warnings,
  };
}
