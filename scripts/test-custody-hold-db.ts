/**
 * Custody document status and the manual account hold, against a real
 * database: the values persist, reach the waitlist payload, write the activity
 * timeline with the reason and the person, stay independent of each other, and
 * survive an n8n sync.
 *
 * Writes rows. Run ONLY against a throwaway local Postgres, never production:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55434/tfc_holdtest \
 *     npx tsx scripts/test-custody-hold-db.ts
 *
 * NO PHI: ZZTEST contacts, example.invalid actors.
 */

const url = process.env.DATABASE_URL ?? "";
if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_holdtest/.test(url))) {
  console.error(
    "REFUSING TO RUN. This script writes contacts and activity rows and must only point at\n" +
      "the throwaway local database (127.0.0.1/localhost, tfc_holdtest).",
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

async function main() {
  const { getPool } = await import("../server/db/pool");
  const db = await import("../server/sync/db");
  const activity = await import("../server/activity/db");
  const hold = await import("../server/contacts/account-hold");

  // The app's own boot-time init: must be a no-op on a migrated database.
  await db.initSyncTables();
  await activity.initActivityTable();

  const pool = getPool();
  const IDS = [990201, 990202, 990203];
  await pool.query(`DELETE FROM sync_contacts WHERE contact_id = ANY($1)`, [IDS]);
  await pool.query(`DELETE FROM activity_log WHERE entity_id = ANY($1)`, [IDS.map(String)]);
  for (const [i, id] of IDS.entries()) {
    await pool.query(
      `INSERT INTO sync_contacts (contact_id, name, status_code, insurance_payer, insurance_id)
       VALUES ($1, $2, 100, $3, $4)`,
      [id, `ZZTEST Hold ${i + 1}`, i === 2 ? "VA Community Care" : "ZZTEST Plan", i === 2 ? "" : "ZZ-1"],
    );
  }
  const [A, B, VA] = IDS;
  const STAFF = "zztest.sandra@example.invalid";
  const STAFF2 = "zztest.other@example.invalid";
  const byId = (id: number) => db.getSyncContactById(id);
  const boardRow = async (id: number) => (await db.getAllSyncContacts()).find((c) => c.contactId === id);
  const acts = async (id: number) => (await activity.getActivityForContact(id, 50));

  // -------------------------------------------------------------------------
  console.log("\n[1] Defaults: nobody is on hold until a person says so");
  for (const id of IDS) {
    const c = await byId(id);
    ok(`${id}: holdActive is boolean false`, c?.holdActive === false);
    ok(`${id}: no reason, no note, no custody status`, c?.holdReason === null && c?.holdNote === null && c?.custodyDocStatus === null);
  }
  ok("the VA client with an empty insurance ID is not on hold", (await boardRow(VA))?.holdActive === false);

  // -------------------------------------------------------------------------
  console.log("\n[2] Custody document status persists and is independent of the hold");
  const up = await db.updateContactIntakeFields(A, { custodyDocStatus: "Requested" });
  eq("the PATCH path reports the field changed", up.updated, ["custodyDocStatus"]);
  eq("stored on the contact", (await byId(A))?.custodyDocStatus, "Requested");
  eq("carried on the waitlist payload", (await boardRow(A))?.custodyDocStatus, "Requested");
  ok("Requested does not put the account on hold", (await byId(A))?.holdActive === false);
  eq("no hold activity written by a custody change",
    (await acts(A)).filter((a) => a.type.startsWith("contact_hold")).length, 0);

  // -------------------------------------------------------------------------
  console.log("\n[3] Put on hold: stored, on the board, on the timeline with reason and user");
  let r = await hold.putContactOnHold(A, { reason: "Missing custody documents" }, STAFF);
  eq("200", r.status, 200);
  let c = await byId(A);
  ok("holdActive true, reason stored", c?.holdActive === true && c?.holdReason === "Missing custody documents");
  eq("a non-Other reason stores no note", c?.holdNote, null);
  const row = await boardRow(A);
  ok("the waitlist payload carries holdActive + reason", row?.holdActive === true && row?.holdReason === "Missing custody documents");
  ok("the waitlist payload does NOT carry the note", !("holdNote" in (row ?? {})));
  let log = await acts(A);
  const setEntry = log.find((a) => a.type === "contact_hold_set");
  ok("a contact_hold_set entry exists", !!setEntry);
  eq("  by the person who set it", setEntry?.actorEmail, STAFF);
  eq("  with the reason", setEntry?.metadata.reason, "Missing custody documents");
  eq("  summary reads as a sentence", setEntry?.summary, "Put ZZTEST Hold 1 on hold: Missing custody documents");
  eq("custody status untouched by the hold", c?.custodyDocStatus, "Requested");

  // -------------------------------------------------------------------------
  console.log("\n[4] Refusals change nothing and log nothing");
  const before = (await acts(A)).length;
  for (const bad of [{}, { reason: "" }, { reason: "Other" }, { reason: "missing custody documents" }]) {
    r = await hold.putContactOnHold(A, bad, STAFF);
    eq(`invalid reason ${JSON.stringify(bad)} -> 400`, r.status, 400);
  }
  r = await hold.putContactOnHold(A, { reason: "Other (see notes)", note: "x".repeat(501) }, STAFF);
  eq("an over-long note -> 400", r.status, 400);
  eq("still the original reason", (await byId(A))?.holdReason, "Missing custody documents");
  eq("no activity written by a refusal", (await acts(A)).length, before);
  eq("unknown contact -> 404", (await hold.putContactOnHold(999999, { reason: "Missing VA referral" }, STAFF)).status, 404);
  eq("unknown contact clear -> 404", (await hold.takeContactOffHold(999999, STAFF)).status, 404);

  // -------------------------------------------------------------------------
  console.log("\n[5] Other keeps its note; changing the reason drops it and is logged as a change");
  r = await hold.putContactOnHold(B, { reason: "Other (see notes)", note: "  ZZTEST waiting on a signed form  " }, STAFF);
  c = await byId(B);
  eq("Other stores the trimmed note", c?.holdNote, "ZZTEST waiting on a signed form");
  ok("the note is not in the activity entry",
    !JSON.stringify((await acts(B)).map((a) => a.metadata)).includes("signed form"));
  r = await hold.putContactOnHold(B, { reason: "Missing VA referral", note: "ignored for this reason" }, STAFF2);
  c = await byId(B);
  ok("new reason stored, note dropped", c?.holdReason === "Missing VA referral" && c?.holdNote === null);
  eq("logged as a reason change",
    (await acts(B)).find((a) => a.type === "contact_hold_set" && a.actorEmail === STAFF2)?.summary,
    "Changed hold reason for ZZTEST Hold 2: Other (see notes) → Missing VA referral");

  // -------------------------------------------------------------------------
  console.log("\n[6] Custody docs Received then clear the hold (Sandra's week)");
  await db.updateContactIntakeFields(A, { custodyDocStatus: "Received" });
  ok("Received does not clear the hold by itself", (await byId(A))?.holdActive === true);
  r = await hold.takeContactOffHold(A, STAFF2);
  eq("clear -> 200", r.status, 200);
  c = await byId(A);
  ok("off hold, reason and note cleared", c?.holdActive === false && c?.holdReason === null && c?.holdNote === null);
  eq("custody status stays Received", c?.custodyDocStatus, "Received");
  ok("the board row loses the hold", (await boardRow(A))?.holdActive === false);
  log = await acts(A);
  const clr = log.find((a) => a.type === "contact_hold_cleared");
  eq("  cleared by the person who cleared it", clr?.actorEmail, STAFF2);
  eq("  with the reason it had", clr?.metadata.reason, "Missing custody documents");
  eq("  summary", clr?.summary, "Cleared hold on ZZTEST Hold 1 (was: Missing custody documents)");
  ok("the timeline has both, newest first",
    log.findIndex((a) => a.type === "contact_hold_cleared") < log.findIndex((a) => a.type === "contact_hold_set"));
  const n = (await acts(A)).length;
  await hold.takeContactOffHold(A, STAFF2);
  eq("clearing a contact not on hold logs nothing", (await acts(A)).length, n);

  // -------------------------------------------------------------------------
  console.log("\n[7] An n8n sync never touches the four columns");
  await hold.putContactOnHold(VA, { reason: "Missing insurance ID" }, STAFF);
  await db.updateContactIntakeFields(VA, { custodyDocStatus: "Not needed" });
  await db.upsertSingleContact({
    contactId: VA, name: "ZZTEST Hold 3 (renamed by sync)", statusCode: 100,
    custodyDocStatus: null, holdActive: false, holdReason: null, hold_active: false, custody_doc_status: null,
  } as any);
  c = await byId(VA);
  eq("the sync did write its own column", c?.name, "ZZTEST Hold 3 (renamed by sync)");
  ok("hold survived the sync", c?.holdActive === true && c?.holdReason === "Missing insurance ID");
  eq("custody status survived the sync", c?.custodyDocStatus, "Not needed");

  // Tidy up the throwaway rows.
  await pool.query(`DELETE FROM sync_contacts WHERE contact_id = ANY($1)`, [IDS]);
  await pool.query(`DELETE FROM activity_log WHERE entity_id = ANY($1)`, [IDS.map(String)]);
  await pool.end();

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
