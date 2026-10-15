/**
 * Teams notifications — rules, message text, the PHI backstop, the per-person
 * decisions (mute, kill switch, self, no webhook) and the delivery worker's
 * retry and failure path. No database, no network.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-notifications.ts
 *
 * NO PHI: ZZTEST names, synthetic numbers.
 */
import { readFileSync } from "fs";
import {
  NOTIFICATION_RULES,
  evaluateNotificationRules,
  isVaccnPayer,
  notificationRecipients,
  type NotificationContact,
  type NotificationContext,
} from "../shared/notification-rules";
import {
  buildNotificationText,
  containsPhiPattern,
  link,
  linkFormat,
  testNotificationText,
} from "../server/notifications/messages";
import { dedupeKeyFor, planNotifications, processNotificationEvent } from "../server/notifications/emit";
import { drainOnce, notificationsEnabled, retryDelayMs, type DeliveryStore } from "../server/notifications/worker";
import { MAX_ATTEMPTS, type NotificationRow } from "../server/notifications/db";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const SANDRA = "sandra@tfc.health", CHANTEL = "chantel@tfc.health", LANE = "lsego@tfc.health";
const NONA = "nbockius@tfc.health", ERICA = "ebenavidez@tfc.health", VICTORIA = "victoria@tfc.health";
const AMAYA = "amayac@tfc.health";
const STAFF = [SANDRA, CHANTEL, LANE, NONA, ERICA, VICTORIA, AMAYA];

function contact(over: Partial<NotificationContact> = {}): NotificationContact {
  return { contactId: 990001, name: "ZZTEST Alpha", statusCode: 100, assignedTo: null, insurancePayer: "ZZTEST Plan", ...over };
}
const statusCtx = (from: number | null, to: number, c: Partial<NotificationContact> = {}, actor = "zztest.actor@example.invalid"): NotificationContext => ({
  type: "contact.status_changed", actor, contact: contact({ statusCode: to, ...c }),
  before: { statusCode: from }, after: { statusCode: to },
});
const assignCtx = (from: string | null, to: string | null, actor = "zztest.actor@example.invalid"): NotificationContext => ({
  type: "contact.assigned", actor, contact: contact({ assignedTo: to }),
  before: { assignedTo: from }, after: { assignedTo: to },
});
const who = (ctx: NotificationContext) => evaluateNotificationRules(ctx).map((m) => m.recipient).sort();

async function main() {
  // -------------------------------------------------------------------------
  console.log("\nrules table");
  eq("one rule per line of the client's list (18) + five note rules", NOTIFICATION_RULES.length, 23);
  eq("rule ids are unique", new Set(NOTIFICATION_RULES.map((r) => r.id)).size, NOTIFICATION_RULES.length);
  eq("recipients are the seven named staff", notificationRecipients(), [...STAFF].sort());

  // -------------------------------------------------------------------------
  console.log("\ncontact.assigned");
  for (const s of STAFF) eq(`assigned to ${s} → only ${s}`, who(assignCtx(null, s)), [s]);
  eq("assigned to someone with no rule → nobody", who(assignCtx(null, "zztest.other@tfc.health")), []);
  eq("unassigned → nobody", who(assignCtx(SANDRA, null)), []);
  eq("re-assigned to the same person → nobody", who(assignCtx(SANDRA, SANDRA)), []);
  eq("reassigned Sandra → Chantel tells Chantel only", who(assignCtx(SANDRA, CHANTEL)), [CHANTEL]);
  eq("email case/whitespace is ignored", who(assignCtx(null, "  LSego@TFC.health ")), [LANE]);

  // -------------------------------------------------------------------------
  console.log("\ncontact.status_changed");
  eq("→300 tells Sandra (any contact)", who(statusCtx(200, 300)), [SANDRA]);
  eq("→200 tells Lane (any contact)", who(statusCtx(100, 200)), [LANE]);
  eq("→202 unassigned, not VACCN → nobody", who(statusCtx(200, 202)), []);
  eq("→202 assigned to Nona → Nona only (not Lane)", who(statusCtx(200, 202, { assignedTo: NONA })), [NONA]);
  eq("→202 assigned to Lane → Lane only (not Nona)", who(statusCtx(200, 202, { assignedTo: LANE })), [LANE]);
  for (const s of [ERICA, VICTORIA, AMAYA]) eq(`→202 assigned to ${s} → ${s}`, who(statusCtx(200, 202, { assignedTo: s })), [s]);
  eq("→202 assigned to Sandra → nobody (Sandra has no 202 rule)", who(statusCtx(200, 202, { assignedTo: SANDRA })), []);
  eq("→202 assigned to Chantel → nobody", who(statusCtx(200, 202, { assignedTo: CHANTEL })), []);
  eq("→202 VACCN unassigned → Lane", who(statusCtx(200, 202, { insurancePayer: "VACCN" })), [LANE]);
  eq("→202 VACCN assigned to Nona → Nona AND Lane", who(statusCtx(200, 202, { assignedTo: NONA, insurancePayer: "VACCN (VA Community Care)" })), [LANE, NONA].sort());
  const laneBoth = evaluateNotificationRules(statusCtx(200, 202, { assignedTo: LANE, insurancePayer: "VACCN" }));
  eq("→202 VACCN assigned to Lane → ONE message, both rules recorded", laneBoth, [{ recipient: LANE, ruleIds: ["lane.assigned_202", "lane.vaccn_202"] }]);
  eq("→200 VACCN → Lane via the 200 rule only", evaluateNotificationRules(statusCtx(100, 200, { insurancePayer: "VACCN" })), [{ recipient: LANE, ruleIds: ["lane.status_200"] }]);
  eq("→201 (neighbour of 200/202) → nobody", who(statusCtx(200, 201, { assignedTo: NONA, insurancePayer: "VACCN" })), []);
  eq("→205 (Initial Appt Completed) → nobody", who(statusCtx(202, 205, { assignedTo: LANE })), []);
  eq("→206 → nobody", who(statusCtx(202, 206, { assignedTo: LANE })), []);
  eq("re-save 202 → 202 fires nothing", who(statusCtx(202, 202, { assignedTo: NONA, insurancePayer: "VACCN" })), []);
  eq("re-save 200 → 200 fires nothing", who(statusCtx(200, 200)), []);
  eq("re-save 300 → 300 fires nothing", who(statusCtx(300, 300)), []);
  eq("NULL → 200 (sync fill) is a change", who(statusCtx(null, 200)), [LANE]);

  console.log("\nVACCN normalisation");
  ok("VACCN", isVaccnPayer("VACCN"));
  ok("VACCN (VA Community Care)", isVaccnPayer("VACCN (VA Community Care)"));
  ok("va community care", isVaccnPayer("va community care"));
  ok("ChampVA is not VACCN", !isVaccnPayer("ChampVA"));
  ok("bare VA is not VACCN (ambiguous)", !isVaccnPayer("VA"));
  ok("empty is not VACCN", !isVaccnPayer(null));

  // -------------------------------------------------------------------------
  console.log("\nsubmissions");
  const survey: NotificationContext = { type: "survey.submitted", actor: "system", contact: null, before: {}, after: {}, submissionId: 41 };
  eq("survey → Lane only", who(survey), [LANE]);
  eq("RFS → Erica only", who({ ...survey, type: "rfs.submitted" }), [ERICA]);
  eq("provider availability → Sandra only", who({ ...survey, type: "provider_availability.submitted" }), [SANDRA]);

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  console.log("\nnote added (2026-10-15)");
  const noteCtx = (assignedTo: string | null, actor = "zztest.actor@example.invalid"): NotificationContext => ({
    type: "contact.note_added", actor, contact: contact({ assignedTo }), before: {}, after: {},
  });
  for (const r of [LANE, NONA, ERICA, VICTORIA, AMAYA]) eq(`note on a contact assigned to ${r} → ${r} only`, who(noteCtx(r)), [r]);
  eq("note on Sandra's contact → nobody (not on the list)", who(noteCtx(SANDRA)), []);
  eq("note on Chantel's contact → nobody (not on the list)", who(noteCtx(CHANTEL)), []);
  eq("note on an unassigned contact → nobody", who(noteCtx(null)), []);
  eq("note on a contact assigned to someone else → nobody", who(noteCtx("zz.other@example.invalid")), []);
  eq("assignee match is case-insensitive", who(noteCtx("LSego@TFC.health")), [LANE]);

  // -------------------------------------------------------------------------
  console.log("\nmessages: the client's templates, exactly");
  process.env.APP_URL = "https://crm.example.invalid/";
  const zed = (over: Partial<NotificationContact> = {}) => contact({ name: "Zed  Quux", contactId: 990123, ...over });
  const md = (label: string, id: number) => `[${label}](https://crm.example.invalid/contact/${id})`;
  const by = { actorName: "Zz Staffer" };
  eq("assigned", buildNotificationText({ ...assignCtx(null, NONA), contact: zed({ assignedTo: NONA }) }, {}, ["nona.assigned"], "markdown"),
    `CRM: ${md("Zed Quux", 990123)} has been assigned to you`);
  eq("provider availability (Sandra): provider name linked to the submission",
    buildNotificationText({ ...survey, type: "provider_availability.submitted", submissionId: 77 }, { providerName: "Zz Provider", acceptingClients: 3 }, ["sandra.provider_availability"], "markdown"),
    "CRM: [Zz Provider](https://crm.example.invalid/submissions?submission=77) has submitted a request for clients");
  eq("status 300 (Sandra)", buildNotificationText(statusCtx(200, 300, { name: "Zed Quux", contactId: 990123 }), by, ["sandra.status_300"], "markdown"),
    `CRM: ${md("Zed Quux", 990123)} has been submitted for review`);
  eq("status 202, assigned to the recipient", buildNotificationText(statusCtx(200, 202, { name: "Zed Quux", contactId: 990123 }), by, ["nona.assigned_202"], "markdown"),
    `CRM: ${md("Zed Quux", 990123)} has been scheduled by Zz Staffer`);
  eq("status 202, VACCN (Lane)", buildNotificationText(statusCtx(200, 202, { name: "Zed Quux", contactId: 990123, insurancePayer: "VACCN" }), by, ["lane.vaccn_202"], "markdown"),
    `CRM: VACCN Client ${md("Zed Quux", 990123)} has been scheduled by Zz Staffer`);
  eq("status 202, VACCN AND assigned to Lane → the VACCN wording", buildNotificationText(statusCtx(200, 202, { name: "Zed Quux", contactId: 990123, insurancePayer: "VACCN" }), by, ["lane.assigned_202", "lane.vaccn_202"], "markdown"),
    `CRM: VACCN Client ${md("Zed Quux", 990123)} has been scheduled by Zz Staffer`);
  eq("status 200 (Lane)", buildNotificationText(statusCtx(100, 200, { name: "Zed Quux", contactId: 990123 }), by, ["lane.status_200"], "markdown"),
    `CRM: ${md("Zed Quux", 990123)} has been moved to ready to schedule`);
  eq("survey (Lane): name on survey + provider label, no link",
    buildNotificationText(survey, { surveyName: "Zed  Quux", providerLabel: "Zz Provider (LL)" }, ["lane.survey"], "markdown"),
    "CRM: Zed Quux has submitted survey for Zz Provider (LL)");
  ok("survey text carries no link", !/https?:|\]\(/.test(buildNotificationText(survey, { surveyName: "Zed Quux", providerLabel: "Zz P" }, [], "markdown")));
  eq("new RFS (Erica)", buildNotificationText({ ...survey, type: "rfs.submitted", submissionId: 78, contact: zed() }, { source: "website form" }, ["erica.rfs"], "markdown"),
    `CRM: A new RFS has been submitted for ${md("Zed Quux", 990123)}`);
  eq("note added", buildNotificationText({ ...noteCtx(LANE), contact: zed({ assignedTo: LANE }) }, by, ["lane.note"], "markdown"),
    `CRM: A new note has been added to ${md("Zed Quux", 990123)} by Zz Staffer`);
  eq("[user] unknown (a sync-made change) → 'a staff member'", buildNotificationText(statusCtx(200, 202, { name: "Zed Quux", contactId: 990123 }), {}, ["nona.assigned_202"], "markdown"),
    `CRM: ${md("Zed Quux", 990123)} has been scheduled by a staff member`);

  console.log("\nlinks: markdown by default, HTML by setting");
  eq("default format is markdown", linkFormat({}), "markdown");
  eq("NOTIFY_LINK_FORMAT=html", linkFormat({ NOTIFY_LINK_FORMAT: "HTML" }), "html");
  eq("markdown link", link("Zed Quux", "https://crm.example.invalid/contact/9", "markdown"), "[Zed Quux](https://crm.example.invalid/contact/9)");
  eq("markdown escapes brackets in a name", link("Zed [Q]", "https://x.invalid/c/9", "markdown"), "[Zed \\[Q\\]](https://x.invalid/c/9)");
  eq("HTML link", link("Zed Quux", "https://crm.example.invalid/contact/9", "html"), '<a href="https://crm.example.invalid/contact/9">Zed Quux</a>');
  eq("HTML escapes a name", link("Zed & <Q>", "https://x.invalid/c/9", "html"), '<a href="https://x.invalid/c/9">Zed &amp; &lt;Q&gt;</a>');
  eq("assigned, HTML", buildNotificationText({ ...assignCtx(null, NONA), contact: zed({ assignedTo: NONA }) }, {}, ["nona.assigned"], "html"),
    'CRM: <a href="https://crm.example.invalid/contact/990123">Zed Quux</a> has been assigned to you');
  eq("note added, HTML escapes [user] too", buildNotificationText({ ...noteCtx(LANE), contact: zed({ assignedTo: LANE }) }, { actorName: "Zz & Co" }, ["lane.note"], "html"),
    'CRM: A new note has been added to <a href="https://crm.example.invalid/contact/990123">Zed Quux</a> by Zz &amp; Co');
  ok("the test message carries one link (markdown)", /\[TFC CRM\]\(https:\/\/crm\.example\.invalid\/\)/.test(testNotificationText("markdown")));
  ok("the test message carries one link (HTML)", /<a href="https:\/\/crm\.example\.invalid\/">TFC CRM<\/a>/.test(testNotificationText("html")));

  const surveyRoutes = readFileSync("server/survey/routes.ts", "utf8");
  const helper = surveyRoutes.slice(surveyRoutes.indexOf("function surveyNotificationExtras"), surveyRoutes.indexOf("function surveyNotificationExtras") + 600);
  ok("survey emit passes the typed name and provider label (surveyNotificationExtras)",
    /extras: surveyNotificationExtras\(sub\)/.test(surveyRoutes) && /doc\.client\?\.name/.test(helper) && /doc\.answers\?\.therapist/.test(helper));
  ok("…and nothing else from the survey", !/dateOfBirth|phone|email|comments|overallRating/.test(helper));
  const subsPage = readFileSync("client/src/pages/submissions.tsx", "utf8");
  ok("Submissions opens /submissions?submission=<id> (the provider-availability link)",
    /new URLSearchParams\(window\.location\.search\)\.get\("submission"\)/.test(subsPage) && /setSelectedSubmission\(hit\)/.test(subsPage));

  console.log("\nPHI: name and link only; anything else is withheld");
  const clean = [
    buildNotificationText({ ...assignCtx(null, LANE), contact: zed() }, {}, [], "markdown"),
    buildNotificationText({ ...noteCtx(LANE), contact: zed() }, by, [], "html"),
    buildNotificationText(statusCtx(200, 202, { name: "Zed Quux", contactId: 9_001_234 }), by, [], "markdown"),
  ];
  for (const t of clean) ok(`a clean text passes: "${t.slice(0, 40)}…"`, !containsPhiPattern(t), t);
  const nasty = contact({ name: "Zed Quux 01/02/2010 (505) 555-0100 zz@example.invalid", contactId: 990777, insurancePayer: "VACCN" });
  for (const t of [
    buildNotificationText({ ...statusCtx(200, 202), contact: nasty }, by, ["nona.assigned_202"], "markdown"),
    buildNotificationText({ ...assignCtx(null, LANE), contact: nasty }, {}, [], "html"),
    buildNotificationText(survey, { surveyName: "Zed 505-555-0100", providerLabel: "P" }, [], "markdown"),
  ]) ok(`a name field carrying a DOB/phone/email is caught: "${t.slice(0, 30)}…"`, containsPhiPattern(t), t);
  const nastyNote = await planNotifications({ ...noteCtx(LANE), contact: { ...nasty, assignedTo: LANE } }, by, {
    enabled: true, hasUrl: true, isMuted: () => false });
  eq("…and that recipient's row is withheld, not sent", nastyNote.map((r) => [r.status, r.text]), [["blocked", "[withheld: text failed the PHI check]"]]);
  ok("no template reads DOB, phone, insurance or note text (source)", (() => {
    const src = readFileSync("server/notifications/messages.ts", "utf8").split("export function containsPhiPattern")[0];
    return !/dob|dateOfBirth|phone|insurancePayer|note\.|preview|content/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""));
  })());

  // -------------------------------------------------------------------------
  console.log("\nper-recipient decisions");
  const muted = new Set<string>();
  const opts = (o: Partial<{ enabled: boolean; hasUrl: boolean }> = {}) => ({
    enabled: o.enabled ?? true, hasUrl: o.hasUrl ?? true, isMuted: (e: string) => muted.has(e),
  });
  const vaccnNona = statusCtx(200, 202, { assignedTo: NONA, insurancePayer: "VACCN" });
  eq("live: both queued", (await planNotifications(vaccnNona, {}, opts())).map((r) => [r.recipient, r.status]),
    [[LANE, "pending"], [NONA, "pending"]]);
  muted.add(NONA);
  eq("mute: Nona muted, Lane still queued", (await planNotifications(vaccnNona, {}, opts())).map((r) => [r.recipient, r.status]),
    [[LANE, "pending"], [NONA, "muted"]]);
  muted.clear();
  eq("kill switch: nothing queued", (await planNotifications(vaccnNona, {}, opts({ enabled: false }))).map((r) => r.status),
    ["disabled", "disabled"]);
  eq("no webhook: dropped", (await planNotifications(vaccnNona, {}, opts({ hasUrl: false }))).map((r) => r.status),
    ["no_url", "no_url"]);
  eq("per-recipient text: Lane gets the VACCN wording, Nona the plain one",
    (await planNotifications(vaccnNona, { actorName: "Zz Staffer" }, opts())).map((r) => [r.recipient, r.text.startsWith("CRM: VACCN Client ")]),
    [[LANE, true], [NONA, false]]);
  eq("note: the author is never told about their own note",
    (await planNotifications({ type: "contact.note_added", actor: LANE, contact: contact({ assignedTo: LANE }), before: {}, after: {} }, {}, opts())).map((r) => [r.recipient, r.status]),
    [[LANE, "self"]]);
  eq("note: dedupe key per contact", dedupeKeyFor({ type: "contact.note_added", actor: null, contact: contact(), before: {}, after: {} }),
    "contact.note_added|contact:990001");
  eq("self: Nona moved her own contact → not told; Lane still told",
    (await planNotifications(statusCtx(200, 202, { assignedTo: NONA, insurancePayer: "VACCN" }, NONA), {}, opts())).map((r) => [r.recipient, r.status]),
    [[LANE, "pending"], [NONA, "self"]]);
  const blocked = await planNotifications({ ...vaccnNona, type: "provider_availability.submitted" }, { providerName: "Call 505-555-0100" }, opts());
  eq("PHI backstop: blocked, text withheld", blocked.map((r) => [r.status, r.text]), [["blocked", "[withheld: text failed the PHI check]"]]);

  console.log("\nkill switch env");
  ok("default (unset) is enabled", notificationsEnabled({}));
  ok("true is enabled", notificationsEnabled({ NOTIFICATIONS_ENABLED: "true" }));
  for (const v of ["false", "FALSE", "0", "off", "no"]) ok(`${v} disables`, !notificationsEnabled({ NOTIFICATIONS_ENABLED: v }));

  console.log("\ndedupe key");
  ok("same contact, different target status → different keys", dedupeKeyFor(statusCtx(100, 200)) !== dedupeKeyFor(statusCtx(200, 202)));
  eq("status key", dedupeKeyFor(statusCtx(100, 200)), "contact.status_changed:200|contact:990001");
  eq("provider key uses the provider", dedupeKeyFor({ ...survey, type: "provider_availability.submitted" }, "ZZ@x.invalid"), "provider_availability.submitted|entity:zz@x.invalid");

  console.log("\nprocessNotificationEvent (fake deps)");
  const queued: string[] = [];
  let kicked = 0;
  const res = await processNotificationEvent(
    { type: "contact.status_changed", contactId: 5, before: { statusCode: 100 }, after: { statusCode: 200 }, actor: "zz@example.invalid" },
    {
      loadContact: async (id) => contact({ contactId: id, statusCode: 200 }),
      enqueue: async (row) => { queued.push(`${row.recipient}:${row.status}`); return { id: queued.length, status: row.status }; },
      plan: opts(),
      kick: () => { kicked++; },
    },
  );
  eq("one row for Lane", queued, [`${LANE}:pending`]);
  eq("worker kicked once", kicked, 1);
  eq("result", res.map((r) => r.status), ["pending"]);
  const none = await processNotificationEvent(
    { type: "contact.status_changed", contactId: 5, before: { statusCode: 200 }, after: { statusCode: 200 } },
    { loadContact: async () => contact(), enqueue: async () => { throw new Error("must not enqueue"); }, plan: opts(), kick: () => { throw new Error("must not kick"); } },
  );
  eq("re-save: nothing enqueued, nothing kicked", none, []);

  // -------------------------------------------------------------------------
  console.log("\nworker: retry and failure");
  eq("backoff 30s / 2m / 8m", [1, 2, 3].map(retryDelayMs), [30_000, 120_000, 480_000]);
  eq("max attempts = first try + 3 retries", MAX_ATTEMPTS, 4);

  function row(id: number, attempts = 0): NotificationRow {
    return { id, recipient: "raunek@tfc.health", text: "t", event: "test", dedupeKey: "k", ruleIds: [], contactId: null,
      submissionId: null, status: "sending", attempts, nextAttemptAt: null, lastHttpStatus: null, error: null,
      createdAt: "", sentAt: null };
  }
  function fakeStore(rows: NotificationRow[]) {
    const log: string[] = [];
    const store: DeliveryStore = {
      claimDue: async () => rows.splice(0),
      markSent: async (id, a, h) => { log.push(`sent:${id}:${a}:${h}`); },
      markRetry: async (id, a, d, h, e) => { log.push(`retry:${id}:${a}:${d}:${h}:${e}`); },
      markFailed: async (id, a, h, e) => { log.push(`failed:${id}:${a}:${h}:${e}`); },
    };
    return { store, log };
  }
  const reply = (status: number) => (async () => new Response("", { status })) as unknown as typeof fetch;
  const bodies: string[] = [];
  const capture = (async (_u: unknown, init: RequestInit) => { bodies.push(String(init.body)); return new Response("", { status: 202 }); }) as unknown as typeof fetch;

  let f = fakeStore([row(1)]);
  await drainOnce({ store: f.store, fetchFn: capture, url: "https://hook.example.invalid", enabled: true });
  eq("202 → sent on first attempt", f.log, ["sent:1:1:202"]);
  eq("payload is exactly {recipient, text}", JSON.parse(bodies[0]), { recipient: "raunek@tfc.health", text: "t" });

  f = fakeStore([row(2)]);
  await drainOnce({ store: f.store, fetchFn: reply(500), url: "https://hook.example.invalid", enabled: true });
  eq("500 on try 1 → retry in 30s", f.log, ["retry:2:1:30000:500:HTTP 500"]);
  f = fakeStore([row(3, 2)]);
  await drainOnce({ store: f.store, fetchFn: reply(429), url: "https://hook.example.invalid", enabled: true });
  eq("429 on try 3 → retry in 8m", f.log, ["retry:3:3:480000:429:HTTP 429"]);
  f = fakeStore([row(4, 3)]);
  await drainOnce({ store: f.store, fetchFn: reply(500), url: "https://hook.example.invalid", enabled: true });
  eq("500 on try 4 → failed", f.log, ["failed:4:4:500:HTTP 500"]);
  f = fakeStore([row(5)]);
  await drainOnce({ store: f.store, fetchFn: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch, url: "https://hook.example.invalid", enabled: true });
  eq("network error → retry, reason recorded", f.log, ["retry:5:1:30000:null:ECONNRESET"]);
  f = fakeStore([row(6)]);
  await drainOnce({ store: f.store, fetchFn: (() => new Promise(() => {})) as unknown as typeof fetch, url: "https://hook.example.invalid", enabled: true, timeoutMs: 50 });
  eq("hang → timeout → retry", f.log.map((l) => l.split(":").slice(0, 2).join(":")), ["retry:6"]);
  f = fakeStore([row(7)]);
  await drainOnce({ store: f.store, fetchFn: reply(200), url: "https://hook.example.invalid", enabled: true });
  eq("200 counts as delivered (no double send)", f.log, ["sent:7:1:200"]);
  f = fakeStore([row(8)]);
  await drainOnce({ store: f.store, fetchFn: reply(202), url: null, enabled: true });
  eq("webhook unset at send time → failed, no crash", f.log, ["failed:8:1:null:TEAMS_NOTIFY_URL unset"]);
  f = fakeStore([row(9)]);
  const out = await drainOnce({ store: f.store, fetchFn: reply(202), url: "https://hook.example.invalid", enabled: false });
  eq("kill switch: worker claims nothing", [out, f.log], [[], []]);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
