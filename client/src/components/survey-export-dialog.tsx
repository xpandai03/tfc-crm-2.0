/**
 * Client survey export — range picker and download.
 *
 * Deliberately the same shape as report-builder-modal.tsx: two date inputs, a
 * validity check, one busy flag that both disables the control and labels it,
 * and a blob download. A second range-selection pattern would be a second thing
 * to learn for no gain.
 *
 * It lives on the Submissions page rather than in a tab of its own. The client
 * has asked repeatedly for fewer tabs, which is the same reason the survey
 * review queue sits on that page.
 */
import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Download, Loader2, SlidersHorizontal } from "lucide-react";
import { ActiveCountOverrides } from "@/components/active-count-overrides";
import { useToast } from "@/hooks/use-toast";

/** The calendar quarter we are in, which is what the client reports on. */
function currentQuarter(now: Date = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const startMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: iso(new Date(Date.UTC(y, startMonth, 1))),
    to: iso(new Date(Date.UTC(y, startMonth + 3, 0))),
  };
}

export function SurveyExportDialog({
  open, onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const quarter = currentQuarter();
  const [from, setFrom] = useState(quarter.from);
  const [to, setTo] = useState(quarter.to);
  const [busy, setBusy] = useState(false);
  // Collapsed by default. Most exports use the pulled figures unchanged, and a
  // panel of 26 editable numbers is not what the Export button is for.
  const [showCounts, setShowCounts] = useState(false);
  const { toast } = useToast();

  const rangeValid = Boolean(from) && Boolean(to) && from <= to;

  async function download() {
    // The double-click guard. `busy` also disables the button, but a disabled
    // button is a rendering detail and this is the thing that actually prevents
    // a second build starting.
    if (!rangeValid || busy) return;
    setBusy(true);
    try {
      const qs = new URLSearchParams({ from, to });
      const res = await fetch(`/api/export/survey-workbook.xlsx?${qs.toString()}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        let msg = res.status === 401
          ? "Your session has expired. Please sign in again."
          : `The export could not be built (${res.status}).`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch { /* not a JSON body */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `TFC-Client-Survey-${from}_to_${to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Export failed",
        description: e instanceof Error ? e.message : "The survey export could not be built.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className={showCounts ? "sm:max-w-lg" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>Export survey workbook</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            One sheet per provider, plus the analysis, ratings and neutrals sheets.
            Surveys are included by the date they were submitted.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="survey-export-from" className="text-xs">From</Label>
              <Input
                id="survey-export-from"
                type="date"
                value={from}
                disabled={busy}
                onChange={(e) => setFrom(e.target.value)}
                data-testid="input-survey-export-from"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="survey-export-to" className="text-xs">To</Label>
              <Input
                id="survey-export-to"
                type="date"
                value={to}
                disabled={busy}
                onChange={(e) => setTo(e.target.value)}
                data-testid="input-survey-export-to"
              />
            </div>
          </div>

          {!rangeValid && (
            <p className="text-xs text-destructive">
              The start date must be on or before the end date.
            </p>
          )}

          {/*
            Total Active Clients is CONNECTED — it has been since the nightly
            pull shipped. This paragraph still said it was not, which would have
            read as a contradiction directly above a panel for editing it.
          */}
          <div className="rounded border">
            <button
              type="button"
              className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-muted/50"
              onClick={() => setShowCounts((v) => !v)}
              disabled={busy || !rangeValid}
              data-testid="button-toggle-active-counts"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Total Active Clients
              <span className="ml-auto text-muted-foreground font-normal">
                {showCounts ? "Hide" : "Adjust"}
              </span>
            </button>
            {showCounts && rangeValid && (
              <div className="px-3 pb-3 pt-1 border-t">
                <ActiveCountOverrides from={from} to={to} />
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground border-l-2 pl-3">
            The <strong>Data</strong> sheet is still deliberately blank — it is waiting
            on the columns the practice wants on it.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={download}
            disabled={!rangeValid || busy}
            className="gap-2"
            data-testid="button-survey-export-download"
          >
            {busy
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Building…</>
              : <><Download className="h-4 w-4" /> Export</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
