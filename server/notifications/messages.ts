/**
 * Teams message text — the client's templates, verbatim (2026-10-15).
 *
 *   assigned            CRM: [name_link] has been assigned to you
 *   provider avail.     CRM: [provider name → submission] has submitted a request for clients
 *   status 300          CRM: [name_link] has been submitted for review
 *   status 202          CRM: [name_link] has been scheduled by [user]
 *   status 202 VACCN    CRM: VACCN Client [name_link] has been scheduled by [user]
 *   status 200          CRM: [name_link] has been moved to ready to schedule
 *   survey submitted    CRM: [name on survey] has submitted survey for [provider name]   (no link)
 *   new RFS             CRM: A new RFS has been submitted for [name_link]
 *   note added          CRM: A new note has been added to [name_link] by [user]
 *
 * [name_link] is the contact's full name as a link to the contact page; [user]
 * is the display name of the staff member who acted.
 *
 * WHAT LEAVES THE CRM: a client's name and a link. Never DOB, phone, email,
 * insurance or note contents — no template reads them, and containsPhiPattern()
 * is the backstop that refuses to queue a text that looks like it carries one
 * (a name field someone typed a phone number into, say).
 *
 * The text differs PER RECIPIENT for a 202 move (the VACCN wording is Lane's
 * VACCN rule), so it is built from the rules that picked the recipient.
 */
import { REFERRAL_REPORT_STATUS_LABELS } from "../sync/db";
import type { NotificationContext } from "@shared/notification-rules";

export function appBaseUrl(): string {
  const raw = process.env.APP_URL || "https://tfc-crm-2-0.fly.dev";
  return raw.replace(/\/+$/, "");
}

export function statusDisplayLabel(code: number | null | undefined): string {
  if (code === null || code === undefined) return "No status";
  return REFERRAL_REPORT_STATUS_LABELS[code] ?? `Status ${code}`;
}

/**
 * How a link is written. "markdown" ([Name](url)) unless NOTIFY_LINK_FORMAT=html
 * (<a href="url">Name</a>): which one Teams renders depends on the Power
 * Automate flow's message field, so it is a setting, not code.
 */
export type LinkFormat = "markdown" | "html";
export function linkFormat(env: NodeJS.ProcessEnv = process.env): LinkFormat {
  return (env.NOTIFY_LINK_FORMAT ?? "").trim().toLowerCase() === "html" ? "html" : "markdown";
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escapeMarkdownLabel = (s: string) => s.replace(/[\[\]\\]/g, (c) => `\\${c}`);

/** A label as a link, in the configured format. */
export function link(label: string, url: string, fmt: LinkFormat): string {
  return fmt === "html"
    ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
    : `[${escapeMarkdownLabel(label)}](${url})`;
}

/** Plain text in the configured format (escaped for HTML). */
function plain(s: string, fmt: LinkFormat): string {
  return fmt === "html" ? escapeHtml(s) : s;
}

/** The name as stored, whitespace collapsed. */
export function fullName(raw: string | null | undefined, fallback: string): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  return s || fallback;
}

export function contactLink(contactId: number): string {
  return `${appBaseUrl()}/contact/${contactId}`;
}

/** A submission's row on Submissions (the page opens its detail). */
export function submissionLink(submissionId: number | null | undefined): string {
  return submissionId ? `${appBaseUrl()}/submissions?submission=${submissionId}` : `${appBaseUrl()}/submissions`;
}

export interface MessageExtras {
  /** Display name of the staff member who acted ([user]). */
  actorName?: string | null;
  /** Provider availability: the provider's name. Providers are staff, not patients. */
  providerName?: string | null;
  /** Kept for the provider-availability call site; not in the client's template. */
  acceptingClients?: number | null;
  /** Survey: the legal name the client typed on the survey. */
  surveyName?: string | null;
  /** Survey: the provider label as Submissions shows it ("Name (OFFICE)"). */
  providerLabel?: string | null;
  /** RFS: "website form" | "uploaded referral". Not in the client's template. */
  source?: string | null;
}

const NO_USER = "a staff member";

/**
 * The text for one recipient of one event. `ruleIds` are the rules that picked
 * this recipient (evaluateNotificationRules), which is how a 202 move reads
 * "VACCN Client …" for Lane's VACCN rule and plain "… scheduled" for an assignee.
 */
export function buildNotificationText(
  ctx: NotificationContext,
  extras: MessageExtras = {},
  ruleIds: readonly string[] = [],
  fmt: LinkFormat = linkFormat(),
): string {
  const c = ctx.contact;
  const nameLink = c ? link(fullName(c.name, "a contact"), contactLink(c.contactId), fmt) : plain("a contact", fmt);
  const user = plain(fullName(extras.actorName, NO_USER), fmt);
  switch (ctx.type) {
    case "contact.assigned":
      return `CRM: ${nameLink} has been assigned to you`;
    case "contact.status_changed": {
      const code = ctx.after.statusCode;
      if (code === 202 && ruleIds.some((r) => r.endsWith(".vaccn_202"))) {
        return `CRM: VACCN Client ${nameLink} has been scheduled by ${user}`;
      }
      if (code === 202) return `CRM: ${nameLink} has been scheduled by ${user}`;
      if (code === 300) return `CRM: ${nameLink} has been submitted for review`;
      if (code === 200) return `CRM: ${nameLink} has been moved to ready to schedule`;
      // No rule fires on another code today; a plain sentence if one ever does.
      return `CRM: ${nameLink} has been moved to ${plain(statusDisplayLabel(code), fmt)}`;
    }
    case "survey.submitted":
      return `CRM: ${plain(fullName(extras.surveyName, "A client"), fmt)} has submitted survey for ` +
        plain(fullName(extras.providerLabel, "a provider"), fmt);
    case "rfs.submitted":
      return `CRM: A new RFS has been submitted for ${nameLink}`;
    case "provider_availability.submitted":
      return `CRM: ${link(fullName(extras.providerName, "A provider"), submissionLink(ctx.submissionId), fmt)} ` +
        `has submitted a request for clients`;
    case "contact.note_added":
      return `CRM: A new note has been added to ${nameLink} by ${user}`;
  }
}

/** The test message: one link, so a test shows whether Teams renders links. */
export function testNotificationText(fmt: LinkFormat = linkFormat()): string {
  return `CRM: test notification. If "${plain("TFC CRM", fmt)}" below is a clickable link, links render: ` +
    link("TFC CRM", `${appBaseUrl()}/`, fmt);
}

/**
 * Backstop. True when a text looks like it carries a date, a phone number or an
 * email address. Links are removed first: the contact id in a URL is not PHI.
 */
export function containsPhiPattern(text: string): boolean {
  const body = text
    .replace(/<a\s+href="[^"]*">/gi, " ")
    .replace(/\]\(https?:\/\/[^)\s]*\)/g, "] ")
    .replace(/https?:\/\/\S+/g, " ");
  const date = /\b\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}\b/;
  const phone = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
  const email = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const longDigits = /\d{7,}/; // member / insurance ids
  return date.test(body) || phone.test(body) || email.test(body) || longDigits.test(body);
}
