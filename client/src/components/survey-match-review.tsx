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

interface ContactIdentity {
  contactId: number;
  name: string;
  email: string | null;
  patientDob: string | null;
}

interface ReviewPayload {
  submissionId: number;
  submittedAt: string;
  typed: { name: string; dateOfBirth: string | null; email: string | null };
  modality: string | null;
  therapist: string | null;
  state: { status: string; reason: string; resolvedBy: string | null; resolvedAt: string | null } | null;
  candidates: ContactIdentity[];
}

/** Reason codes the matcher stores -> what a staff member should read.
 *  Human resolutions store a sentence already, so anything unrecognised is
 *  passed through unchanged. Mirrors REASON_LABEL in server/survey/matching.ts. */
const REASON_TEXT: Record<string, string> = {
  name_dob_email: "Matched on name, date of birth and email",
  name_dob: "Matched on name and date of birth",
  unparseable_dob: "The date of birth could not be read",
  no_candidates: "No contact matched on both name and date of birth",
  multiple_candidates: "More than one contact matched — too ambiguous to choose",
  email_contradiction: "The email address belongs to a different contact than the name and date of birth point to",
};

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-muted-foreground w-28 shrink-0">{label}</span>
      <span className="font-medium">{value || <span className="text-muted-foreground italic">not given</span>}</span>
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
              <Field label="Name" value={data.typed.name} />
              <Field label="Date of birth" value={data.typed.dateOfBirth} />
              <Field label="Email" value={data.typed.email} />
              <Field label="Therapist" value={data.therapist} />
              <Field label="Modality" value={data.modality} />
            </div>

            {data.state && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{REASON_TEXT[data.state.reason] ?? data.state.reason}</span>
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
                        <div className="text-xs text-muted-foreground mt-1">
                          DOB {c.patientDob || "—"} · {c.email || "no email"}
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
