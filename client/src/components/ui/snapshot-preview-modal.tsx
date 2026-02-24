/**
 * Snapshot Preview Modal
 *
 * Renders stored email HTML in a visible DOM context (identical to the
 * send-email-modal preview), then generates a PDF from the painted node.
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
  templateId: string;
  subject: string;
  bodyHtml: string;
  sentByEmail: string;
  sentAt: string;
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
  const contentRef = useRef<HTMLDivElement>(null);

  // Fetch snapshot when modal opens
  useEffect(() => {
    if (isOpen && snapshotId) {
      fetchSnapshot(snapshotId);
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

    // Validate the DOM node is actually rendered
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
      // Dynamic import — html2pdf.js is a UMD module, Vite wraps CJS as { default: ... }
      const mod = await import("html2pdf.js");
      const html2pdf = mod.default || mod;
      console.log("[snapshot-pdf] html2pdf import:", {
        modType: typeof mod,
        modDefault: typeof mod.default,
        html2pdfType: typeof html2pdf,
      });

      if (typeof html2pdf !== "function") {
        throw new Error(
          `html2pdf is not a function (got ${typeof html2pdf}). ` +
          `Module keys: ${Object.keys(mod).join(", ")}`
        );
      }

      const safeName = (snapshot.subject || "email-snapshot")
        .replace(/[^a-zA-Z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .substring(0, 60);

      // Generate PDF as blob for reliable download
      const worker = html2pdf()
        .set({
          margin: 10,
          filename: `${safeName}.pdf`,
          html2canvas: {
            scale: 2,
            useCORS: true,
            allowTaint: true,
            backgroundColor: "#ffffff",
          },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(el);

      // Try .save() first (simplest path), with blob fallback
      try {
        await worker.save();
        console.log("[snapshot-pdf] PDF saved successfully via .save()");
      } catch (saveErr) {
        console.warn("[snapshot-pdf] .save() failed, trying blob fallback:", saveErr);
        // Fallback: generate blob manually
        const pdfBlob: Blob = await worker.outputPdf("blob");
        console.log("[snapshot-pdf] Blob generated:", pdfBlob.size, "bytes");
        const blobUrl = URL.createObjectURL(pdfBlob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = `${safeName}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        console.log("[snapshot-pdf] PDF downloaded via blob fallback");
      }
    } catch (err) {
      // Log the FULL error with stack trace
      console.error("[snapshot-pdf] PDF generation failed:", err);
      console.error("[snapshot-pdf] Error name:", (err as Error)?.name);
      console.error("[snapshot-pdf] Error message:", (err as Error)?.message);
      console.error("[snapshot-pdf] Error stack:", (err as Error)?.stack);
      setError(
        `PDF generation failed: ${(err as Error)?.message || "Unknown error"}. Check browser console for details.`
      );
    } finally {
      setIsGenerating(false);
    }
  };

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
            {/* Subject line — same style as send-email-modal */}
            <div className="border rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-muted border-b">
                <span className="text-xs text-muted-foreground">Subject: </span>
                <span className="text-sm font-medium">{snapshot.subject}</span>
              </div>

              {/* Email body — visible, painted, ref'd for PDF capture.
                  Identical rendering to send-email-modal preview. */}
              <div
                ref={contentRef}
                className="p-4 bg-white text-sm"
                style={{ minHeight: 100 }}
                dangerouslySetInnerHTML={{ __html: snapshot.bodyHtml }}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              Sent: {new Date(snapshot.sentAt + "Z").toLocaleString()} by{" "}
              {snapshot.sentByEmail}
            </p>
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
