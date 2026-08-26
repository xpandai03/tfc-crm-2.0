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
import { Badge } from "@/components/ui/badge";
import { Loader2, ExternalLink, Code2, FileText, Inbox, FileUp } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { canAccessReferralUpload } from "@shared/access-control";

interface FormSubmission {
  id: number;
  createdAt: string;
  source: string;
  formType: string;
  submittedAt: string | null;
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

function getSourceLabel(source: string): { label: string; variant: "secondary" | "default" | "outline" } {
  switch (source) {
    case "rfs_v2":
      return { label: "RFS Form", variant: "default" };
    case "rfs_legacy":
    case "rfs":
      return { label: "RFS (Legacy)", variant: "secondary" };
    case "consent_form_v1":
      return { label: "Consent", variant: "secondary" };
    case "feedback_form_v1":
      return { label: "Feedback", variant: "outline" };
    default:
      return { label: source || "Unknown", variant: "outline" };
  }
}

function getFormTypeBadge(formType: string): { label: string; variant: "secondary" | "default" | "outline" } {
  switch (formType) {
    case "intake":
      return { label: "Intake", variant: "default" };
    case "Consent":
      return { label: "Consent", variant: "secondary" };
    case "Feedback":
      return { label: "Feedback", variant: "outline" };
    default:
      return { label: formType || "Unknown", variant: "outline" };
  }
}

/** Extract a human-readable summary from submission payload based on form type. */
function getSubmissionSummary(sub: FormSubmission): { title: string; subtitle: string; meta: string } {
  const p = sub.payload;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");

  // Consent forms
  if (sub.formType === "Consent" || sub.source === "consent_form_v1") {
    const patient = s(p.patientName) || s(p.name) || sub.name;
    const consentType = s(p.formType) || s(p.consentType) || "Consent";
    const label = consentType.toLowerCase().includes("consent") ? consentType : `${consentType} Consent`;

    let secondary = "";
    if (Array.isArray(p.familyMembers) && p.familyMembers.length > 0) {
      const names = p.familyMembers.map((m: unknown) =>
        typeof m === "object" && m && "name" in m ? String((m as Record<string, unknown>).name) : String(m)
      ).filter(Boolean);
      if (names.length) secondary = `With: ${names.join(", ")}`;
    } else if (s(p.partnerName)) {
      secondary = `With partner: ${s(p.partnerName)}`;
    }

    return { title: patient || "Unknown Patient", subtitle: label, meta: secondary };
  }

  // Feedback forms
  if (sub.formType === "Feedback" || sub.source === "feedback_form_v1") {
    const who = s(p.name) || s(p.submitterName) || sub.name;
    const feedbackType = s(p.feedbackType) || s(p.type) || "General Feedback";
    const comment = s(p.comment) || s(p.feedback) || "";
    return {
      title: who || "Anonymous",
      subtitle: feedbackType,
      meta: comment ? (comment.length > 80 ? comment.slice(0, 80) + "…" : comment) : "",
    };
  }

  // Intake / RFS forms (existing behavior, enhanced)
  if (sub.formType === "intake" || sub.source === "rfs_v2" || sub.source === "rfs" || sub.source === "rfs_legacy") {
    const who = s(p.name) || sub.name;
    const parts: string[] = [];

    const requesting = s(p.requestingFor);
    if (requesting) parts.push(requesting);

    const therapy = Array.isArray(p.reasonForTherapy)
      ? p.reasonForTherapy.join(", ")
      : s(p.reasonForTherapy);
    if (therapy) parts.push(therapy);

    const insurance = s(p.insurancePayer);
    if (insurance) parts.push(insurance);

    const modality = s(p.modality);
    if (modality) parts.push(modality);

    return {
      title: who || "Unknown",
      subtitle: parts.join(" · ") || "Intake submission",
      meta: "",
    };
  }

  // Generic fallback
  const who = s(p.patientName) || s(p.name) || sub.name;
  return {
    title: who || sub.formType || "Submission",
    subtitle: who ? `${sub.formType} submission` : "Submission received",
    meta: "",
  };
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
            Raw Submission — {submission.name || submission.formType}
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
  const { user } = useAuth();
  const [selectedSubmission, setSelectedSubmission] = useState<FormSubmission | null>(null);

  const { data, isLoading } = useQuery<{ submissions: FormSubmission[] }>({
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
              All form submissions · Newest first
            </p>
          </div>

          {/*
            Entry point for the fax-referral upload, which no longer has its own
            nav tab. This NAVIGATES to /referral — the page, its components and
            its flow are unchanged.

            Conditionally rendered on the SAME predicate that gates the page and
            the nav entry did. Submissions is reachable by any authenticated
            user while referral upload is a five-person allow-list, so an
            unconditional button would send most staff to a page that
            immediately redirects them away.

            Cosmetic, like every client-side gate here: the real boundary is the
            403 on POST /api/referral/extract.
          */}
          {canAccessReferralUpload(user?.email) && (
            <Link href="/referral">
              <Button variant="outline" size="sm" className="gap-2" data-testid="button-referral-upload">
                <FileUp className="h-4 w-4" />
                Upload Referral
              </Button>
            </Link>
          )}
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
              Submissions will appear here as forms are received.
            </p>
          </div>
        )}

        {/* Submission list */}
        {!isLoading && submissions.length > 0 && (
          <div className="space-y-3">
            {submissions.map((sub) => {
              const summary = getSubmissionSummary(sub);
              const srcBadge = getSourceLabel(sub.source);
              const typeBadge = getFormTypeBadge(sub.formType);

              return (
                <Card key={sub.id} className="overflow-hidden">
                  <CardContent className="px-4 py-3 space-y-1.5">
                    {/* Top row: title + badges + timestamp */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <span className="font-medium text-sm truncate">{summary.title}</span>
                        <Badge variant={typeBadge.variant} className="text-[10px] px-1.5 py-0 shrink-0">
                          {typeBadge.label}
                        </Badge>
                        <Badge variant={srcBadge.variant} className="text-[10px] px-1.5 py-0 shrink-0">
                          {srcBadge.label}
                        </Badge>
                      </div>
                      <span
                        className="text-xs text-muted-foreground flex-shrink-0 tabular-nums"
                        title={formatExactTime(sub.createdAt)}
                      >
                        {formatRelativeTime(sub.createdAt)}
                      </span>
                    </div>

                    {/* Summary */}
                    <p className="text-xs text-muted-foreground pl-6 line-clamp-2">
                      {summary.subtitle}
                    </p>

                    {/* Optional meta line */}
                    {summary.meta && (
                      <p className="text-xs text-muted-foreground/70 pl-6 line-clamp-1 italic">
                        {summary.meta}
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
              );
            })}

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
