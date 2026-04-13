/**
 * Snapshot Preview Modal
 *
 * Renders stored email HTML in a visible DOM context (identical to the
 * send-email-modal preview), then generates a PDF from the painted node.
 * PDF output prepends a branded metadata header (TFC logo + From/To/Subject/Sent).
 */

import { useState, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Loader2, X } from "lucide-react";

interface SnapshotPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  snapshotId: number | null;
}

interface SnapshotData {
  id: number;
  contactId: number;
  templateId: string;
  subject: string;
  bodyHtml: string;
  sentByEmail: string;
  senderEmail: string | null;
  recipientEmail: string | null;
  ccEmails: string | string[];
  sentAt: string;
}

const DEFAULT_SENDER_EMAIL = "no-reply@hipaacheck.ai";

/**
 * Parse a Postgres-serialized timestamp. The column was originally TIMESTAMPTZ
 * but is now reported as TEXT in information_schema, so values may arrive as
 * "2026-04-13 23:14:07.190572+00" (space separator, two-digit UTC offset) —
 * not strict ISO 8601. Normalize before passing to Date().
 */
function parseSentAt(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  // Convert "YYYY-MM-DD HH:MM:SS.ffffff+00" → "YYYY-MM-DDTHH:MM:SS.ffffff+00:00"
  let normalized = raw.replace(" ", "T");
  normalized = normalized.replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(normalized);
  if (!isNaN(d.getTime())) return d;
  // Fallback: append Z if tz completely missing
  const fallback = new Date(raw + "Z");
  return isNaN(fallback.getTime()) ? null : fallback;
}

function parseCcEmails(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Fetch a same-origin image and return it as a base64 data URI.
 * Guarantees the image renders in html2canvas without CORS/tainting issues.
 */
async function imageUrlToDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.warn("[snapshot-pdf] Logo fetch failed, falling back to URL:", err);
    return null;
  }
}

export function SnapshotPreviewModal({
  isOpen,
  onClose,
  snapshotId,
}: SnapshotPreviewModalProps) {
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoDataUri, setLogoDataUri] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Fetch snapshot when modal opens
  useEffect(() => {
    if (isOpen && snapshotId) {
      fetchSnapshot(snapshotId);
      // Preload logo as data URI so html2canvas never sees a network request
      imageUrlToDataUri("/tfc-logo.jpg").then(setLogoDataUri);
    }
    if (!isOpen) {
      setSnapshot(null);
      setError(null);
    }
  }, [isOpen, snapshotId]);

  const fetchSnapshot = async (id: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/email-snapshot/${id}`);
      if (!res.ok) throw new Error("Failed to fetch snapshot");
      const data = await res.json();
      setSnapshot(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load snapshot");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!contentRef.current || !snapshot) return;

    const el = contentRef.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    console.log("[snapshot-pdf] DOM node check:", { w, h, childCount: el.childElementCount });

    if (w === 0 || h === 0) {
      const msg = `Content has zero dimensions (${w}x${h}) — cannot generate PDF`;
      console.error("[snapshot-pdf]", msg);
      setError(msg);
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      const mod = await import("html2pdf.js");
      const html2pdf = mod.default || mod;

      if (typeof html2pdf !== "function") {
        throw new Error(
          `html2pdf is not a function (got ${typeof html2pdf}). Module keys: ${Object.keys(mod).join(", ")}`
        );
      }

      const sentDateForFilename = parseSentAt(snapshot.sentAt) ?? new Date();
      const dateStr = sentDateForFilename.toISOString().split("T")[0];
      const filename = `email-snapshot-${snapshot.templateId}-${snapshot.contactId}-${dateStr}.pdf`;

      const worker = html2pdf()
        .set({
          margin: 10,
          filename,
          html2canvas: {
            scale: 2,
            useCORS: true,
            allowTaint: true,
            backgroundColor: "#ffffff",
          },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(el);

      try {
        await worker.save();
        console.log("[snapshot-pdf] PDF saved successfully via .save()");
      } catch (saveErr) {
        console.warn("[snapshot-pdf] .save() failed, trying blob fallback:", saveErr);
        const pdfBlob: Blob = await worker.outputPdf("blob");
        const blobUrl = URL.createObjectURL(pdfBlob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        console.log("[snapshot-pdf] PDF downloaded via blob fallback");
      }
    } catch (err) {
      console.error("[snapshot-pdf] PDF generation failed:", err);
      setError(
        `PDF generation failed: ${(err as Error)?.message || "Unknown error"}. Check browser console for details.`
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const ccList = snapshot ? parseCcEmails(snapshot.ccEmails) : [];
  const fromLabel = snapshot?.senderEmail || DEFAULT_SENDER_EMAIL;
  const toLabel = snapshot?.recipientEmail || "—";
  const ccLabel = ccList.join(", ");
  const sentDate = snapshot ? parseSentAt(snapshot.sentAt) : null;
  const sentLabel = sentDate
    ? sentDate.toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : "";
  const logoSrc = logoDataUri ?? "/tfc-logo.jpg";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Email Snapshot</DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading snapshot...
            </span>
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive py-2 px-3 bg-destructive/10 rounded">
            {error}
          </div>
        )}

        {snapshot && !isLoading && (
          <div className="space-y-3">
            {/* Captured region: metadata header + email body.
                Everything inside contentRef is rendered into the PDF. */}
            <div className="border rounded-lg overflow-hidden bg-white">
              <div ref={contentRef} className="bg-white text-sm">
                {/* Branded metadata header */}
                <div
                  style={{
                    fontFamily: "Arial, sans-serif",
                    padding: "24px 32px",
                    borderBottom: "2px solid #e5e7eb",
                    marginBottom: 0,
                    background: "#ffffff",
                  }}
                >
                  <img
                    src={logoSrc}
                    alt="The Family Connection"
                    style={{ height: 48, marginBottom: 16, display: "block" }}
                    crossOrigin="anonymous"
                  />
                  <table
                    style={{
                      width: "100%",
                      fontSize: 13,
                      color: "#374151",
                      borderCollapse: "collapse",
                    }}
                  >
                    <tbody>
                      <tr>
                        <td style={{ padding: "4px 0", fontWeight: 600, width: 120 }}>From:</td>
                        <td style={{ padding: "4px 0" }}>{fromLabel}</td>
                      </tr>
                      <tr>
                        <td style={{ padding: "4px 0", fontWeight: 600 }}>To:</td>
                        <td style={{ padding: "4px 0" }}>{toLabel}</td>
                      </tr>
                      {ccLabel && (
                        <tr>
                          <td style={{ padding: "4px 0", fontWeight: 600 }}>CC:</td>
                          <td style={{ padding: "4px 0" }}>{ccLabel}</td>
                        </tr>
                      )}
                      <tr>
                        <td style={{ padding: "4px 0", fontWeight: 600 }}>Subject:</td>
                        <td style={{ padding: "4px 0" }}>{snapshot.subject}</td>
                      </tr>
                      <tr>
                        <td style={{ padding: "4px 0", fontWeight: 600 }}>Sent:</td>
                        <td style={{ padding: "4px 0" }}>{sentLabel}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Email body — exactly as the client received it */}
                <div
                  className="p-4"
                  style={{ minHeight: 100 }}
                  dangerouslySetInnerHTML={{ __html: snapshot.bodyHtml }}
                />
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            <X className="h-4 w-4 mr-2" />
            Close
          </Button>
          <Button
            onClick={handleDownloadPdf}
            disabled={!snapshot || isLoading || isGenerating}
            className="bg-violet-600 hover:bg-violet-700 text-white"
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating PDF...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Download PDF
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
