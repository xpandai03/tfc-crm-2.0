/**
 * Teams notification rules — who is told, about what.
 *
 * ONE ENTRY PER LINE of the client's list (notifications request, 2026-10-06).
 * Each rule names one recipient, one event type, and a condition over the
 * event. A single event can satisfy several rules for the same person (Lane's
 * "assigned to me moved to 202" and "any VACCN contact moved to 202" can both
 * hold); evaluateNotificationRules collapses those to ONE message per person.
 *
 * Status rules fire on a real change INTO the code (before !== after). A
 * re-save at the same code fires nothing — movedInto() is the only status
 * predicate and it checks both sides.
 *
 * Pure module: no IO, no env, safe to import from client, server and tests.
 * Delivery, mute and the kill switch live in server/notifications/.
 */
import { normalizeInsurance } from "./insurance-utils";

export const NOTIFICATION_EVENT_TYPES = [
  "contact.assigned",
  "contact.status_changed",
  "survey.submitted",
  "rfs.submitted",
  "provider_availability.submitted",
] as const;
export type NotificationEventType = typeof NOTIFICATION_EVENT_TYPES[number];

/** The contact as it stands AFTER the write. Only the fields rules and templates read. */
export interface NotificationContact {
  contactId: number;
  name: string | null;
  statusCode: number | null;
  assignedTo: string | null;
  insurancePayer: string | null;
}

export interface NotificationContext {
  type: NotificationEventType;
  /** Email of whoever made the change, or "system" / "provider_form". */
  actor: string | null;
  contact: NotificationContact | null;
  before: { statusCode?: number | null; assignedTo?: string | null };
  after: { statusCode?: number | null; assignedTo?: string | null };
  submissionId?: number | null;
}

export interface NotificationRule {
  /** Stable id, recorded on every queued row so the log says WHY someone was told. */
  id: string;
  recipient: string;
  /** The client's wording for this line. */
  description: string;
  event: NotificationEventType;
  when: (ctx: NotificationContext) => boolean;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  return x !== "" && x === y;
}

/** A contact newly assigned to `recipient` (re-assigning to the same person is not news). */
const assignedTo = (recipient: string) => (ctx: NotificationContext) =>
  sameEmail(ctx.after.assignedTo, recipient) && !sameEmail(ctx.before.assignedTo, recipient);

/** A real change into `code`. Same-code re-saves and unknown "after" values never match. */
const movedInto = (code: number) => (ctx: NotificationContext) =>
  ctx.after.statusCode === code && ctx.before.statusCode !== code;

/** Moved into `code` while the contact is assigned to `recipient`. */
const assignedContactMovedInto = (recipient: string, code: number) => (ctx: NotificationContext) =>
  movedInto(code)(ctx) && sameEmail(ctx.contact?.assignedTo, recipient);

/**
 * VACCN per the existing insurance normaliser (shared/insurance-utils.ts), the
 * same one the provider matcher uses. "VACCN" and "VACCN (VA Community Care)"
 * resolve; a bare "VA" and misspellings resolve to Unknown and do NOT match —
 * "VA" could equally be ChampVA, so guessing would mis-route.
 */
export function isVaccnPayer(payer: string | null | undefined): boolean {
  return normalizeInsurance(payer) === "VACCN";
}

const vaccnContactMovedInto = (code: number) => (ctx: NotificationContext) =>
  movedInto(code)(ctx) && isVaccnPayer(ctx.contact?.insurancePayer);

const always = () => true;

// ---------------------------------------------------------------------------
// The client's list
// ---------------------------------------------------------------------------

const SANDRA = "sandra@tfc.health";
const CHANTEL = "chantel@tfc.health";
const LANE = "lsego@tfc.health";
const NONA = "nbockius@tfc.health";
const ERICA = "ebenavidez@tfc.health";
const VICTORIA = "victoria@tfc.health";
const AMAYA = "amayac@tfc.health";

export const NOTIFICATION_RULES: readonly NotificationRule[] = [
  // Sandra
  { id: "sandra.assigned", recipient: SANDRA, event: "contact.assigned",
    description: "A contact is assigned to Sandra", when: assignedTo(SANDRA) },
  { id: "sandra.provider_availability", recipient: SANDRA, event: "provider_availability.submitted",
    description: "A provider submits a Provider Availability Submission", when: always },
  { id: "sandra.status_300", recipient: SANDRA, event: "contact.status_changed",
    description: "Any contact moves to 300 Submitted for Review", when: movedInto(300) },

  // Chantel
  { id: "chantel.assigned", recipient: CHANTEL, event: "contact.assigned",
    description: "A contact is assigned to Chantel", when: assignedTo(CHANTEL) },

  // Lane
  { id: "lane.assigned", recipient: LANE, event: "contact.assigned",
    description: "A contact is assigned to Lane", when: assignedTo(LANE) },
  { id: "lane.assigned_202", recipient: LANE, event: "contact.status_changed",
    description: "A contact assigned to Lane moves to 202 Scheduled", when: assignedContactMovedInto(LANE, 202) },
  { id: "lane.vaccn_202", recipient: LANE, event: "contact.status_changed",
    description: "Any VACCN contact moves to 202 Scheduled", when: vaccnContactMovedInto(202) },
  { id: "lane.status_200", recipient: LANE, event: "contact.status_changed",
    description: "Any contact moves to 200 Ready to Schedule", when: movedInto(200) },
  { id: "lane.survey", recipient: LANE, event: "survey.submitted",
    description: "A survey is submitted", when: always },

  // Nona
  { id: "nona.assigned", recipient: NONA, event: "contact.assigned",
    description: "A contact is assigned to Nona", when: assignedTo(NONA) },
  { id: "nona.assigned_202", recipient: NONA, event: "contact.status_changed",
    description: "A contact assigned to Nona moves to 202 Scheduled", when: assignedContactMovedInto(NONA, 202) },

  // Erica
  { id: "erica.assigned", recipient: ERICA, event: "contact.assigned",
    description: "A contact is assigned to Erica", when: assignedTo(ERICA) },
  { id: "erica.assigned_202", recipient: ERICA, event: "contact.status_changed",
    description: "A contact assigned to Erica moves to 202 Scheduled", when: assignedContactMovedInto(ERICA, 202) },
  { id: "erica.rfs", recipient: ERICA, event: "rfs.submitted",
    description: "A new RFS is submitted to the CRM", when: always },

  // Victoria
  { id: "victoria.assigned", recipient: VICTORIA, event: "contact.assigned",
    description: "A contact is assigned to Victoria", when: assignedTo(VICTORIA) },
  { id: "victoria.assigned_202", recipient: VICTORIA, event: "contact.status_changed",
    description: "A contact assigned to Victoria moves to 202 Scheduled", when: assignedContactMovedInto(VICTORIA, 202) },

  // Amaya
  { id: "amaya.assigned", recipient: AMAYA, event: "contact.assigned",
    description: "A contact is assigned to Amaya", when: assignedTo(AMAYA) },
  { id: "amaya.assigned_202", recipient: AMAYA, event: "contact.status_changed",
    description: "A contact assigned to Amaya moves to 202 Scheduled", when: assignedContactMovedInto(AMAYA, 202) },
];

/** Everyone any rule can reach. Seeded MUTED on first boot (server/notifications/db.ts). */
export function notificationRecipients(rules: readonly NotificationRule[] = NOTIFICATION_RULES): string[] {
  return Array.from(new Set(rules.map((r) => r.recipient.toLowerCase()))).sort();
}

export interface NotificationMatch {
  recipient: string;
  ruleIds: string[];
}

/** Recipients for one event, one entry per person, with every rule that put them there. */
export function evaluateNotificationRules(
  ctx: NotificationContext,
  rules: readonly NotificationRule[] = NOTIFICATION_RULES,
): NotificationMatch[] {
  const byRecipient = new Map<string, string[]>();
  for (const rule of rules) {
    if (rule.event !== ctx.type) continue;
    if (!rule.when(ctx)) continue;
    const key = rule.recipient.toLowerCase();
    byRecipient.set(key, [...(byRecipient.get(key) ?? []), rule.id]);
  }
  return Array.from(byRecipient, ([recipient, ruleIds]) => ({ recipient, ruleIds }));
}
