/**
 * contact_documents — files kept against a contact.
 * ============================================================================
 *
 * WHY A NEW TABLE. Nothing in this app stores file bytes today: the intake PDF
 * is generated on demand by pdfmake from the contact and its latest submission
 * (server/pdf/intake-template.ts), and email snapshots store HTML and render a
 * PDF when asked. There was no document table to extend, so this is it.
 *
 * BYTES IN A BYTEA COLUMN, read only when asked for. Every list query below
 * names its columns and leaves `content` out, so listing a contact's documents
 * never pulls the files. The only readers of `content` are the serving route
 * (one document) and getActiveContactDocumentsWithContent (the scheduling
 * flow's helper).
 *
 * SOFT DELETE. Removing a document sets deleted_at / deleted_by_email; the row
 * and its bytes stay. `deleted_at IS NULL` is the active flag. There is no hard
 * delete anywhere in the app.
 *
 * Created on boot (CREATE TABLE IF NOT EXISTS, like every other CRM table) and
 * by migrations/add-contact-documents.sql for schema-before-code.
 */

import { createHash } from "crypto";
import { getPool } from "../db/pool";
import type { ContactDocument, DocumentMimeType, DocumentSource } from "@shared/contact-documents";

export async function initContactDocumentsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_documents (
      id                 SERIAL PRIMARY KEY,
      contact_id         INTEGER NOT NULL,
      display_name       TEXT NOT NULL,
      original_filename  TEXT NOT NULL,
      mime_type          TEXT NOT NULL,
      size_bytes         INTEGER NOT NULL,
      sha256             TEXT NOT NULL,
      content            BYTEA NOT NULL,
      source             TEXT NOT NULL,
      uploaded_by_email  TEXT NOT NULL,
      uploaded_by_name   TEXT,
      uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at         TIMESTAMPTZ,
      deleted_by_email   TEXT
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_contact_documents_active
      ON contact_documents (contact_id, uploaded_at, id)
      WHERE deleted_at IS NULL
  `);
  // Filed-to-TherapyNotes stamp (2026-09-28). Added here on every boot, like
  // the table itself — this table is CRM-only and new, so an idempotent
  // nullable ADD COLUMN is a metadata change with nothing to lock against.
  // migrations/add-contact-documents-tn-stamp.sql does the same by hand.
  await pool.query(`
    ALTER TABLE contact_documents
      ADD COLUMN IF NOT EXISTS tn_uploaded_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS tn_upload_run_id TEXT
  `);
  console.log("[contact-documents] Table initialized");
}

/** The metadata columns, in camelCase. Never includes `content`. */
const META_COLUMNS = `
  id,
  contact_id        AS "contactId",
  display_name      AS "displayName",
  original_filename AS "originalFilename",
  mime_type         AS "mimeType",
  size_bytes        AS "sizeBytes",
  source,
  uploaded_by_email AS "uploadedByEmail",
  uploaded_by_name  AS "uploadedByName",
  uploaded_at       AS "uploadedAt",
  tn_uploaded_at    AS "tnUploadedAt"
`;

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function insertContactDocument(doc: {
  contactId: number;
  displayName: string;
  originalFilename: string;
  mimeType: DocumentMimeType;
  content: Buffer;
  source: DocumentSource;
  uploadedByEmail: string;
  uploadedByName: string | null;
}): Promise<ContactDocument> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO contact_documents
       (contact_id, display_name, original_filename, mime_type, size_bytes, sha256,
        content, source, uploaded_by_email, uploaded_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${META_COLUMNS}`,
    [
      doc.contactId, doc.displayName, doc.originalFilename, doc.mimeType,
      doc.content.length, sha256Hex(doc.content), doc.content, doc.source,
      doc.uploadedByEmail, doc.uploadedByName,
    ],
  );
  return rows[0] as ContactDocument;
}

/** A contact's active documents, oldest first. Metadata only. */
export async function listContactDocuments(contactId: number): Promise<ContactDocument[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ${META_COLUMNS} FROM contact_documents
      WHERE contact_id = $1 AND deleted_at IS NULL
      ORDER BY uploaded_at ASC, id ASC`,
    [contactId],
  );
  return rows as ContactDocument[];
}

/**
 * One active document's bytes — ONLY if it belongs to `contactId`. A document
 * asked for through another contact's URL is not found, full stop.
 */
export async function getContactDocumentContent(
  contactId: number,
  documentId: number,
): Promise<(ContactDocument & { content: Buffer }) | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ${META_COLUMNS}, content FROM contact_documents
      WHERE id = $1 AND contact_id = $2 AND deleted_at IS NULL`,
    [documentId, contactId],
  );
  return (rows[0] as (ContactDocument & { content: Buffer }) | undefined) ?? null;
}

/**
 * Soft-delete. Returns the removed document's metadata, or null when there was
 * no active document with that id on that contact.
 */
export async function softDeleteContactDocument(
  contactId: number,
  documentId: number,
  deletedByEmail: string,
): Promise<ContactDocument | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE contact_documents
        SET deleted_at = NOW(), deleted_by_email = $3
      WHERE id = $1 AND contact_id = $2 AND deleted_at IS NULL
      RETURNING ${META_COLUMNS}`,
    [documentId, contactId, deletedByEmail],
  );
  return (rows[0] as ContactDocument | undefined) ?? null;
}

/**
 * Rename. The NAME only: file, type, size, hash, source, uploader and both
 * timestamps are untouched. Returns the document after the change and the name
 * it had before, or null when there is no active document with that id on that
 * contact.
 */
export async function renameContactDocument(
  contactId: number,
  documentId: number,
  displayName: string,
): Promise<{ document: ContactDocument; previousName: string } | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE contact_documents d
        SET display_name = $3
       FROM (SELECT id, display_name AS previous_name
               FROM contact_documents
              WHERE id = $1 AND contact_id = $2 AND deleted_at IS NULL
              FOR UPDATE) old
      WHERE d.id = old.id
      RETURNING ${META_COLUMNS.replace(/\bid,/, "d.id,")}, old.previous_name AS "previousName"`,
    [documentId, contactId, displayName],
  );
  const row = rows[0] as (ContactDocument & { previousName: string }) | undefined;
  if (!row) return null;
  const { previousName, ...document } = row;
  return { document, previousName };
}

/** An active document on this contact with these exact bytes from this source, if any. */
export async function findActiveDocumentByHash(
  contactId: number,
  source: DocumentSource,
  sha256: string,
): Promise<ContactDocument | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ${META_COLUMNS} FROM contact_documents
      WHERE contact_id = $1 AND source = $2 AND sha256 = $3 AND deleted_at IS NULL
      ORDER BY id ASC LIMIT 1`,
    [contactId, source, sha256],
  );
  return (rows[0] as ContactDocument | undefined) ?? null;
}

/**
 * Stamp documents the TherapyNotes agent confirmed on the chart.
 *
 * Scoped to the contact the callback is for, so an id belonging to another
 * contact is ignored. Never overwrites an existing stamp: the first run that
 * filed a document keeps the credit, and a later "already on the chart" report
 * changes nothing. Returns the ids actually stamped.
 */
export async function stampDocumentsUploadedToTn(
  contactId: number,
  runId: string,
  documentIds: number[],
): Promise<number[]> {
  if (documentIds.length === 0) return [];
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE contact_documents
        SET tn_uploaded_at = NOW(), tn_upload_run_id = $2
      WHERE contact_id = $1 AND id = ANY($3::int[]) AND tn_uploaded_at IS NULL
      RETURNING id`,
    [contactId, runId, documentIds],
  );
  return rows.map((r) => r.id as number);
}

// ============================================================================
// For the scheduling flow (follow-up task: pushing documents to TherapyNotes)
// ============================================================================

export interface ContactDocumentWithContent extends ContactDocument {
  content: Buffer;
}

/**
 * Every active document on a contact, WITH its bytes, in upload order (oldest
 * first; ties broken by id). Removed documents are excluded.
 *
 * Built for the TherapyNotes push that will follow; nothing calls it yet. The
 * caller is responsible for the access decision — this is a server-side
 * helper, not a route, and it does not check a session.
 */
export async function getActiveContactDocumentsWithContent(
  contactId: number,
): Promise<ContactDocumentWithContent[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ${META_COLUMNS}, content FROM contact_documents
      WHERE contact_id = $1 AND deleted_at IS NULL
      ORDER BY uploaded_at ASC, id ASC`,
    [contactId],
  );
  return rows as ContactDocumentWithContent[];
}
