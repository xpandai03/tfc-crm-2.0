/**
 * The event layer. Write paths call emitNotificationEvent AFTER their write has
 * committed — never inside a transaction — and it returns immediately: the
 * rule evaluation, the queue insert and the webhook call all happen on a later
 * tick, and every failure is caught and logged. A broken notification can never
 * fail, slow or roll back the write that caused it.
 *
 *   emitNotificationEvent({ type, contactId | submissionId, before, after, actor })
 *
 * Order of decisions for each recipient a rule picked:
 *   kill switch → actor is the recipient → muted → PHI backstop → no webhook
 *   → queued (and the queue applies the 10-minute dedupe)
 * Every outcome is a row, so the admin log shows what would have gone out.
 */
import {
  evaluateNotificationRules,
  sameEmail,
  type NotificationContact,
  type NotificationContext,
  type NotificationEventType,
} from "@shared/notification-rules";
import { buildNotificationText, containsPhiPattern, type MessageExtras } from "./messages";
import {
  enqueueNotification,
  isMuted,
  loadNotificationContact,
  type EnqueueInput,
  type NotificationStatus,
} from "./db";
import { kickNotificationWorker, notificationsEnabled, teamsNotifyUrl } from "./worker";

export interface NotificationEventInput {
  type: NotificationEventType;
  contactId?: number | null;
  submissionId?: number | null;
  before?: { statusCode?: number | null; assignedTo?: string | null };
  after?: { statusCode?: number | null; assignedTo?: string | null };
  actor?: string | null;
  extras?: MessageExtras & {
    /** Dedupe identity when there is no contact (provider availability: the provider's email). */
    entityKey?: string | null;
  };
}

export interface PlanOptions {
  enabled: boolean;
  hasUrl: boolean;
  isMuted: (email: string) => boolean | Promise<boolean>;
}

/** The dedupe identity: event + what changed + which record. */
export function dedupeKeyFor(ctx: NotificationContext, entityKey?: string | null): string {
  const what = ctx.type === "contact.status_changed" ? `:${ctx.after.statusCode ?? "null"}` : "";
  const who = ctx.contact
    ? `contact:${ctx.contact.contactId}`
    : entityKey
      ? `entity:${entityKey.toLowerCase()}`
      : `submission:${ctx.submissionId ?? "none"}`;
  return `${ctx.type}${what}|${who}`;
}

/** Pure apart from isMuted: which rows this event becomes. */
export async function planNotifications(
  ctx: NotificationContext,
  extras: NotificationEventInput["extras"],
  opts: PlanOptions,
): Promise<EnqueueInput[]> {
  const matches = evaluateNotificationRules(ctx);
  if (matches.length === 0) return [];
  const text = buildNotificationText(ctx, extras ?? {});
  const dedupeKey = dedupeKeyFor(ctx, extras?.entityKey);
  const rows: EnqueueInput[] = [];
  for (const m of matches) {
    let status: NotificationStatus = "pending";
    if (!opts.enabled) status = "disabled";
    else if (sameEmail(ctx.actor, m.recipient)) status = "self";
    else if (await opts.isMuted(m.recipient)) status = "muted";
    else if (containsPhiPattern(text)) status = "blocked";
    else if (!opts.hasUrl) status = "no_url";
    rows.push({
      recipient: m.recipient,
      text: status === "blocked" ? "[withheld: text failed the PHI check]" : text,
      event: ctx.type,
      dedupeKey,
      ruleIds: m.ruleIds,
      contactId: ctx.contact?.contactId ?? null,
      submissionId: ctx.submissionId ?? null,
      status,
    });
  }
  return rows;
}

export interface ProcessDeps {
  loadContact: (id: number) => Promise<NotificationContact | null>;
  enqueue: (row: EnqueueInput) => Promise<{ id: number; status: NotificationStatus }>;
  plan: PlanOptions;
  kick: () => unknown;
}

function liveDeps(): ProcessDeps {
  return {
    loadContact: loadNotificationContact,
    enqueue: enqueueNotification,
    plan: { enabled: notificationsEnabled(), hasUrl: !!teamsNotifyUrl(), isMuted },
    kick: () => { void kickNotificationWorker(); },
  };
}

export async function processNotificationEvent(
  input: NotificationEventInput,
  deps: ProcessDeps = liveDeps(),
): Promise<Array<{ id: number; recipient: string; status: NotificationStatus }>> {
  const contact = input.contactId ? await deps.loadContact(input.contactId) : null;
  const ctx: NotificationContext = {
    type: input.type,
    actor: input.actor ?? null,
    contact,
    before: input.before ?? {},
    after: input.after ?? {},
    submissionId: input.submissionId ?? null,
  };
  const rows = await planNotifications(ctx, input.extras, deps.plan);
  const results: Array<{ id: number; recipient: string; status: NotificationStatus }> = [];
  for (const row of rows) {
    const r = await deps.enqueue(row);
    results.push({ id: r.id, recipient: row.recipient, status: r.status });
    if (r.status !== "pending") {
      console.log(`[notify] ${row.event} → ${row.recipient}: ${r.status} (id=${r.id})`);
    }
  }
  if (results.some((r) => r.status === "pending")) deps.kick();
  return results;
}

/** Fire and forget. Never throws, never awaits IO on the caller's tick. */
export function emitNotificationEvent(input: NotificationEventInput): void {
  setImmediate(() => {
    processNotificationEvent(input).catch((e) => {
      console.error(
        `[notify] event ${input.type} dropped (contact=${input.contactId ?? "-"} ` +
          `submission=${input.submissionId ?? "-"}): ${e instanceof Error ? e.message : "unknown"}`,
      );
    });
  });
}
