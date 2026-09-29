/**
 * Contact documents on their way to TherapyNotes — what the CRM sends with an
 * Add to Schedule run, and what it stamps when the agent reports back.
 *
 * Pure. The route in server/routes.ts reads the documents, calls
 * buildTnDocumentList, and puts the result on the agent payload; the
 * tn-progress callback calls documentIdsToStamp on what the agent reported.
 *
 * THE NAME IS THE DEDUPLICATION KEY. Before it uploads, the agent looks for a
 * document with exactly this name on the chart and skips it if it is there
 * (services/api/tn_executor_v2.py, _document_on_chart). So each document's
 * TherapyNotes name must be unique on the chart and stable across runs:
 *   "<display name> (CRM)"      for the first document with that display name
 *   "<display name> (CRM 2)"... for later ones, counted in upload order across
 *                               ALL active documents (stamped or not), so a
 *                               document keeps its number on every run.
 * TherapyNotes' name field is maxlength=128; the display name is trimmed to fit
 * and the suffix is always kept.
 */

import type { ContactDocument, DocumentMimeType } from "@shared/contact-documents";

export const TN_DOCUMENT_NAME_MAX = 128;

/** One document as the agent's TNDocumentV2 schema takes it. */
export interface TnDocumentPayload {
  crm_document_id: number;
  tn_name: string;
  mime_type: DocumentMimeType;
  url: string;
}

const uploadOrder = (a: ContactDocument, b: ContactDocument) =>
  new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime() || a.id - b.id;

/** The TherapyNotes name for `doc`, unique among `allActive` (see header). */
export function tnDocumentName(doc: ContactDocument, allActive: ContactDocument[]): string {
  const key = doc.displayName.trim();
  const same = allActive.filter((d) => d.displayName.trim() === key).sort(uploadOrder);
  const n = same.findIndex((d) => d.id === doc.id) + 1;
  const suffix = n <= 1 ? " (CRM)" : ` (CRM ${n})`;
  const room = TN_DOCUMENT_NAME_MAX - suffix.length;
  const base = key.length > room ? key.slice(0, room).trimEnd() : key;
  return `${base || "Document"}${suffix}`;
}

/** Fax referral first, then everything else by upload time (ties by id). */
export function tnFilingOrder(docs: ContactDocument[]): ContactDocument[] {
  return [...docs].sort((a, b) => {
    const fa = a.source === "fax_referral" ? 0 : 1;
    const fb = b.source === "fax_referral" ? 0 : 1;
    return fa - fb || uploadOrder(a, b);
  });
}

/**
 * What to send: the contact's active documents NOT yet stamped as filed, in
 * filing order, each with its unique name and the agent-only fetch URL.
 * `allActive` is every active document on the contact (stamped or not) — the
 * stamped ones are not sent but still count for naming.
 */
export function buildTnDocumentList(
  allActive: ContactDocument[],
  contactId: number,
  baseUrl: string,
): TnDocumentPayload[] {
  const base = baseUrl.replace(/\/$/, "");
  return tnFilingOrder(allActive.filter((d) => !d.tnUploadedAt)).map((d) => ({
    crm_document_id: d.id,
    tn_name: tnDocumentName(d, allActive),
    mime_type: d.mimeType,
    url: `${base}/api/internal/contact-document/${contactId}/${d.id}`,
  }));
}

/**
 * The document ids to stamp from an agent callback's metadata
 * (`documentsUploaded`: every document confirmed on the chart, whether this run
 * filed it or found it already there). Positive integers only; anything else
 * is ignored rather than trusted.
 */
export function documentIdsToStamp(metadata: Record<string, unknown> | null | undefined): number[] {
  const raw = metadata?.documentsUploaded;
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0);
  return ids.filter((v, i) => ids.indexOf(v) === i).slice(0, 100);
}
