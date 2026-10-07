/**
 * Teams notifications against a real database and a local stand-in for the
 * Power Automate webhook: boot seeding (staff muted, developer not), the
 * 10-minute dedupe, mute, kill switch, the queue's retry → failed path, and the
 * n8n sync path emitting only for transitions it really made.
 *
 * Writes rows. Run ONLY against a throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55435/tfc_notifytest \
 *     npx tsx --tsconfig tsconfig.test.json scripts/test-notifications-db.ts
 *
 * NO PHI: ZZTEST contacts. The webhook is a local server; nothing leaves the machine.
 */
import http from "http";

const url = process.env.DATABASE_URL ?? "";
if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_notifytest/.test(url))) {
  console.error(
    "REFUSING TO RUN. This script writes rows and must only point at the throwaway local\n" +
      "database (127.0.0.1/localhost, tfc_notifytest).",
  );
  process.exit(2);
}

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Local webhook: answers with whatever `nextStatus` holds; records every body.
let nextStatus = 202;
const received: Array<{ recipient: string; text: string }> = [];
const hook = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push(JSON.parse(body));
    res.statusCode = nextStatus;
    res.end();
  });
});

async function main() {
  await new Promise<void>((r) => hook.listen(0, "127.0.0.1", () => r()));
  const port = (hook.address() as { port: number }).port;
  process.env.TEAMS_NOTIFY_URL = `http://127.0.0.1:${port}/hook`;
  process.env.NOTIFICATIONS_ENABLED = "true";
  process.env.APP_URL = "https://crm.example.invalid";

  const { getPool, closePool } = await import("../server/db/pool");
  const sync = await import("../server/sync/db");
  const activity = await import("../server/activity/db");
  const db = await import("../server/notifications/db");
  const emit = await import("../server/notifications/emit");
  const worker = await import("../server/notifications/worker");
  const { sendTestNotification } = await import("../server/notifications/routes");
  const pool = getPool();

  await sync.initSyncTables();
  await activity.initActivityTable();
  await pool.query(`DROP TABLE IF EXISTS notifications, notification_preferences`);

  // -------------------------------------------------------------------------
  console.log("\nboot seeding");
  await db.initNotificationTables();
  const prefs = await db.listPreferences();
  eq("seven staff seeded", prefs.length, 7);
  ok("all seeded muted", prefs.every((p) => p.muted && p.updatedBy === "seed"));
  ok("developer not seeded, so not muted", !(await db.isMuted("raunek@tfc.health")));
  await db.setMuted("sandra@tfc.health", false, "raunek@tfc.health");
  await db.initNotificationTables();
  ok("a later boot does not re-mute an unmuted person", !(await db.isMuted("sandra@tfc.health")));
  ok("init is idempotent (tables exist, no throw)", true);
  // Unmute everyone for the event tests below.
  for (const p of prefs) await db.setMuted(p.email, false, "zztest");

  // -------------------------------------------------------------------------
  console.log("\ndedupe");
  const base = { recipient: "raunek@tfc.health", text: "ZZTEST", event: "contact.status_changed", ruleIds: ["x"], contactId: 990301, submissionId: null };
  const a = await db.enqueueNotification({ ...base, dedupeKey: "contact.status_changed:202|contact:990301", status: "pending" });
  const b = await db.enqueueNotification({ ...base, dedupeKey: "contact.status_changed:202|contact:990301", status: "pending" });
  const c = await db.enqueueNotification({ ...base, dedupeKey: "contact.status_changed:200|contact:990301", status: "pending" });
  const d = await db.enqueueNotification({ ...base, recipient: "lsego@tfc.health", dedupeKey: "contact.status_changed:202|contact:990301", status: "pending" });
  eq("first queued, repeat deduped, other status queued, other person queued",
    [a.status, b.status, c.status, d.status], ["pending", "deduped", "pending", "pending"]);
  const [r1, r2] = await Promise.all([
    db.enqueueNotification({ ...base, dedupeKey: "race", status: "pending" }),
    db.enqueueNotification({ ...base, dedupeKey: "race", status: "pending" }),
  ]);
  eq("two racing inserts: exactly one gets through", [r1.status, r2.status].sort(), ["deduped", "pending"]);
  await db.enqueueNotification({ ...base, dedupeKey: "muted-first", status: "muted" });
  eq("a muted row does not dedupe a later real one",
    (await db.enqueueNotification({ ...base, dedupeKey: "muted-first", status: "pending" })).status, "pending");
  await pool.query(`UPDATE notifications SET created_at = NOW() - INTERVAL '11 minutes' WHERE id = $1`, [a.id]);
  eq("outside the 10-minute window it sends again",
    (await db.enqueueNotification({ ...base, dedupeKey: "contact.status_changed:202|contact:990301", status: "pending" })).status, "pending");
  await pool.query(`DELETE FROM notifications`);

  // -------------------------------------------------------------------------
  console.log("\nqueue: retry then failed, against the real table");
  const q = await db.enqueueNotification({ ...base, dedupeKey: "retry-path", status: "pending" });
  nextStatus = 500;
  const live = () => ({ store: worker.pgDeliveryStore, fetchFn: fetch, url: process.env.TEAMS_NOTIFY_URL!, enabled: true });
  for (let i = 1; i <= 4; i++) {
    await worker.drainOnce(live());
    const row = await db.getNotificationById(q.id);
    if (i < 4) {
      ok(`try ${i}: back to pending, attempts=${i}, HTTP 500 recorded`,
        row?.status === "pending" && row.attempts === i && row.lastHttpStatus === 500, JSON.stringify(row));
      const due = await pool.query(`SELECT next_attempt_at > NOW() AS later FROM notifications WHERE id = $1`, [q.id]);
      ok(`try ${i}: next attempt is in the future (backoff)`, due.rows[0].later === true);
      eq(`try ${i}: not claimable before it is due`, (await worker.drainOnce(live())).length, 0);
      await pool.query(`UPDATE notifications SET next_attempt_at = NOW() WHERE id = $1`, [q.id]);
    } else {
      ok("try 4: failed, attempts=4", row?.status === "failed" && row.attempts === 4, JSON.stringify(row));
    }
  }
  eq("webhook was called exactly 4 times", received.length, 4);
  ok("error column holds the status, not a body", (await db.getNotificationById(q.id))?.error === "HTTP 500");

  nextStatus = 202;
  received.length = 0;
  const s = await db.enqueueNotification({ ...base, dedupeKey: "send-path", status: "pending" });
  await worker.drainOnce(live());
  const sent = await db.getNotificationById(s.id);
  ok("202 → sent, sent_at stamped", sent?.status === "sent" && sent.lastHttpStatus === 202 && !!sent.sentAt, JSON.stringify(sent));
  eq("webhook got {recipient, text}", received, [{ recipient: "raunek@tfc.health", text: "ZZTEST" }]);

  console.log("\ntest button path");
  received.length = 0;
  const t = await sendTestNotification("raunek@tfc.health", 5000);
  ok("test → sent with 202", t?.status === "sent" && t.lastHttpStatus === 202, JSON.stringify(t));
  eq("test went to the caller only", received.map((r) => r.recipient), ["raunek@tfc.health"]);
  await db.setMuted("raunek@tfc.health", true, "zztest");
  eq("test ignores the caller's own mute", (await sendTestNotification("raunek@tfc.health", 5000))?.status, "sent");
  await db.setMuted("raunek@tfc.health", false, "zztest");
  process.env.NOTIFICATIONS_ENABLED = "false";
  eq("kill switch: test is recorded 'disabled', not sent", (await sendTestNotification("raunek@tfc.health", 5000))?.status, "disabled");
  process.env.NOTIFICATIONS_ENABLED = "true";
  const savedUrl = process.env.TEAMS_NOTIFY_URL;
  delete process.env.TEAMS_NOTIFY_URL;
  eq("webhook unset: test is dropped 'no_url', no crash", (await sendTestNotification("raunek@tfc.health", 5000))?.status, "no_url");
  process.env.TEAMS_NOTIFY_URL = savedUrl;
  await pool.query(`DELETE FROM notifications`);

  // -------------------------------------------------------------------------
  console.log("\nemit end to end (real loader, real queue, local webhook)");
  const IDS = [990311, 990312, 990313, 990314];
  await pool.query(`DELETE FROM sync_contacts WHERE contact_id = ANY($1)`, [IDS]);
  await pool.query(
    `INSERT INTO sync_contacts (contact_id, name, status_code, assigned_to, insurance_payer) VALUES
       (990311, 'ZZTEST Vaccn', 200, 'nbockius@tfc.health', 'VACCN (VA Community Care)'),
       (990312, 'ZZTEST Plain', 200, 'lsego@tfc.health', 'ZZTEST Plan'),
       (990313, 'ZZTEST Nullstatus', NULL, NULL, NULL),
       (990314, 'ZZTEST Sheet', 100, NULL, NULL)`,
  );
  const settle = async () => { await sleep(150); await worker.kickNotificationWorker(); await sleep(50); };
  const rows = async () => (await pool.query(
    `SELECT recipient, status, contact_id AS "contactId", text FROM notifications ORDER BY id`)).rows;

  received.length = 0;
  emit.emitNotificationEvent({ type: "contact.status_changed", contactId: 990311, before: { statusCode: 200 }, after: { statusCode: 202 }, actor: "zztest@example.invalid" });
  await settle();
  let r = await rows();
  eq("VACCN contact assigned to Nona →202: Lane and Nona, both sent",
    r.map((x) => [x.recipient, x.status]), [["lsego@tfc.health", "sent"], ["nbockius@tfc.health", "sent"]]);
  eq("webhook received two messages", received.length, 2);
  eq("message text", r[0].text, "Status change: ZZTEST V. · now Scheduled · https://crm.example.invalid/contact/990311");

  emit.emitNotificationEvent({ type: "contact.status_changed", contactId: 990311, before: { statusCode: 201 }, after: { statusCode: 202 }, actor: "zztest@example.invalid" });
  await settle();
  r = await rows();
  eq("same event again within 10 minutes: both deduped", r.slice(2).map((x) => x.status), ["deduped", "deduped"]);
  eq("webhook still at two", received.length, 2);

  await pool.query(`DELETE FROM notifications`);
  emit.emitNotificationEvent({ type: "contact.status_changed", contactId: 990312, before: { statusCode: 202 }, after: { statusCode: 202 } });
  await settle();
  eq("re-save at the same code: no rows at all", (await rows()).length, 0);

  await db.setMuted("lsego@tfc.health", true, "zztest");
  emit.emitNotificationEvent({ type: "contact.status_changed", contactId: 990312, before: { statusCode: 201 }, after: { statusCode: 202 } });
  await settle();
  eq("Lane muted: her 202 is logged 'muted' and not sent", (await rows()).map((x) => x.status), ["muted"]);
  eq("webhook still at two", received.length, 2);
  await db.setMuted("lsego@tfc.health", false, "zztest");

  await pool.query(`DELETE FROM notifications`);
  process.env.NOTIFICATIONS_ENABLED = "false";
  emit.emitNotificationEvent({ type: "contact.assigned", contactId: 990312, before: { assignedTo: null }, after: { assignedTo: "lsego@tfc.health" } });
  await settle();
  eq("kill switch: logged 'disabled', not sent", (await rows()).map((x) => x.status), ["disabled"]);
  process.env.NOTIFICATIONS_ENABLED = "true";

  console.log("\nn8n sync path");
  await pool.query(`DELETE FROM notifications`);
  await sync.upsertSingleContact({ contactId: 990313, name: "ZZTEST Nullstatus", statusCode: 200 } as any, { actorEmail: "system" });
  await settle();
  r = await rows();
  eq("sync fills a NULL status with 200 → Lane told", r.map((x) => [x.recipient, x.contactId, x.status]), [["lsego@tfc.health", 990313, "sent"]]);
  await pool.query(`DELETE FROM notifications`);
  await sync.upsertSingleContact({ contactId: 990314, name: "ZZTEST Sheet", statusCode: 300 } as any, { actorEmail: "system" });
  await settle();
  eq("Sheet says 300 but the CRM keeps 100 (COALESCE): nothing emitted", (await rows()).length, 0);
  eq("…and the CRM status really is still 100",
    (await pool.query(`SELECT status_code FROM sync_contacts WHERE contact_id = 990314`)).rows[0].status_code, 100);
  await sync.upsertSingleContact({ contactId: 990315, name: "ZZTEST New", statusCode: 200, assignedTo: "lsego@tfc.health" } as any, {});
  await settle();
  eq("a brand-new contact from the sync is a creation: nothing emitted", (await rows()).length, 0);

  console.log("\nnever blocks the caller");
  const t0 = Date.now();
  nextStatus = 202;
  emit.emitNotificationEvent({ type: "contact.assigned", contactId: 990312, before: {}, after: { assignedTo: "sandra@tfc.health" } });
  ok("emitNotificationEvent returns synchronously", Date.now() - t0 < 5);
  emit.emitNotificationEvent({ type: "contact.assigned", contactId: 990312, before: {}, after: { assignedTo: "sandra@tfc.health" } });
  await pool.query(`ALTER TABLE notifications RENAME TO notifications_gone`);
  emit.emitNotificationEvent({ type: "contact.assigned", contactId: 990311, before: {}, after: { assignedTo: "chantel@tfc.health" } });
  await sleep(200);
  await pool.query(`ALTER TABLE notifications_gone RENAME TO notifications`);
  ok("a broken queue is logged, not thrown (process still alive)", true);

  await pool.query(`DELETE FROM sync_contacts WHERE contact_id = ANY($1)`, [[...IDS, 990315]]);
  await closePool();
  hook.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
