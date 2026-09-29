/**
 * Contact documents → TherapyNotes: what an Add to Schedule run sends, what the
 * agent may fetch, and what gets stamped "In TN" — `npm run test:tn-documents`.
 *
 * Writes rows. Run ONLY against the throwaway local database:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55434/tfc_docstest \
 *     npx tsx --tsconfig tsconfig.test.json scripts/test-tn-documents.ts
 *
 * NO PHI: ZZTEST contacts, generated placeholder files, invented names.
 */

const url = process.env.DATABASE_URL ?? "";
if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_docstest/.test(url))) {
  console.error(
    "REFUSING TO RUN. This script writes contacts and documents and must only point at\n" +
      "the throwaway local database (127.0.0.1/localhost, tfc_docstest).",
  );
  process.exit(2);
}
process.env.AZURE_AD_CLIENT_ID = "zztest-auth-enabled"; // the real auth gate, not the dev bypass
process.env.TN_API_KEY = "zztest-agent-key";

import { readFileSync } from "fs";
import { join } from "path";
import type { AddressInfo } from "net";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const pdf = (label: string) => Buffer.from(`%PDF-1.4\n% ZZTEST placeholder: ${label}\n%%EOF\n`);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function main() {
  const tn = await import("../server/documents/tn");
  const db = await import("../server/documents/db");
  const syncDb = await import("../server/sync/db");
  const activity = await import("../server/activity/db");
  const { getPool } = await import("../server/db/pool");
  const { computeTnRun, tnFailureText } = await import("../client/src/lib/tn-run-state");
  type Doc = import("../shared/contact-documents").ContactDocument;

  // ---------------------------------------------------------------------
  console.log("\n[1] Names: unique on the chart, stable across runs, within 128");
  const mk = (id: number, name: string, at: string, over: Partial<Doc> = {}): Doc => ({
    id, contactId: 1, displayName: name, originalFilename: "f.pdf", mimeType: "application/pdf",
    sizeBytes: 10, source: "staff_upload", uploadedByEmail: "zz@example.invalid", uploadedByName: null,
    uploadedAt: at, tnUploadedAt: null, ...over,
  });
  const a1 = mk(10, "Custody order", "2026-09-20T10:00:00Z");
  const a2 = mk(11, "Custody order", "2026-09-21T10:00:00Z");
  const fax = mk(12, "Fax referral 09/26/2026", "2026-09-26T10:00:00Z", { source: "fax_referral" });
  const va = mk(13, "VA referral", "2026-09-19T10:00:00Z", { mimeType: "image/jpeg" });
  const all = [a1, a2, fax, va];
  eq("first 'Custody order' -> (CRM)", tn.tnDocumentName(a1, all), "Custody order (CRM)");
  eq("second 'Custody order' -> (CRM 2)", tn.tnDocumentName(a2, all), "Custody order (CRM 2)");
  eq("a stamped earlier namesake still counts, so numbering is stable",
    tn.tnDocumentName(a2, [{ ...a1, tnUploadedAt: "2026-09-22T00:00:00Z" }, a2]), "Custody order (CRM 2)");
  const long = mk(14, "x".repeat(200), "2026-09-27T10:00:00Z");
  const longName = tn.tnDocumentName(long, [long]);
  ok("a long name fits TherapyNotes' 128 and keeps its suffix", longName.length <= 128 && longName.endsWith(" (CRM)"));

  // ---------------------------------------------------------------------
  console.log("\n[2] What is sent: unstamped only, fax referral first, then by upload time");
  const list = tn.buildTnDocumentList(all, 900753, "https://crm.example/");
  eq("order", list.map((d) => d.crm_document_id), [12, 13, 10, 11]);
  eq("names", list.map((d) => d.tn_name),
    ["Fax referral 09/26/2026 (CRM)", "VA referral (CRM)", "Custody order (CRM)", "Custody order (CRM 2)"]);
  eq("agent-only fetch URL per document", list[0].url, "https://crm.example/api/internal/contact-document/900753/12");
  eq("type travels", list[1].mime_type, "image/jpeg");
  const afterStamp = tn.buildTnDocumentList(
    all.map((d) => (d.id === 12 || d.id === 10 ? { ...d, tnUploadedAt: "2026-09-28T00:00:00Z" } : d)),
    900753, "https://crm.example");
  eq("stamped documents are not sent again", afterStamp.map((d) => d.crm_document_id), [13, 11]);
  eq("...and the unstamped keep their names", afterStamp.map((d) => d.tn_name), ["VA referral (CRM)", "Custody order (CRM 2)"]);
  eq("nothing unstamped -> nothing sent", tn.buildTnDocumentList(all.map((d) => ({ ...d, tnUploadedAt: "x" })), 1, "https://c").length, 0);

  // ---------------------------------------------------------------------
  console.log("\n[3] What is stamped: only well-formed ids the agent reported");
  eq("ids", tn.documentIdsToStamp({ documentsUploaded: [12, 13] }), [12, 13]);
  eq("junk ignored", tn.documentIdsToStamp({ documentsUploaded: [12, "13", -1, 1.5, null, 12] }), [12]);
  eq("absent -> nothing", tn.documentIdsToStamp({}), []);
  eq("not an array -> nothing", tn.documentIdsToStamp({ documentsUploaded: "12" }), []);

  // ---------------------------------------------------------------------
  console.log("\n[4] Database: stamp, re-run sends only the rest, stamp is scoped and kept");
  const pool = getPool();
  process.env.RUN_MIGRATIONS = "true";
  await syncDb.initSyncTables();
  await activity.initActivityTable();
  for (const f of ["add-language-column.sql", "add-scheduled-appointment-tn-v2.sql", "add-custody-docs-and-hold.sql", "add-contact-documents.sql"]) {
    await pool.query(readFileSync(join(process.cwd(), "migrations", f), "utf8"));
  }
  const stampMigration = readFileSync(join(process.cwd(), "migrations", "add-contact-documents-tn-stamp.sql"), "utf8");
  let migErr = "";
  try { await pool.query(stampMigration); await pool.query(stampMigration); await db.initContactDocumentsTable(); } catch (e) { migErr = String(e); }
  ok("the stamp migration runs twice and the boot init after it", migErr === "", migErr);

  const C1 = 990501, C2 = 990502;
  await pool.query(`DELETE FROM contact_documents WHERE contact_id IN ($1, $2)`, [C1, C2]);
  await pool.query(`DELETE FROM sync_contacts WHERE contact_id IN ($1, $2)`, [C1, C2]);
  await pool.query(`INSERT INTO sync_contacts (contact_id, name, status_code) VALUES ($1, 'ZZTEST Tn One', 200), ($2, 'ZZTEST Tn Two', 200)`, [C1, C2]);
  const ins = (contactId: number, name: string, content: Buffer, mime: "application/pdf" | "image/png", source: "staff_upload" | "fax_referral" = "staff_upload") =>
    db.insertContactDocument({ contactId, displayName: name, originalFilename: "f", mimeType: mime, content, source, uploadedByEmail: "zz@example.invalid", uploadedByName: null });
  const custody = await ins(C1, "Custody order", pdf("custody"), "application/pdf");
  const faxDoc = await ins(C1, "Fax referral 09/26/2026", pdf("fax"), "application/pdf", "fax_referral");
  const photo = await ins(C1, "Custody photo", PNG, "image/png");
  const other = await ins(C2, "Other contact's file", pdf("other"), "application/pdf");

  let sent = tn.buildTnDocumentList(await db.listContactDocuments(C1), C1, "https://crm.example");
  eq("first run sends all three, fax first", sent.map((d) => d.crm_document_id), [faxDoc.id, custody.id, photo.id]);

  // The agent filed the fax referral and the custody order, then the photo failed.
  const stamped = await db.stampDocumentsUploadedToTn(C1, "run-1", [faxDoc.id, custody.id, other.id]);
  eq("only this contact's documents are stamped", stamped.sort(), [custody.id, faxDoc.id].sort());
  const otherRow = (await db.listContactDocuments(C2))[0];
  eq("the other contact's document stays unstamped", otherRow.tnUploadedAt, null);
  const listed = await db.listContactDocuments(C1);
  ok("the list carries the stamp (the 'In TN' marker)",
    !!listed.find((d) => d.id === faxDoc.id)?.tnUploadedAt && listed.find((d) => d.id === photo.id)?.tnUploadedAt === null);

  sent = tn.buildTnDocumentList(listed, C1, "https://crm.example");
  eq("a re-run sends only the one not yet filed", sent.map((d) => d.crm_document_id), [photo.id]);

  const again = await db.stampDocumentsUploadedToTn(C1, "run-2", [faxDoc.id]);
  eq("re-stamping changes nothing", again, []);
  const runId = (await pool.query(`SELECT tn_upload_run_id FROM contact_documents WHERE id = $1`, [faxDoc.id])).rows[0].tn_upload_run_id;
  eq("the first run keeps the credit", runId, "run-1");

  // ---------------------------------------------------------------------
  console.log("\n[5] The agent's fetch route: key only, scoped, active only");
  const express = (await import("express")).default;
  const { authMiddleware } = await import("../server/auth");
  const { registerContactDocumentRoutes } = await import("../server/documents/routes");
  const app = express();
  app.use((req: any, _res, next) => { req.isAuthenticated = () => false; next(); }); // no session
  app.use(authMiddleware);
  registerContactDocumentRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const agent = (c: number, d: number, key?: string) =>
    fetch(`${base}/api/internal/contact-document/${c}/${d}`, { headers: key ? { "x-api-key": key } : {} });
  try {
    let r = await agent(C1, photo.id, "zztest-agent-key");
    eq("with the key -> 200 (no session needed: allow-listed like the intake PDF)", r.status, 200);
    eq("  type", r.headers.get("content-type"), "image/png");
    ok("  the exact bytes", Buffer.from(await r.arrayBuffer()).equals(PNG));
    eq("no key -> 401", (await agent(C1, photo.id)).status, 401);
    eq("wrong key -> 401", (await agent(C1, photo.id, "zztest-agent-kez")).status, 401);
    eq("another contact's document -> 404", (await agent(C2, photo.id, "zztest-agent-key")).status, 404);
    await db.softDeleteContactDocument(C1, custody.id, "zz@example.invalid");
    eq("a removed document -> 404", (await agent(C1, custody.id, "zztest-agent-key")).status, 404);
    eq("the staff route still needs a session -> 401",
      (await fetch(`${base}/api/contact/${C1}/documents/${photo.id}/content`)).status, 401);
    const saved = process.env.TN_API_KEY;
    process.env.TN_API_KEY = "";
    eq("no key configured on the server -> 401, never open", (await agent(C1, photo.id, "")).status, 401);
    process.env.TN_API_KEY = saved;
  } finally {
    server.close();
  }

  // ---------------------------------------------------------------------
  console.log("\n[6] Wiring in the Add to Schedule route and the progress callback");
  const routes = readFileSync(join(process.cwd(), "server", "routes.ts"), "utf8");
  ok("the payload carries the unstamped documents",
    routes.includes("documents: buildTnDocumentList(await listContactDocuments(contactId), contactId, baseUrl),"));
  ok("upload_documents is an accepted phase", /"schedule_appointment",[\s\S]{0,300}"upload_documents",[\s\S]{0,40}"workflow_complete",/.test(routes));
  ok("the callback stamps on upload_documents and workflow_complete, when ok",
    /body\.status === "ok" && \(body\.phase === "upload_documents" \|\| body\.phase === "workflow_complete"\)[\s\S]{0,200}documentIdsToStamp\(meta\)[\s\S]{0,300}stampDocumentsUploadedToTn\(pathContactId, body\.runId, ids\)/.test(routes));
  ok("the run's started entry records which documents were sent (ids only)",
    routes.includes("documentsSent: (payload.documents ?? []).map((d) => d.crm_document_id),"));
  ok("the agent route is allow-listed for the key check",
    readFileSync(join(process.cwd(), "server", "auth.ts"), "utf8").includes('"/api/internal/contact-document/",'));
  const card = readFileSync(join(process.cwd(), "client", "src", "components", "contact-documents-card.tsx"), "utf8");
  ok("the card shows 'In TN' on filed documents", /\{d\.tnUploadedAt && \([\s\S]{0,800}In TN/.test(card));

  // ---------------------------------------------------------------------
  console.log("\n[7] The zip refusal reads as a sentence staff can act on");
  eq("zip_not_recognised", tnFailureText("zip_not_recognised"),
    "Zip code not recognised by TherapyNotes; check the address on the contact");
  ok("the pre-28-September code reads as a sentence too", /check the address on the contact/.test(tnFailureText("zip_autocomplete_failed")));
  eq("an unmapped code is shown as-is", tnFailureText("appointment_creation_failed"), "appointment_creation_failed");
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const run = computeTnRun([
    { id: 3, type: "tn_schedule_failed", actorEmail: "tn-agent", summary: "", createdAt: now,
      metadata: { runId: "r1", phase: "workflow_complete", failureReason: "zip_not_recognised" } },
    { id: 2, type: "tn_schedule_phase", actorEmail: "tn-agent", summary: "", createdAt: now,
      metadata: { runId: "r1", phase: "fill_form", status: "failed" } },
    { id: 1, type: "tn_schedule_started", actorEmail: "zz@example.invalid", summary: "", createdAt: now,
      metadata: { runId: "r1" } },
  ] as any);
  eq("the failure card gets the sentence", run.failedReason, "Zip code not recognised by TherapyNotes; check the address on the contact");
  ok("and knows no patient was created", run.patientCreated === false);

  await pool.query(`DELETE FROM contact_documents WHERE contact_id IN ($1, $2)`, [C1, C2]);
  await pool.end();
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
