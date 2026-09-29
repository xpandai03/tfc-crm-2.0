/**
 * Contact documents — the rules both the Documents card and the server read.
 *
 * Files staff keep against a contact (custody orders, VA referrals, the fax
 * referral a contact was created from). Stored in Postgres, in the
 * contact_documents table (server/documents/db.ts); never in the contact's
 * JSON payload, never on the container filesystem, never behind a public path.
 *
 * The server does not trust the browser's word for a file's type: it reads the
 * first bytes (sniffDocumentType below) and stores the type it found. A file
 * whose bytes are not a PDF, JPEG or PNG is refused whatever it is called.
 *
 * IMPORTS: none. Read by the server and by the CRM client.
 */

/** Staff uploads. Checked in the browser for a clear message, and enforced by the server. */
export const DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;

/**
 * The fax referral a contact was created from. The referral extractor already
 * accepts PDFs up to 20 MB (server/routes.ts, /api/referral/extract), so the
 * copy kept on the contact uses the same ceiling: every referral that could be
 * read can also be kept.
 */
export const FAX_REFERRAL_MAX_BYTES = 20 * 1024 * 1024;

export const DOCUMENT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type DocumentMimeType = typeof DOCUMENT_MIME_TYPES[number];

/** What the file picker offers. The server decides by content, not by this. */
export const DOCUMENT_ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

export const DOCUMENT_TYPE_LABEL: Record<DocumentMimeType, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPG",
  "image/png": "PNG",
};

/**
 * Where a document came from. Set by the SERVER per route, never taken from the
 * request: a staff upload is always staff_upload, and only the fax-referral
 * route can write fax_referral. intake_pdf is reserved: the intake PDF is still
 * generated on demand from the contact and is not stored here.
 */
export const DOCUMENT_SOURCES = ["staff_upload", "fax_referral", "intake_pdf"] as const;
export type DocumentSource = typeof DOCUMENT_SOURCES[number];

export const DOCUMENT_NAME_MAX = 200;

/** Metadata only — what the list and the card carry. Never the bytes. */
export interface ContactDocument {
  id: number;
  contactId: number;
  displayName: string;
  originalFilename: string;
  mimeType: DocumentMimeType;
  sizeBytes: number;
  source: DocumentSource;
  uploadedByEmail: string;
  uploadedByName: string | null;
  uploadedAt: string;
  /**
   * When the TherapyNotes agent confirmed this document on the patient's chart
   * (the "In TN" marker). NULL = not filed yet; only NULL documents are sent on
   * the next Add to Schedule run.
   */
  tnUploadedAt: string | null;
}

/**
 * The type a file's bytes say it is, or null. PDF files start "%PDF-", JPEG
 * with FF D8 FF, PNG with its 8-byte signature.
 */
export function sniffDocumentType(bytes: Uint8Array): DocumentMimeType | null {
  const b = bytes;
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) {
    return "application/pdf";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

/** The default document name: the file's own name without its extension. */
export function defaultDocumentName(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, "").trim();
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return (stem.trim() || "Document").slice(0, DOCUMENT_NAME_MAX);
}

/** "340 KB", "2.4 MB". */
export function formatDocumentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The message for a file over a limit, shown before and after upload. */
export function tooLargeMessage(maxBytes: number): string {
  return `That file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB. Please upload a smaller file or scan at a lower resolution.`;
}
