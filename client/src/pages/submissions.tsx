import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useState } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, RefreshCw, ExternalLink, Code2, FileText, Inbox } from "lucide-react";

interface FormSubmission {
  id: number;
  createdAt: string;
  source: string;
  contactId: number | null;
  name: string;
  payload: Record<string, unknown>;
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso + "Z");
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatExactTime(iso: string): string {
  return new Date(iso + "Z").toLocaleString();
}

function buildSummary(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  const requesting = s(payload.requestingFor);
  if (requesting) parts.push(requesting);

  const therapy = Array.isArray(payload.reasonForTherapy)
    ? payload.reasonForTherapy.join(", ")
    : s(payload.reasonForTherapy);
  if (therapy) parts.push(therapy);

  const insurance = s(payload.insurancePayer);
  if (insurance) parts.push(insurance);

  return parts.join(" · ") || "No summary available";
}

function RawPayloadModal({
  isOpen,
  onClose,
  submission,
}: {
  isOpen: boolean;
  onClose: () => void;
  submission: FormSubmission | null;
}) {
  if (!submission) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[640px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Code2 className="h-4 w-4" />
            Raw Submission — {submission.name}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Submitted {formatExactTime(submission.createdAt)} · Source: {submission.source.toUpperCase()}
          </p>
        </DialogHeader>
        <ScrollArea className="flex-1 min-h-0 max-h-[60vh]">
          <pre className="text-xs font-mono bg-muted/50 rounded-md p-4 whitespace-pre-wrap break-words">
            {JSON.stringify(submission.payload, null, 2)}
          </pre>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Submissions() {
  const [selectedSubmission, setSelectedSubmission] = useState<FormSubmission | null>(null);

  const { data, isLoading, refetch, isRefetching } = useQuery<{ submissions: FormSubmission[] }>({
    queryKey: ["/api/submissions"],
    queryFn: async () => {
      const res = await fetch("/api/submissions");
      if (!res.ok) throw new Error("Failed to fetch submissions");
      return res.json();
    },
  });

  const submissions = data?.submissions ?? [];

  return (
    <PageLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Submissions</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Intake form submissions · Newest first
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRefetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Loading submissions...</p>
          </div>
        )}

        {/* Empty */}
        {!isLoading && submissions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Inbox className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <p className="text-sm font-medium text-foreground">No submissions yet</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Submissions will appear here as intake forms are received.
            </p>
          </div>
        )}

        {/* Submission list */}
        {!isLoading && submissions.length > 0 && (
          <div className="space-y-3">
            {submissions.map((sub) => (
              <Card key={sub.id} className="overflow-hidden">
                <CardContent className="px-4 py-3 space-y-2">
                  {/* Top row: name + timestamp */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="font-medium text-sm truncate">{sub.name}</span>
                    </div>
                    <span
                      className="text-xs text-muted-foreground flex-shrink-0 tabular-nums"
                      title={formatExactTime(sub.createdAt)}
                    >
                      {formatRelativeTime(sub.createdAt)}
                    </span>
                  </div>

                  {/* Summary line */}
                  <p className="text-xs text-muted-foreground pl-6 line-clamp-2">
                    {buildSummary(sub.payload)}
                  </p>

                  {/* Modality if present */}
                  {typeof sub.payload.modality === "string" && sub.payload.modality.trim() && (
                    <p className="text-xs text-muted-foreground pl-6">
                      {String(sub.payload.modality)}
                    </p>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-2 pl-6 pt-1">
                    {sub.contactId && (
                      <Link href={`/contact/${sub.contactId}`}>
                        <Button variant="outline" size="sm" className="h-7 text-xs">
                          <ExternalLink className="h-3 w-3 mr-1" />
                          View Contact
                        </Button>
                      </Link>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setSelectedSubmission(sub)}
                    >
                      <Code2 className="h-3 w-3 mr-1" />
                      View Raw
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}

            <p className="text-xs text-muted-foreground text-center pt-2">
              Showing {submissions.length} submission{submissions.length !== 1 ? "s" : ""}
            </p>
          </div>
        )}
      </div>

      {/* Raw payload modal */}
      <RawPayloadModal
        isOpen={selectedSubmission !== null}
        onClose={() => setSelectedSubmission(null)}
        submission={selectedSubmission}
      />
    </PageLayout>
  );
}
