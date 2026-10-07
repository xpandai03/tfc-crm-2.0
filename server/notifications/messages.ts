/**
 * Teams message text. Short, link-first, minimal PHI:
 *
 *   "<Event>: <First name L.> · <status or detail> · <link>"
 *
 * The ONLY contact data that leaves the CRM is a first name and a last initial.
 * Never DOB, phone, email, insurance id, payer, or address — the templates
 * below never read those fields, and containsPhiPattern() is the backstop that
 * refuses to queue a text that looks like it carries one anyway (a name field
 * someone typed a phone number into, say).
 */
import { REFERRAL_REPORT_STATUS_LABELS } from "../sync/db";
import type { NotificationContext } from "@shared/notification-rules";

const SEP = " · ";

export function appBaseUrl(): string {
  const raw = process.env.APP_URL || "https://tfc-crm-2-0.fly.dev";
  return raw.replace(/\/+$/, "");
}

export function statusDisplayLabel(code: number | null | undefined): string {
  if (code === null || code === undefined) return "No status";
  return REFERRAL_REPORT_STATUS_LABELS[code] ?? `Status ${code}`;
}

/**
 * "Jane Doe" → "Jane D."; "Doe, Jane" → "Jane D."; "Jane" → "Jane".
 * Letters only: digits, slashes and parentheses are stripped token by token, so
 * a name field carrying anything else cannot smuggle it into a message.
 */
export function shortName(raw: string | null | undefined): string {
  let s = (raw ?? "").replace(/\([^)]*\)/g, " ").trim();
  let first = "";
  let last = "";
  const clean = (t: string) => t.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'-]/g, "").replace(/^['-]+|['-]+$/g, "");
  if (s.includes(",")) {
    const [lastPart, firstPart] = s.split(",", 2);
    first = (firstPart ?? "").split(/\s+/).map(clean).find(Boolean) ?? "";
    last = lastPart.split(/\s+/).map(clean).filter(Boolean).pop() ?? "";
  } else {
    const tokens = s.split(/\s+/).map(clean).filter(Boolean);
    first = tokens[0] ?? "";
    last = tokens.length > 1 ? tokens[tokens.length - 1] : "";
  }
  if (!first && last) [first, last] = [last, ""];
  if (!first) return "Unnamed contact";
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  return last ? `${cap(first)} ${last.charAt(0).toUpperCase()}.` : cap(first);
}

export interface MessageExtras {
  /** RFS: "website form" | "uploaded referral". Survey: unused. */
  source?: string | null;
  /** Provider availability only. Providers are staff, not patients. */
  providerName?: string | null;
  acceptingClients?: number | null;
}

export function contactLink(contactId: number): string {
  return `${appBaseUrl()}/contact/${contactId}`;
}

/** One text per event — every recipient of the event gets the same words. */
export function buildNotificationText(ctx: NotificationContext, extras: MessageExtras = {}): string {
  const c = ctx.contact;
  switch (ctx.type) {
    case "contact.assigned":
      return [
        `Assigned to you: ${shortName(c?.name)}`,
        statusDisplayLabel(c?.statusCode),
        contactLink(c?.contactId ?? 0),
      ].join(SEP);
    case "contact.status_changed":
      return [
        `Status change: ${shortName(c?.name)}`,
        `now ${statusDisplayLabel(ctx.after.statusCode)}`,
        contactLink(c?.contactId ?? 0),
      ].join(SEP);
    case "survey.submitted":
      return [
        `Survey submitted: ${c ? shortName(c.name) : "unmatched"}`,
        `survey #${ctx.submissionId ?? "?"}`,
        c ? contactLink(c.contactId) : `${appBaseUrl()}/submissions`,
      ].join(SEP);
    case "rfs.submitted":
      return [
        `New RFS: ${c ? shortName(c.name) : "unmatched"}`,
        `RFS #${ctx.submissionId ?? "?"}${extras.source ? ` (${extras.source})` : ""}`,
        c ? contactLink(c.contactId) : `${appBaseUrl()}/submissions`,
      ].join(SEP);
    case "provider_availability.submitted":
      return [
        `Provider availability: ${extras.providerName?.trim() || "a provider"}`,
        extras.acceptingClients === null || extras.acceptingClients === undefined
          ? "submitted"
          : `accepting ${extras.acceptingClients} new client${extras.acceptingClients === 1 ? "" : "s"}`,
        `${appBaseUrl()}/providers`,
      ].join(SEP);
  }
}

export const TEST_NOTIFICATION_TEXT =
  "Test notification from TFC CRM · if you can read this, Teams delivery works";

/**
 * Backstop. True when a text looks like it carries a date, a phone number or an
 * email address. Links are removed first: the contact id in a URL is not PHI.
 */
export function containsPhiPattern(text: string): boolean {
  const body = text.replace(/https?:\/\/\S+/g, " ");
  const date = /\b\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}\b/;
  const phone = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
  const email = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const longDigits = /\d{7,}/; // member / insurance ids
  return date.test(body) || phone.test(body) || email.test(body) || longDigits.test(body);
}
