/**
 * Teams notification endpoints.
 *
 *   GET  /api/notifications/me                 — caller's own mute + global state
 *   PUT  /api/notifications/me                 — caller mutes / unmutes themselves
 *   GET  /api/admin/notifications              — management: last 200 rows, prefs, rules
 *   PUT  /api/admin/notifications/preferences  — management: mute / unmute a person
 *   POST /api/admin/notifications/test         — management: test message to the CALLER
 *   POST /api/internal/notifications/test      — X-Sync-Key: test message to the
 *                                                developer address only (deploy smoke)
 *
 * The test path goes through the real queue and worker, ignores mute (it is an
 * explicit request) and honours the kill switch and a missing webhook.
 */
import type { Express } from "express";
import { canManageNotifications } from "@shared/access-control";
import { NOTIFICATION_RULES } from "@shared/notification-rules";
import {
  enqueueNotification,
  getNotificationById,
  getRecentNotifications,
  isMuted,
  listPreferences,
  setMuted,
  type NotificationRow,
} from "./db";
import { TEST_NOTIFICATION_TEXT } from "./messages";
import { kickNotificationWorker, notificationsEnabled, teamsNotifyUrl } from "./worker";

/** The only recipient the key-authed smoke route will post to. */
export const KEY_TEST_RECIPIENTS = ["raunek@tfc.health"];

export async function sendTestNotification(recipient: string, timeoutMs = 20_000): Promise<NotificationRow | null> {
  const email = recipient.trim().toLowerCase();
  const status = !notificationsEnabled() ? "disabled" : !teamsNotifyUrl() ? "no_url" : "pending";
  const { id } = await enqueueNotification({
    recipient: email,
    text: TEST_NOTIFICATION_TEXT,
    event: "test",
    dedupeKey: `test|${Date.now()}`,
    ruleIds: ["test"],
    contactId: null,
    submissionId: null,
    status,
  });
  if (status === "pending") {
    const deadline = Date.now() + timeoutMs;
    await kickNotificationWorker();
    let row = await getNotificationById(id);
    // A retry is scheduled seconds away, so the first outcome is what we report.
    while (row && (row.status === "pending" || row.status === "sending") && row.attempts === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      await kickNotificationWorker();
      row = await getNotificationById(id);
    }
    return row;
  }
  return getNotificationById(id);
}

function sessionEmail(req: any): string | null {
  if (!(req.isAuthenticated && req.isAuthenticated())) return null;
  const e = (req.user?.email ?? "").toLowerCase().trim();
  return e || null;
}

export function registerNotificationRoutes(app: Express, syncApiKey: string): void {
  const requireManager = (req: any, res: any): string | null => {
    const email = sessionEmail(req);
    if (!email) { res.status(401).json({ error: "Authentication required" }); return null; }
    if (!canManageNotifications(email)) { res.status(403).json({ error: "Access denied" }); return null; }
    return email;
  };

  app.get("/api/notifications/me", async (req: any, res) => {
    try {
      const email = sessionEmail(req);
      if (!email) return res.status(401).json({ error: "Authentication required" });
      return res.json({
        email,
        muted: await isMuted(email),
        enabled: notificationsEnabled(),
        canManage: canManageNotifications(email),
      });
    } catch (e) {
      console.error(`[notify] me failed: ${e instanceof Error ? e.message : "unknown"}`);
      return res.status(500).json({ error: "Could not load notification settings" });
    }
  });

  app.put("/api/notifications/me", async (req: any, res) => {
    try {
      const email = sessionEmail(req);
      if (!email) return res.status(401).json({ error: "Authentication required" });
      if (typeof req.body?.muted !== "boolean") return res.status(400).json({ error: "muted (boolean) is required" });
      await setMuted(email, req.body.muted, email);
      return res.json({ email, muted: req.body.muted });
    } catch (e) {
      console.error(`[notify] set own mute failed: ${e instanceof Error ? e.message : "unknown"}`);
      return res.status(500).json({ error: "Could not save notification settings" });
    }
  });

  app.get("/api/admin/notifications", async (req: any, res) => {
    try {
      if (!requireManager(req, res)) return;
      const [log, preferences] = await Promise.all([getRecentNotifications(200), listPreferences()]);
      return res.json({
        enabled: notificationsEnabled(),
        webhookConfigured: !!teamsNotifyUrl(),
        rules: NOTIFICATION_RULES.map(({ id, recipient, event, description }) => ({ id, recipient, event, description })),
        preferences,
        log,
      });
    } catch (e) {
      console.error(`[notify] admin log failed: ${e instanceof Error ? e.message : "unknown"}`);
      return res.status(500).json({ error: "Could not load notifications" });
    }
  });

  app.put("/api/admin/notifications/preferences", async (req: any, res) => {
    try {
      const actor = requireManager(req, res);
      if (!actor) return;
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (!/^[^\s@]+@tfc\.health$/.test(email)) return res.status(400).json({ error: "email must be a tfc.health address" });
      if (typeof req.body?.muted !== "boolean") return res.status(400).json({ error: "muted (boolean) is required" });
      await setMuted(email, req.body.muted, actor);
      console.log(`[notify] ${actor} set ${email} muted=${req.body.muted}`);
      return res.json({ email, muted: req.body.muted });
    } catch (e) {
      console.error(`[notify] set mute failed: ${e instanceof Error ? e.message : "unknown"}`);
      return res.status(500).json({ error: "Could not save notification settings" });
    }
  });

  app.post("/api/admin/notifications/test", async (req: any, res) => {
    try {
      const email = requireManager(req, res);
      if (!email) return;
      const row = await sendTestNotification(email);
      return res.json({ recipient: email, status: row?.status ?? "unknown", httpStatus: row?.lastHttpStatus ?? null, error: row?.error ?? null, id: row?.id ?? null });
    } catch (e) {
      console.error(`[notify] test failed: ${e instanceof Error ? e.message : "unknown"}`);
      return res.status(500).json({ error: "Test notification failed" });
    }
  });

  app.post("/api/internal/notifications/test", async (req: any, res) => {
    try {
      if (!syncApiKey || req.headers["x-sync-key"] !== syncApiKey) return res.status(401).json({ error: "unauthorized" });
      const recipient = typeof req.body?.recipient === "string" ? req.body.recipient.trim().toLowerCase() : "";
      if (!KEY_TEST_RECIPIENTS.includes(recipient)) return res.status(403).json({ error: "recipient not allowed" });
      const row = await sendTestNotification(recipient);
      return res.json({ recipient, status: row?.status ?? "unknown", httpStatus: row?.lastHttpStatus ?? null, error: row?.error ?? null, id: row?.id ?? null });
    } catch (e) {
      console.error(`[notify] internal test failed: ${e instanceof Error ? e.message : "unknown"}`);
      return res.status(500).json({ error: "Test notification failed" });
    }
  });
}
