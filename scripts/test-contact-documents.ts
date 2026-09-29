/**
 * Contact documents, end to end over HTTP — `npm run test:contact-documents`.
 *
 * Mounts the REAL document routes behind the REAL authMiddleware on a local
 * express app, against a throwaway local Postgres. Only the session itself is
 * simulated: a request carrying `x-test-user` is signed in as that user,
 * anything else has no session — exactly what passport would give the
 * middleware.
 *
 * Writes rows. Run ONLY against the throwaway database:
 *   DATABASE_URL=postgres://tfc@127.0.0.1:55434/tfc_docstest \
 *     npx tsx scripts/test-contact-documents.ts
 *
 * NO PHI: ZZTEST contacts, example.invalid users, generated placeholder files.
 */

const url = process.env.DATABASE_URL ?? "";
if (!(/@(127\.0\.0\.1|localhost)[:/]/.test(url) && /tfc_docstest/.test(url))) {
  console.error(
    "REFUSING TO RUN. This script writes contacts and documents and must only point at\n" +
      "the throwaway local database (127.0.0.1/localhost, tfc_docstest).",
  );
  process.exit(2);
}
// authMiddleware lets everything through when Azure AD is not configured
// (local dev bypass). Configure it BEFORE importing auth so the real gate runs.
process.env.AZURE_AD_CLIENT_ID = "zztest-auth-enabled";

import { readFileSync, readdirSync, statSync } from "fs";
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

// --- Generated placeholder files (no real document, no PHI) -----------------
function placeholderPdf(label: string, padTo = 0): Buffer {
  const head = `%PDF-1.4\n% ZZTEST placeholder: ${label}\n1 0 obj << /Type /Catalog >> endobj\n`;
  const tail = "trailer << /Root 1 0 R >>\n%%EOF\n";
  const pad = Math.max(0, padTo - head.length - tail.length);
  return Buffer.concat([Buffer.from(head), Buffer.alloc(pad, 0x20), Buffer.from(tail)]);
}
// 1x1 images, generated for this test.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG_1x1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

async function main() {
  const express = (await import("express")).default;
  const { authMiddleware } = await import("../server/auth");
  const { getPool } = await import("../server/db/pool");
  const syncDb = await import("../server/sync/db");
  const activity = await import("../server/activity/db");
  const docsDb = await import("../server/documents/db");
  const { registerContactDocumentRoutes, faxReferralName } = await import("../server/documents/routes");
  const { buildIntakeRecord } = await import("../server/intake/build-intake");
  const { REFERRAL_UPLOAD_EMAILS } = await import("../shared/access-control");
  const { DOCUMENT_MAX_BYTES, FAX_REFERRAL_MAX_BYTES } = await import("../shared/contact-documents");

  // --- Schema: the app's own init, the prior column migrations, and the new
  // migration twice (idempotent), then the app's boot init again (a no-op).
  const pool = getPool();
  process.env.RUN_MIGRATIONS = "true";
  await syncDb.initSyncTables();
  await activity.initActivityTable();
  for (const f of ["add-language-column.sql", "add-scheduled-appointment-tn-v2.sql", "add-custody-docs-and-hold.sql"]) {
    await pool.query(readFileSync(join(process.cwd(), "migrations", f), "utf8"));
  }
  console.log("\n[0] Migration is idempotent and matches the boot init");
  const migration = readFileSync(join(process.cwd(), "migrations", "add-contact-documents.sql"), "utf8");
  let migErr = "";
  try { await pool.query(migration); await pool.query(migration); } catch (e) { migErr = String(e); }
  ok("the migration runs twice without error", migErr === "", migErr);
  let initErr = "";
  try { await docsDb.initContactDocumentsTable(); } catch (e) { initErr = String(e); }
  ok("the boot init runs cleanly on the migrated table", initErr === "", initErr);
  const cols = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'contact_documents' ORDER BY column_name`,
  )).rows.map((r) => r.column_name);
  eq("columns", cols, [
    "contact_id", "content", "deleted_at", "deleted_by_email", "display_name", "id", "mime_type",
    "original_filename", "sha256", "size_bytes", "source", "tn_upload_run_id", "tn_uploaded_at",
    "uploaded_at", "uploaded_by_email", "uploaded_by_name",
  ]);

  // --- Contacts
  await pool.query(`DELETE FROM contact_documents`);
  await pool.query(`DELETE FROM activity_log WHERE type LIKE 'document_%'`);
  await pool.query(`DELETE FROM sync_contacts WHERE contact_id IN (990401, 990402) OR contact_id >= 900000`);
  await pool.query(`INSERT INTO sync_contacts (contact_id, name, status_code) VALUES (990401, 'ZZTEST Docs A', 100), (990402, 'ZZTEST Docs B', 100)`);
  const A = 990401, B = 990402;

  // --- App: fake session -> real authMiddleware -> real document routes
  const app = express();
  app.use((req: any, _res, next) => {
    const email = req.header("x-test-user");
    req.user = email ? { email, name: `ZZTEST ${email.split("@")[0]}` } : undefined;
    req.isAuthenticated = () => !!email;
    next();
  });
  app.use(authMiddleware);
  registerContactDocumentRoutes(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const STAFF = "zztest.sandra@example.invalid";
  const OTHER = "zztest.lane@example.invalid";
  const REFERRAL_STAFF = REFERRAL_UPLOAD_EMAILS[0];
  const as = (email: string | null) => (email ? { "x-test-user": email } : {});
  const upload = async (contactId: number, file: Buffer, filename: string, name: string | null, email: string | null = STAFF, mime = "application/octet-stream", path = "") => {
    const fd = new FormData();
    if (name !== null) fd.append("name", name);
    fd.append("file", new Blob([file], { type: mime }), filename);
    return fetch(`${base}/api/contact/${contactId}/documents${path}`, { method: "POST", headers: as(email), body: fd });
  };
  const list = async (contactId: number, email: string | null = STAFF) =>
    fetch(`${base}/api/contact/${contactId}/documents`, { headers: as(email) });
  const content = (contactId: number, id: number, disposition = "inline", email: string | null = STAFF) =>
    fetch(`${base}/api/contact/${contactId}/documents/${id}/content?disposition=${disposition}`, { headers: as(email) });
  const remove = (contactId: number, id: number, email: string | null = STAFF) =>
    fetch(`${base}/api/contact/${contactId}/documents/${id}`, { method: "DELETE", headers: as(email) });
  const acts = async (contactId: number) =>
    (await activity.getActivityForContact(contactId, 50)).filter((a) => a.type.startsWith("document_"));

  try {
    // ---------------------------------------------------------------------
    console.log("\n[1] Upload, list, view, download");
    const pdf = placeholderPdf("custody order");
    let r = await upload(A, pdf, "custody-order-scan.pdf", "Custody order", STAFF, "application/pdf");
    eq("PDF upload -> 201", r.status, 201);
    const custody = (await r.json()).document;
    eq("  named as typed", custody.displayName, "Custody order");
    eq("  source is staff_upload", custody.source, "staff_upload");
    eq("  size recorded", custody.sizeBytes, pdf.length);
    eq("  uploader recorded", custody.uploadedByEmail, STAFF);

    r = await upload(A, PNG_1x1, "VA referral photo.png", null, OTHER, "image/png");
    eq("PNG upload with no name -> 201", r.status, 201);
    const png = (await r.json()).document;
    eq("  default name is the filename without extension", png.displayName, "VA referral photo");
    eq("  type from the bytes", png.mimeType, "image/png");
    r = await upload(A, JPEG_1x1, "custody-photo.jpeg", "Custody photo", STAFF, "image/jpeg");
    eq("JPEG upload -> 201", r.status, 201);
    const jpg = (await r.json()).document;

    r = await list(A);
    const listed = (await r.json()).documents;
    eq("list returns the three, oldest first", listed.map((d: any) => d.id), [custody.id, png.id, jpg.id]);
    ok("list never carries the bytes", listed.every((d: any) => !("content" in d)));

    r = await content(A, custody.id, "inline", OTHER);
    eq("View -> 200 for another signed-in staff user", r.status, 200);
    eq("  Content-Type is the stored type", r.headers.get("content-type"), "application/pdf");
    ok("  Content-Disposition inline with the name", /^inline; filename="Custody order\.pdf"/.test(r.headers.get("content-disposition") ?? ""), String(r.headers.get("content-disposition")));
    eq("  nosniff", r.headers.get("x-content-type-options"), "nosniff");
    eq("  not cached", r.headers.get("cache-control"), "private, no-store");
    ok("  the bytes come back unchanged", Buffer.from(await r.arrayBuffer()).equals(pdf));
    r = await content(A, png.id, "attachment");
    ok("Download -> attachment", /^attachment; filename="VA referral photo\.png"/.test(r.headers.get("content-disposition") ?? ""));
    eq("  image/png", r.headers.get("content-type"), "image/png");

    let log = await acts(A);
    eq("three upload entries on the timeline", log.filter((a) => a.type === "document_uploaded").length, 3);
    const upEntry = log.find((a) => a.type === "document_uploaded" && a.metadata.documentId === custody.id);
    eq("  by the uploader", upEntry?.actorEmail, STAFF);
    eq("  summary", upEntry?.summary, "Uploaded Custody order to ZZTEST Docs A's documents");

    // ---------------------------------------------------------------------
    console.log("\n[2] Type and size are enforced by the server");
    r = await upload(A, Buffer.from("ZZTEST plain text pretending"), "fake.pdf", "Fake", STAFF, "application/pdf");
    eq("text named .pdf and sent as application/pdf -> 415", r.status, 415);
    r = await upload(A, Buffer.from("<html><script>alert(1)</script></html>"), "x.png", "X", STAFF, "image/png");
    eq("HTML sent as image/png -> 415", r.status, 415);
    r = await upload(A, Buffer.from("GIF89a....."), "x.gif", "X", STAFF, "image/gif");
    eq("GIF -> 415", r.status, 415);
    const over = placeholderPdf("oversize", DOCUMENT_MAX_BYTES + 1);
    r = await upload(A, over, "big-scan.pdf", "Big scan", STAFF, "application/pdf");
    eq("15 MB + 1 byte -> 413", r.status, 413);
    ok("  with a clear message", /larger than 15 MB/.test((await r.json()).message ?? ""));
    const atLimit = placeholderPdf("at limit", DOCUMENT_MAX_BYTES);
    r = await upload(A, atLimit, "limit.pdf", "Exactly 15 MB", STAFF, "application/pdf");
    eq("exactly 15 MB -> 201", r.status, 201);
    const limitDoc = (await r.json()).document;
    r = await upload(A, Buffer.alloc(0), "empty.pdf", "Empty", STAFF, "application/pdf");
    eq("an empty file -> 400", r.status, 400);
    eq("nothing refused was stored", (await (await list(A)).json()).documents.length, 4);

    // ---------------------------------------------------------------------
    console.log("\n[3] No session, no document");
    for (const [label, res] of [
      ["list", await list(A, null)],
      ["view", await content(A, custody.id, "inline", null)],
      ["download", await content(A, custody.id, "attachment", null)],
      ["upload", await upload(A, pdf, "x.pdf", "X", null, "application/pdf")],
      ["remove", await remove(A, custody.id, null)],
      ["fax referral", await upload(A, pdf, "x.pdf", null, null, "application/pdf", "/fax-referral")],
    ] as const) {
      eq(`${label} without a session -> 401`, res.status, 401);
      ok(`  ${label} without a session returns no file bytes`, !(await res.text()).includes("%PDF"));
    }
    eq("still four documents after the refused remove", (await (await list(A)).json()).documents.length, 4);

    // ---------------------------------------------------------------------
    console.log("\n[4] A document is only reachable through its own contact");
    eq("A's document through B's URL -> 404", (await content(B, custody.id)).status, 404);
    eq("A's document removed through B's URL -> 404", (await remove(B, custody.id)).status, 404);
    eq("  ...and it is still on A", (await content(A, custody.id)).status, 200);
    eq("B's list is empty", (await (await list(B)).json()).documents.length, 0);
    eq("an unknown contact -> 404", (await list(999999)).status, 404);
    eq("a bad document id -> 400", (await fetch(`${base}/api/contact/${A}/documents/abc/content`, { headers: as(STAFF) })).status, 400);

    // ---------------------------------------------------------------------
    console.log("\n[5] Remove is a soft delete, on the timeline");
    r = await remove(A, png.id, OTHER);
    eq("remove -> 200", r.status, 200);
    eq("gone from the list", (await (await list(A)).json()).documents.map((d: any) => d.id), [custody.id, jpg.id, limitDoc.id]);
    eq("gone from View", (await content(A, png.id)).status, 404);
    eq("removing again -> 404", (await remove(A, png.id)).status, 404);
    const row = (await pool.query(`SELECT deleted_at IS NOT NULL AS gone, deleted_by_email, length(content) AS n FROM contact_documents WHERE id = $1`, [png.id])).rows[0];
    ok("the row and its bytes are kept", row.gone === true && row.n === PNG_1x1.length);
    eq("  with who removed it", row.deleted_by_email, OTHER);
    log = await acts(A);
    const rm = log.find((a) => a.type === "document_removed");
    eq("  removal on the timeline by that person", rm?.actorEmail, OTHER);
    eq("  summary", rm?.summary, "Removed VA referral photo from ZZTEST Docs A's documents");

    // ---------------------------------------------------------------------
    console.log("\n[6] The fax referral is kept on the contact it created");
    // Create the contact exactly as /api/intake does for the staff upload path,
    // from the existing "staff upload" intake fixture.
    const fixtures = JSON.parse(readFileSync(join(process.cwd(), "scripts", "fixtures", "intake-legacy.json"), "utf8"));
    const staffFixture = (fixtures.fixtures ?? fixtures).find((f: any) => /staff upload/i.test(f.label));
    ok("the staff-upload fixture exists", !!staffFixture);
    const built = buildIntakeRecord(staffFixture.body, new Date().toISOString());
    ok("the fixture builds as an uploaded referral", built.ok && (built as any).isUploadedReferral === true);
    const referralId = await syncDb.generateIntakeContactId();
    await syncDb.insertIntakeContact({ contactId: referralId, sourceSubmissionId: null, ...(built as any).fields });
    const fax = placeholderPdf("fax referral");

    r = await upload(referralId, fax, "fax-2026-09-28.pdf", null, STAFF, "application/pdf", "/fax-referral");
    eq("a user outside the referral-upload list -> 403", r.status, 403);
    r = await upload(referralId, fax, "fax-2026-09-28.pdf", "ignored name", REFERRAL_STAFF, "application/pdf", "/fax-referral");
    eq("referral staff -> 201", r.status, 201);
    const faxDoc = (await r.json()).document;
    eq("  source fax_referral, set by the server", faxDoc.source, "fax_referral");
    eq("  named Fax referral <date>, not what the request said", faxDoc.displayName, faxReferralName(new Date()));
    ok("  the name has the MM/DD/YYYY date", /^Fax referral \d{2}\/\d{2}\/\d{4}$/.test(faxDoc.displayName));
    r = await upload(referralId, fax, "fax-2026-09-28.pdf", null, REFERRAL_STAFF, "application/pdf", "/fax-referral");
    eq("the same PDF again -> 200, not a second copy", r.status, 200);
    eq("  flagged as a duplicate", (await r.json()).duplicate, true);
    eq("  one document on the contact", (await (await list(referralId)).json()).documents.length, 1);
    eq("a contact not created from a referral -> 409",
      (await upload(A, fax, "f.pdf", null, REFERRAL_STAFF, "application/pdf", "/fax-referral")).status, 409);
    eq("a fax referral that is not a PDF -> 415",
      (await upload(referralId, PNG_1x1, "f.png", null, REFERRAL_STAFF, "image/png", "/fax-referral")).status, 415);
    const bigFax = placeholderPdf("big fax", 16 * 1024 * 1024);
    eq("a 16 MB referral is refused as a staff upload -> 413",
      (await upload(referralId, bigFax, "big.pdf", "Big", STAFF, "application/pdf")).status, 413);
    eq("...but kept as the fax referral (the extractor accepts 20 MB) -> 201",
      (await upload(referralId, bigFax, "big.pdf", null, REFERRAL_STAFF, "application/pdf", "/fax-referral")).status, 201);
    eq("a fax referral over 20 MB -> 413",
      (await upload(referralId, placeholderPdf("huge", FAX_REFERRAL_MAX_BYTES + 1), "h.pdf", null, REFERRAL_STAFF, "application/pdf", "/fax-referral")).status, 413);
    const faxLog = (await acts(referralId)).find((a) => a.metadata.source === "fax_referral");
    ok("fax referral on the timeline", !!faxLog && faxLog.summary.startsWith("Saved the fax referral to"));

    // ---------------------------------------------------------------------
    console.log("\n[7] The scheduling-flow helper: active documents, with bytes, in upload order");
    const withBytes = await docsDb.getActiveContactDocumentsWithContent(A);
    eq("A: active only, oldest first", withBytes.map((d) => d.id), [custody.id, jpg.id, limitDoc.id]);
    ok("  bytes included and exact", withBytes[0].content.equals(pdf) && withBytes[1].content.equals(JPEG_1x1));
    ok("  the removed PNG is not returned", !withBytes.some((d) => d.id === png.id));
    const refDocs = await docsDb.getActiveContactDocumentsWithContent(referralId);
    eq("referral contact: the fax referral first", refDocs[0]?.source, "fax_referral");
    ok("  its bytes are the uploaded PDF", refDocs[0]?.content.equals(fax));
    eq("a contact with none -> empty", (await docsDb.getActiveContactDocumentsWithContent(B)).length, 0);
  } finally {
    server.close();
  }

  // ---------------------------------------------------------------------
  console.log("\n[8] Wiring");
  const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
  const index = read("server", "index.ts");
  ok("routes are registered after app.use(authMiddleware)",
    index.indexOf("app.use(authMiddleware)") < index.indexOf("await registerRoutes(httpServer, app)"));
  ok("registerRoutes mounts the document routes", read("server", "routes.ts").includes("registerContactDocumentRoutes(app);"));
  ok("the table is created on boot", index.includes("await initContactDocumentsTable();"));
  ok("no document path is public in auth.ts", !/documents/.test(read("server", "auth.ts")));
  const referralPage = read("client", "src", "pages", "referral.tsx");
  ok("the referral page keeps the PDF on the new contact after /api/intake succeeds",
    /const \{ contactId \} = await res\.json\(\);[\s\S]{0,600}await attachFaxReferral\(contactId, file\)/.test(referralPage));
  ok("the public /api/intake route does not handle files", !/multer|documents/.test(
    read("server", "routes.ts").slice(read("server", "routes.ts").indexOf('app.post("/api/intake"'), read("server", "routes.ts").indexOf('app.post("/api/intake"') + 4000)));
  const docsDir = join(process.cwd(), "server", "documents");
  const docsSrc = readdirSync(docsDir).filter((f) => statSync(join(docsDir, f)).isFile()).map((f) => read("server", "documents", f)).join("\n");
  ok("uploads are held in memory, never written to disk",
    docsSrc.includes("multer.memoryStorage()") && !/diskStorage|writeFile|createWriteStream|from "fs"/.test(docsSrc));
  ok("the list query never selects content",
    /export async function listContactDocuments[\s\S]{0,300}SELECT \$\{META_COLUMNS\} FROM/.test(docsSrc));
  const page = read("client", "src", "pages", "contact-detail.tsx");
  ok("the Documents card sits just above the Intake Summary",
    page.indexOf("<ContactDocumentsCard") > 0 && page.indexOf("<ContactDocumentsCard") < page.indexOf("{/* Intake Summary - Editable"));
  ok("document entries appear on the contact timeline", page.includes('"document_uploaded", "document_removed"'));
  const card = read("client", "src", "components", "contact-documents-card.tsx");
  ok("the card checks size before uploading", card.includes("picked.size > DOCUMENT_MAX_BYTES"));

  await pool.end();
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
