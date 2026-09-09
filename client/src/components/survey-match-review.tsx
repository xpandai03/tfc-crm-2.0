/**
 * Survey identity review — the human-in-the-loop step.
 *
 * WHAT THIS DELIBERATELY DOES NOT SHOW: any survey answer. No scores, no
 * comments, no explanations, no follow-up flag. The decision in front of the
 * reviewer is "who is this person", and what they said about their session is
 * not evidence for it. The endpoint backing this dialog returns identity fields
 * only (server/routes.ts, GET /api/survey/matching/review/:submissionId), so
 * the answers are not merely hidden — they never reach the browser.
 *
 * Confirming is always an explicit action on a NAMED contact, or an explicit
 * "no matching contact". There is no "close enough" affordance and no
 * pre-selected default.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, UserCheck, UserX, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { failedFieldFor, reasonText } from "@shared/survey-match-reasons";

interface ContactIdentity {
  contactId: number;
  name: string;
  email: string | null;
  phone: string | null;
  patientDob: string | null;
  /** Most recent provider assignment. The couples discriminator. */
  assignedProvider: string | null;
}

interface ReviewPayload {
  submissionId: number;
  submittedAt: string;
  typed: {
    name: string;
    dateOfBirth: string | null;
    /** Collected from 2026-09-03; null on submissions taken before that. */
    phone: string | null;
    email: string | null;
  };
  modality: string | null;
  therapist: string | null;
  state: { status: string; reason: string; resolvedBy: string | null; resolvedAt: string | null } | null;
  candidates: ContactIdentity[];
}

// Reason text comes from @shared/survey-match-reasons — the SAME map the
// matcher and the submissions list read. This file used to keep its own copy
// and so did the list, and the two had already drifted in wording; six new
// codes would have made that three places to remember. reasonText() passes a
// human resolution's own sentence through unchanged.

/**
 * One typed identity field.
 *
 * `flagged` marks the field the matcher says decided the outcome — the
 * machine-readable half of "say why it threw the error". A reviewer opening a
 * row should not have to read a sentence and then work out which of five boxes
 * it is talking about.
 */
function Field({
  label, value, flagged,
}: { label: string; value: string | null; flagged?: boolean }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className={`w-28 shrink-0 ${flagged ? "text-amber-700 font-medium" : "text-muted-foreground"}`}>
        {label}
      </span>
      <span className={`font-medium ${flagged ? "text-amber-800" : ""}`}>
        {value || <span className="text-muted-foreground italic">not given</span>}
      </span>
    </div>
  );
}

export function SurveyMatchReviewDialog({
  submissionId,
  onClose,
}: {
  submissionId: number | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<number | null>(null);

  const { data, isLoading } = useQuery<ReviewPayload>({
    queryKey: ["/api/survey/matching/review", submissionId],
    enabled: submissionId !== null,
    queryFn: async () => {
      const res = await fetch(`/api/survey/matching/review/${submissionId}`);
      if (!res.ok) throw new Error("Failed to load the review");
      return res.json();
    },
  });

  const resolve = useMutation({
    mutationFn: async (contactId: number | null) => {
      const res = await fetch("/api/survey/matching/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId, contactId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not save that decision");
      return json;
    },
    onSuccess: (_d, contactId) => {
      toast({
        title: contactId === null ? "Marked as no contact" : "Survey matched",
        description:
          contactId === null
            ? "This response is recorded as having no contact record."
            : "The survey is now linked to that contact.",
      });
      qc.invalidateQueries({ queryKey: ["/api/survey/matching/states"] });
      qc.invalidateQueries({ queryKey: ["/api/submissions"] });
      setChosen(null);
      onClose();
    },
    onError: (e: Error) => {
      toast({ title: "Could not save", description: e.message, variant: "destructive" });
    },
  });

  const busy = resolve.isPending;
  // Only highlight a field on a row that is actually awaiting a decision — on a
  // matched row the same code names what the match RESTED on, and colouring
  // that amber would read as a problem.
  const failed =
    data?.state && data.state.status === "review" ? failedFieldFor(data.state.reason) : null;

  return (
    <Dialog open={submissionId !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-[620px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Who is this survey from?</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Identity only. Survey answers are not shown here and are not part of this decision.
          </p>
        </DialogHeader>

        {isLoading && (
          <div className="py-10 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {data && (
          <div className="space-y-5">
            {/* What the client typed */}
            <div className="rounded-md border p-3 space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                What the client typed
              </p>
              <Field label="Legal name" value={data.typed.name} flagged={failed === "name"} />
              <Field label="Date of birth" value={data.typed.dateOfBirth} flagged={failed === "dateOfBirth"} />
              <Field label="Phone" value={data.typed.phone} flagged={failed === "phone"} />
              <Field label="Email" value={data.typed.email} flagged={failed === "email"} />
              <Field label="Therapist" value={data.therapist} flagged={failed === "provider"} />
              <Field label="Modality" value={data.modality} />
            </div>

            {data.state && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{reasonText(data.state.reason)}</span>
              </div>
            )}

            {/* Candidates */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {data.candidates.length > 0
                  ? `Possible contacts (${data.candidates.length})`
                  : "Possible contacts"}
              </p>
              {data.candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3">
                  No contact came close on name or date of birth. If you know who this is,
                  find them on the Waitlist and note the contact ID, or mark this as having
                  no contact.
                </p>
              ) : (
                <div className="space-y-2">
                  {data.candidates.map((c) => {
                    const selected = chosen === c.contactId;
                    return (
                      <button
                        key={c.contactId}
                        type="button"
                        disabled={busy}
                        onClick={() => setChosen(selected ? null : c.contactId)}
                        className={`w-full text-left rounded-md border p-3 transition-colors ${
                          selected ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                        }`}
                        data-testid={`candidate-${c.contactId}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">{c.name}</span>
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            #{c.contactId}
                          </Badge>
                        </div>
                        {/* Identity only. The assigned provider is here because
                            it is the field that separates a couple recorded
                            under one account — when the automatic tiebreak
                            declined, this is what a reviewer decides on. */}
                        <div className="text-xs text-muted-foreground mt-1">
                          DOB {c.patientDob || "—"} · {c.phone || "no phone"} · {c.email || "no email"}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          Provider: {c.assignedProvider || "none assigned"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => resolve.mutate(null)}
            data-testid="button-no-contact"
          >
            <UserX className="h-3.5 w-3.5 mr-1.5" />
            No matching contact
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            {/* Enabled only once a specific contact is selected — there is no
                "close enough" path to a match. */}
            <Button
              size="sm"
              disabled={busy || chosen === null}
              onClick={() => chosen !== null && resolve.mutate(chosen)}
              data-testid="button-confirm-match"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <UserCheck className="h-3.5 w-3.5 mr-1.5" />
              )}
              {chosen === null ? "Select a contact" : `Confirm #${chosen}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
