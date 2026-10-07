/**
 * CRM side of the patient-portal step: service-type mapping, VACCN, dry run,
 * the agent's verdict parsed and stored, the scheduling card's state.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-portal-crm.ts
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55435/tfc_portaltest npx tsx … (adds the DB part)
 *
 * Every date is synthetic; no patient values.
 */
import { portalServiceType } from "../shared/portal-service-type";
import { isVaccnPayer } from "../shared/notification-rules";
import { portalDryRun, portalOutcomeFromMeta, portalStateOf } from "../server/therapy-notes/portal";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const AT = new Date("2026-10-07T12:00:00Z");
const dobAged = (age: number) => `${2026 - age}-01-15`;   // birthday already passed this year

console.log("\n[1] Service type -> table row");
eq("My Child, 10 -> Minor", portalServiceType("My Child", dobAged(10), AT), { serviceType: "Minor", skip: null });
eq("My Child, 13 -> Minor (boundary)", portalServiceType("My Child", dobAged(13), AT).serviceType, "Minor");
eq("My Child, 14 -> Adolescent (boundary)", portalServiceType("My Child", dobAged(14), AT).serviceType, "Adolescent");
eq("My Child, 17 -> Adolescent", portalServiceType("My Child", dobAged(17), AT).serviceType, "Adolescent");
eq("My Child, 18 -> skip child_age_unresolved", portalServiceType("My Child", dobAged(18), AT), { serviceType: null, skip: "child_age_unresolved" });
eq("My Child, no DOB -> skip child_age_unresolved", portalServiceType("My Child", null, AT).skip, "child_age_unresolved");
eq("My-Child (stray spelling) -> banded like My Child", portalServiceType("My-Child", dobAged(15), AT).serviceType, "Adolescent");
eq("Myself, adult -> Individual", portalServiceType("Myself", dobAged(30), AT), { serviceType: "Individual", skip: null });
eq("Myself, 16 -> skip self_requested_under_18", portalServiceType("Myself", dobAged(16), AT), { serviceType: null, skip: "self_requested_under_18" });
eq("Myself, 18 -> Individual (boundary)", portalServiceType("Myself", dobAged(18), AT).serviceType, "Individual");
eq("Myself, no DOB -> Individual", portalServiceType("Myself", "", AT).serviceType, "Individual");
eq("My Partner & Myself -> its row", portalServiceType("My Partner & Myself", dobAged(40), AT).serviceType, "My Partner & Myself");
eq("My Family -> its row", portalServiceType("My Family", dobAged(9), AT).serviceType, "My Family");
eq("My family (case) -> My Family", portalServiceType("My family", dobAged(40), AT).serviceType, "My Family");
eq("Other -> skip service_type_unmapped", portalServiceType("Other", dobAged(40), AT), { serviceType: null, skip: "service_type_unmapped" });
eq("blank -> skip service_type_unmapped", portalServiceType("", dobAged(40), AT).skip, "service_type_unmapped");
eq("legacy value -> skip service_type_unmapped", portalServiceType("Couples", dobAged(40), AT).skip, "service_type_unmapped");

console.log("\n[2] VACCN (the notifications' normaliser)");
ok("VACCN", isVaccnPayer("VACCN"));
ok("VACCN (VA Community Care)", isVaccnPayer("VACCN (VA Community Care)"));
ok("bare VA is not VACCN -> gets the insurance form", !isVaccnPayer("VA"));
ok("ChampVA is not VACCN", !isVaccnPayer("ChampVA"));

console.log("\n[3] Dry run until PORTAL_LIVE=true");
ok("unset -> dry run", portalDryRun({}));
ok("false -> dry run", portalDryRun({ PORTAL_LIVE: "false" }));
ok("anything but true -> dry run", portalDryRun({ PORTAL_LIVE: "yes" }));
ok("true -> live", !portalDryRun({ PORTAL_LIVE: "true" }));
ok("TRUE -> live", !portalDryRun({ PORTAL_LIVE: " TRUE " }));

console.log("\n[4] The agent's verdict");
eq("no portalStatus -> nothing to store", portalOutcomeFromMeta({ documentsUploaded: [] }, "r1"), null);
eq("unknown status -> nothing to store", portalOutcomeFromMeta({ portalStatus: "maybe" }, "r1"), null);
const v = portalOutcomeFromMeta({
  portalStatus: "failed", portalStep: "share_documents", portalReason: "picker_not_found",
  portalDocuments: ["PCP", 7, "  Client History  Form "], portalMissing: ["Client Insurance Form"], welcomeEmail: "sent",
}, "run-9");
eq("failed verdict parsed, junk dropped, whitespace tidied", v, {
  status: "failed", documents: ["PCP", "Client History Form"],
  detail: { step: "share_documents", reason: "picker_not_found", missing: ["Client Insurance Form"], welcomeEmail: "sent", runId: "run-9" },
});
eq("card state from stored columns", portalStateOf({
  portalStatus: "dry_run", portalDocuments: JSON.stringify(["PCP", "DAS"]), portalSentAt: null,
  portalDetail: JSON.stringify({ step: null, reason: null, missing: [], welcomeEmail: "would_send" }),
}), { status: "dry_run", documents: ["PCP", "DAS"], sentAt: null, step: null, reason: null, missing: [], welcomeEmail: "would_send" });
eq("no stored status -> no line on the card", portalStateOf({ portalStatus: null }), null);

async function db() {
  const url = process.env.DATABASE_URL ?? "";
  if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_portaltest/.test(url))) {
    console.log("\n[5] DB part skipped (set DATABASE_URL to the throwaway tfc_portaltest)");
    return;
  }
  console.log("\n[5] Stored on the contact");
  const { getPool, closePool } = await import("../server/db/pool");
  const sync = await import("../server/sync/db");
  const portal = await import("../server/therapy-notes/portal");
  await sync.initSyncTables();
  await portal.initPortalColumns();
  await portal.initPortalColumns(); // idempotent
  const pool = getPool();
  await pool.query(`DELETE FROM sync_contacts WHERE contact_id = 990601`);
  await pool.query(`INSERT INTO sync_contacts (contact_id, name, status_code) VALUES (990601, 'ZZTEST Portal', 202)`);
  await portal.storePortalOutcome(990601, portalOutcomeFromMeta({ portalStatus: "dry_run", portalDocuments: ["PCP"], welcomeEmail: "would_send" }, "r1")!);
  let c = await sync.getSyncContactById(990601);
  eq("dry run stored, nothing marked sent", [c?.portalStatus, c?.portalSentAt], ["dry_run", null]);
  await portal.storePortalOutcome(990601, portalOutcomeFromMeta({ portalStatus: "done", portalDocuments: ["PCP", "DAS"], welcomeEmail: "sent" }, "r2")!);
  c = await sync.getSyncContactById(990601);
  ok("done stores portal_sent_at", !!c?.portalSentAt);
  eq("…and the documents", portal.portalStateOf(c!)?.documents, ["PCP", "DAS"]);
  await pool.query(`DELETE FROM sync_contacts WHERE contact_id = 990601`);
  await closePool();
}

db().then(() => {
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
}).catch((e) => { console.error(e); process.exit(1); });
