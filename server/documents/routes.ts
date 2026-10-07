/**
 * Contact documents — upload, list, view/download, remove, and the fax-referral
 * copy. Registered from registerRoutes, i.e. AFTER app.use(authMiddleware)
 * (server/index.ts), so none of these paths is public.
 *
 * DEFENCE IN DEPTH. Each handler also refuses a request with no signed-in user
 * itself, so a document can never be served without a session even if a path
 * were one day added to auth.ts's public lists by mistake.
 *
 * ACCESS. canViewContactDocuments() is the single decision. Today it mirrors
 * the contact page exactly: any signed-in staff user can open any existing
 * contact (this app has no per-contact scoping; see the waitlist note in
 * shared/access-control.ts). A document is only ever read THROUGH its own
 * contact — the queries in ./db.ts match on (document id, contact id) — so a
 * document id asked for under another contact's URL is a 404.
 *
 * UPLOADS never touch the container filesystem: multer's memoryStorage holds
 * the file in a buffer for the length of the request, the size limit aborts
 * the stream as soon as it is exceeded, and the bytes go straight to Postgres.
 *
 * LOGS carry ids, sizes and types only — never a document name, a filename or
 * any byte of a file.
 */

import { timingSafeEqual } from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import { canAccessReferralUpload } from "@shared/access-control";
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_NAME_MAX,
  FAX_REFERRAL_MAX_BYTES,
  defaultDocumentName,
  sniffDocumentType,
  tooLargeMessage,
  validateDocumentName,
  type DocumentMimeType,
} from "@shared/contact-documents";
import { getSyncContactById, type SyncContact } from "../sync/db";
import { logActivity } from "../activity/db";
import {
  findActiveDocumentByHash,
  getContactDocumentContent,
  insertContactDocument,
  listContactDocuments,
  renameContactDocument,
  sha256Hex,
  softDeleteContactDocument,
} from "./db";

type AuthedUser = { email?: string; name?: string };
const userOf = (req: Request): AuthedUser | null => ((req as any).user as AuthedUser | undefined) ?? null;

const EXTENSION: Record<DocumentMimeType, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

/**
 * May this user see this contact's documents? Same rule as the contact page:
 * signed in, and the contact exists. Returns the contact, or sends the refusal
 * and returns null. The ONE place to add per-contact scoping if it ever exists.
 */
async function canViewContactDocuments(req: Request, res: Response): Promise<SyncContact | null> {
  const user = userOf(req);
  if (!user?.email) {
    res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
    return null;
  }
  const contactId = Number.parseInt(req.params.contactId, 10);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    res.status(400).json({ error: "Invalid contact ID" });
    return null;
  }
  const contact = await getSyncContactById(contactId);
  if (!contact) {
    res.status(404).json({ error: "Contact not found" });
    return null;
  }
  return contact;
}

function documentIdOf(req: Request, res: Response): number | null {
  const id = Number.parseInt(req.params.documentId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid document ID" });
    return null;
  }
  return id;
}

/**
 * One file, held in memory, capped at `maxBytes` while it streams in.
 *
 * The multer limit is maxBytes + 1 on purpose: busboy flags a file as over the
 * limit the moment it REACHES the limit, which would refuse a file of exactly
 * 15 MB. With one byte of headroom a file at the limit parses, anything bigger
 * is still cut off mid-stream, and the size check below makes the boundary
 * exact.
 */
function singleFile(maxBytes: number) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes + 1, files: 1, fields: 5 },
  }).single("file");
  return (req: Request, res: Response, next: NextFunction) => {
    // Refuse before reading a byte of the body when there is no session.
    if (!userOf(req)?.email) {
      return res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
    }
    upload(req, res, (err: unknown) => {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!err && file && file.size > maxBytes) {
        return res.status(413).json({ error: "file_too_large", message: tooLargeMessage(maxBytes) });
      }
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "file_too_large", message: tooLargeMessage(maxBytes) });
      }
      const code = err instanceof multer.MulterError ? err.code : "upload_failed";
      console.warn(`[contact-documents] upload refused: ${code}`);
      return res.status(400).json({ error: "upload_failed", message: "The file could not be uploaded. Please try again." });
    });
  };
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename. */
function contentDisposition(kind: "inline" | "attachment", name: string, mime: DocumentMimeType): string {
  const full = `${name}${EXTENSION[mime]}`;
  const ascii = full.replace(/[^\x20-\x7e]/g, "_").replace(/["\\/;:]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** "Fax referral 09/28/2026" — the practice's local date. */
export function faxReferralName(now: Date): string {
  const d = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return `Fax referral ${d}`;
}

/** Constant-time check of the TN agent's X-API-Key against TN_API_KEY. */
function agentKeyOk(req: Request): boolean {
  const expected = process.env.TN_API_KEY || "";
  const got = String(req.headers["x-api-key"] || "");
  if (!expected || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export function registerContactDocumentRoutes(app: Express): void {
  // --------------------------------------------------------------------------
  // The TN agent fetches a document it was sent in an Add to Schedule payload.
  //
  // The intake PDF's pattern (/api/internal/contact-intake-pdf/:id): allow-
  // listed in auth.ts's publicPaths so the session middleware skips it, and
  // the X-API-Key matching TN_API_KEY is the ONLY gate — no key, wrong key or
  // no key configured is a 401. Same (document, contact) scoping as the staff
  // route: an id under another contact is a 404, and so is a removed one.
  // --------------------------------------------------------------------------
  app.get("/api/internal/contact-document/:contactId/:documentId", async (req, res) => {
    try {
      if (!agentKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
      const contactId = Number.parseInt(req.params.contactId, 10);
      const documentId = Number.parseInt(req.params.documentId, 10);
      if (!Number.isInteger(contactId) || contactId <= 0 || !Number.isInteger(documentId) || documentId <= 0) {
        return res.status(400).json({ error: "Invalid id" });
      }
      const doc = await getContactDocumentContent(contactId, documentId);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      res.setHeader("Content-Type", doc.mimeType);
      res.setHeader("Content-Length", String(doc.content.length));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      console.log(`[contact-documents] agent fetched id=${documentId} contact=${contactId} bytes=${doc.content.length}`);
      return res.end(doc.content);
    } catch (error) {
      console.error("[contact-documents] agent fetch failed:", error instanceof Error ? error.message : "unknown");
      return res.status(500).json({ error: "Failed to load the document" });
    }
  });

  // --------------------------------------------------------------------------
  // List (metadata only)
  // --------------------------------------------------------------------------
  app.get("/api/contact/:contactId/documents", async (req, res) => {
    try {
      const contact = await canViewContactDocuments(req, res);
      if (!contact) return;
      return res.json({ documents: await listContactDocuments(contact.contactId) });
    } catch (error) {
      console.error("[contact-documents] list failed:", error instanceof Error ? error.message : "unknown");
      return res.status(500).json({ error: "Failed to load documents" });
    }
  });

  // --------------------------------------------------------------------------
  // Staff upload: PDF, JPG or PNG, up to 15 MB, named at upload
  // --------------------------------------------------------------------------
  app.post("/api/contact/:contactId/documents", singleFile(DOCUMENT_MAX_BYTES), async (req, res) => {
    try {
      const contact = await canViewContactDocuments(req, res);
      if (!contact) return;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file || file.size === 0) {
        return res.status(400).json({ error: "no_file", message: "Choose a file to upload." });
      }
      const mime = sniffDocumentType(file.buffer);
      if (!mime) {
        return res.status(415).json({
          error: "unsupported_type",
          message: "Only PDF, JPG and PNG files can be uploaded.",
        });
      }
      const typedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const displayName = (typedName || defaultDocumentName(file.originalname)).slice(0, DOCUMENT_NAME_MAX);
      const user = userOf(req)!;

      const document = await insertContactDocument({
        contactId: contact.contactId,
        displayName,
        originalFilename: file.originalname.slice(0, 255),
        mimeType: mime,
        content: file.buffer,
        source: "staff_upload",
        uploadedByEmail: user.email!,
        uploadedByName: user.name ?? null,
      });
      await logActivity({
        type: "document_uploaded",
        actorEmail: user.email!,
        entityType: "contact",
        entityId: String(contact.contactId),
        entityName: contact.name,
        metadata: { documentId: document.id, name: displayName, source: "staff_upload", mimeType: mime, sizeBytes: file.size },
      });
      console.log(`[contact-documents] uploaded id=${document.id} contact=${contact.contactId} type=${mime} bytes=${file.size}`);
      return res.status(201).json({ document });
    } catch (error) {
      console.error("[contact-documents] upload failed:", error instanceof Error ? error.message : "unknown");
      return res.status(500).json({ error: "Failed to save the document" });
    }
  });

  // --------------------------------------------------------------------------
  // The fax referral a contact was created from
  //
  // Called by the referral upload page (client/src/pages/referral.tsx) right
  // after /api/intake creates the contact, with the same PDF it extracted from.
  // /api/intake itself is a PUBLIC route (the website form posts to it), so the
  // file deliberately does not travel through it. The server — not the
  // request — decides this is a fax referral: only referral-upload staff may
  // call it, only for a contact created from an uploaded referral, only a PDF.
  // Idempotent: the same bytes sent twice keep one document.
  // --------------------------------------------------------------------------
  app.post(
    "/api/contact/:contactId/documents/fax-referral",
    singleFile(FAX_REFERRAL_MAX_BYTES),
    async (req, res) => {
      try {
        const user = userOf(req);
        if (!canAccessReferralUpload(user?.email)) {
          return res.status(403).json({ error: "Access denied" });
        }
        const contact = await canViewContactDocuments(req, res);
        if (!contact) return;
        if (contact.intakeSource !== "uploaded_referral") {
          return res.status(409).json({
            error: "not_a_referral_contact",
            message: "This contact was not created from an uploaded referral.",
          });
        }
        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file || file.size === 0) {
          return res.status(400).json({ error: "no_file", message: "No referral PDF was sent." });
        }
        if (sniffDocumentType(file.buffer) !== "application/pdf") {
          return res.status(415).json({ error: "unsupported_type", message: "A fax referral must be a PDF." });
        }

        const existing = await findActiveDocumentByHash(contact.contactId, "fax_referral", sha256Hex(file.buffer));
        if (existing) return res.json({ document: existing, duplicate: true });

        const displayName = faxReferralName(new Date());
        const document = await insertContactDocument({
          contactId: contact.contactId,
          displayName,
          originalFilename: file.originalname.slice(0, 255),
          mimeType: "application/pdf",
          content: file.buffer,
          source: "fax_referral",
          uploadedByEmail: user!.email!,
          uploadedByName: user!.name ?? null,
        });
        await logActivity({
          type: "document_uploaded",
          actorEmail: user!.email!,
          entityType: "contact",
          entityId: String(contact.contactId),
          entityName: contact.name,
          metadata: { documentId: document.id, name: displayName, source: "fax_referral", mimeType: "application/pdf", sizeBytes: file.size },
        });
        console.log(`[contact-documents] fax referral saved id=${document.id} contact=${contact.contactId} bytes=${file.size}`);
        return res.status(201).json({ document, duplicate: false });
      } catch (error) {
        console.error("[contact-documents] fax referral save failed:", error instanceof Error ? error.message : "unknown");
        return res.status(500).json({ error: "Failed to save the referral PDF" });
      }
    },
  );

  // --------------------------------------------------------------------------
  // View (inline) or download (attachment)
  // --------------------------------------------------------------------------
  app.get("/api/contact/:contactId/documents/:documentId/content", async (req, res) => {
    try {
      const contact = await canViewContactDocuments(req, res);
      if (!contact) return;
      const documentId = documentIdOf(req, res);
      if (!documentId) return;
      const doc = await getContactDocumentContent(contact.contactId, documentId);
      if (!doc) return res.status(404).json({ error: "Document not found" });

      const kind = req.query.disposition === "attachment" ? "attachment" : "inline";
      res.setHeader("Content-Type", doc.mimeType);
      res.setHeader("Content-Length", String(doc.content.length));
      res.setHeader("Content-Disposition", contentDisposition(kind, doc.displayName, doc.mimeType));
      // The browser renders exactly the type we stored — which was decided by
      // the file's bytes at upload — and never guesses.
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Nothing is kept by a shared browser cache or a proxy; each view is a
      // fresh, session-checked request.
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      return res.end(doc.content);
    } catch (error) {
      console.error("[contact-documents] serve failed:", error instanceof Error ? error.message : "unknown");
      return res.status(500).json({ error: "Failed to load the document" });
    }
  });

  // --------------------------------------------------------------------------
  // Rename — the name only; the file, its source and its audit fields stay
  // --------------------------------------------------------------------------
  app.patch("/api/contact/:contactId/documents/:documentId", async (req, res) => {
    try {
      const contact = await canViewContactDocuments(req, res);
      if (!contact) return;
      const documentId = documentIdOf(req, res);
      if (!documentId) return;
      const checked = validateDocumentName(req.body?.name);
      if (!checked.ok) return res.status(400).json({ error: "invalid_name", message: checked.message });
      const user = userOf(req)!;
      const result = await renameContactDocument(contact.contactId, documentId, checked.name);
      if (!result) return res.status(404).json({ error: "Document not found" });
      if (result.previousName !== checked.name) {
        await logActivity({
          type: "document_renamed",
          actorEmail: user.email!,
          entityType: "contact",
          entityId: String(contact.contactId),
          entityName: contact.name,
          metadata: {
            documentId: result.document.id,
            from: result.previousName,
            name: result.document.displayName,
            source: result.document.source,
          },
        });
        console.log(`[contact-documents] renamed id=${result.document.id} contact=${contact.contactId}`);
      }
      return res.json({ document: result.document, renamed: result.previousName !== checked.name });
    } catch (error) {
      console.error("[contact-documents] rename failed:", error instanceof Error ? error.message : "unknown");
      return res.status(500).json({ error: "Failed to rename the document" });
    }
  });

  // --------------------------------------------------------------------------
  // Remove (soft delete)
  // --------------------------------------------------------------------------
  app.delete("/api/contact/:contactId/documents/:documentId", async (req, res) => {
    try {
      const contact = await canViewContactDocuments(req, res);
      if (!contact) return;
      const documentId = documentIdOf(req, res);
      if (!documentId) return;
      const user = userOf(req)!;
      const removed = await softDeleteContactDocument(contact.contactId, documentId, user.email!);
      if (!removed) return res.status(404).json({ error: "Document not found" });
      await logActivity({
        type: "document_removed",
        actorEmail: user.email!,
        entityType: "contact",
        entityId: String(contact.contactId),
        entityName: contact.name,
        metadata: { documentId: removed.id, name: removed.displayName, source: removed.source },
      });
      console.log(`[contact-documents] removed id=${removed.id} contact=${contact.contactId}`);
      return res.json({ success: true, documentId: removed.id });
    } catch (error) {
      console.error("[contact-documents] remove failed:", error instanceof Error ? error.message : "unknown");
      return res.status(500).json({ error: "Failed to remove the document" });
    }
  });
}
