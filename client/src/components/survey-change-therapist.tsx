/**
 * "Change therapist" on a survey row (2026-10-22).
 *
 * Moves a stored survey to another therapist when the client picked the wrong
 * one. The list is the survey's own: active providers shown on the survey, one
 * entry per survey office (GET /api/survey/therapist-options). The server
 * re-checks all of it and writes one activity-log line per change
 * (server/survey/relabel.ts). Nothing changes in TherapyNotes: a survey
 * already filed keeps the old name on the chart's PDF, and the dialog says so.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface TherapistOption { providerId: number; label: string }

export interface ChangeTherapistTarget {
  id: number;
  /** The label stored on the survey now; null when the client left none. */
  current: string | null;
  /** Already filed to a TherapyNotes chart. */
  filed: boolean;
}

export function SurveyChangeTherapistDialog({
  target,
  onClose,
}: {
  target: ChangeTherapistTarget | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [choice, setChoice] = useState("");
  useEffect(() => setChoice(""), [target?.id]);

  const { data, isLoading } = useQuery<{ options: TherapistOption[] }>({
    queryKey: ["/api/survey/therapist-options"],
    queryFn: async () => {
      const res = await fetch("/api/survey/therapist-options");
      if (!res.ok) throw new Error("Could not load the therapist list.");
      return res.json();
    },
    enabled: target !== null,
    staleTime: 0,
  });
  const options = (data?.options ?? []).filter((o) => o.label !== target?.current);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/survey/submissions/${target!.id}/therapist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: choice, from: target!.current }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "The therapist could not be changed.");
      return json as { submissionId: number; to: string; filedToChart: boolean };
    },
    onSuccess: (r) => {
      toast({
        title: "Therapist changed",
        description: r.filedToChart
          ? `Survey #${r.submissionId} now shows ${r.to}. It was already filed to a TherapyNotes chart; the PDF there still names the old therapist.`
          : `Survey #${r.submissionId} now shows ${r.to}.`,
      });
      qc.invalidateQueries({ queryKey: ["/api/submissions"] });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Not changed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Change therapist on survey #{target?.id}</DialogTitle>
          <DialogDescription>
            Now: {target?.current || "none given"}. The survey moves to the new therapist and their office in
            Submissions, the snapshot and the export. Only therapists offered on the survey are listed.
            {target?.filed && " This survey is already filed to a TherapyNotes chart; the PDF there will still name the old therapist."}
          </DialogDescription>
        </DialogHeader>
        <Select value={choice} onValueChange={setChoice} disabled={isLoading || mutation.isPending}>
          <SelectTrigger data-testid="select-change-therapist">
            <SelectValue placeholder={isLoading ? "Loading…" : "Pick a therapist"} />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.label} value={o.label}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!choice || mutation.isPending}
            data-testid="button-confirm-change-therapist"
          >
            {mutation.isPending ? "Saving…" : "Change therapist"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
