/**
 * Snapshot Preview Modal
 *
 * Renders stored email HTML in a visible DOM context (identical to the
 * send-email-modal preview), then generates a PDF from the painted node.
 *
 * This solves the blank-PDF problem: html2canvas needs visible, painted
 * content — hidden/offscreen containers produce empty captures.
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

    const rect = contentRef.current.getBoundingClientRect();
    console.log("[snapshot-modal] Content dimensions:", {
      width: rect.width,
      height: rect.height,
    });

    if (rect.height === 0) {
      setError("Content has zero height — cannot generate PDF");
      return;
    }

    setIsGenerating(true);
    try {
      const html2pdf = (await import("html2pdf.js")).default;

      const safeName = (snapshot.subject || "email-snapshot")
        .replace(/[^a-zA-Z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .substring(0, 60);

      await html2pdf()
        .set({
          margin: 10,
          filename: `${safeName}.pdf`,
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(contentRef.current)
        .save();
    } catch (err) {
      console.error("[snapshot-modal] PDF generation failed:", err);
      setError("Failed to generate PDF");
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
          <div className="text-sm text-destructive py-4">{error}</div>
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
