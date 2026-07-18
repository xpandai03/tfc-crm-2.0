/**
 * Custom Report Builder — modal UI.
 *
 * Calls the deployed, manager-gated referral export endpoints
 * (GET /api/export/referrals.{csv,xlsx}) with the query params they accept:
 *   from, to (YYYY-MM-DD, required), service_type, modality, insurance,
 *   status_code, include_identifiers. Blank/"Any" filters are omitted entirely.
 *
 * Option values are READ from the shared modules that back the SERVER-SIDE
 * normalizers (not hardcoded guesses), so a selected filter round-trips to the
 * exact normalized value the export column shows:
 *   - service type  → normalizeServiceType (server/sync/db.ts) canonical strings
 *   - modality      → distinct buckets of MODALITY_NORMALIZATION_MAP (shared)
 *   - insurance     → ACCEPTED_INSURANCES (shared) + Unknown
 *   - status        → STATUS_LABELS (client status-config)
 *
 * NOTE (codebase landmine): no Radix ScrollArea anywhere in this file — it has a
 * ResizeObserver measurement failure inside animated dialogs (the provider-modal
 * bug). The layout is sized to fit without scrolling.
 *
 * The status-movement (from→to status) filter is intentionally NOT here — it
 * ships next build. A clean vertical gap is left for it below the filter grid.
 */
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ACCEPTED_INSURANCES } from "@shared/insurance-utils";
import { MODALITY_NORMALIZATION_MAP } from "@shared/modality-utils";
import { STATUS_LABELS } from "@/lib/status-config";

// Radix <Select> forbids an empty-string item value, so use a sentinel for "Any".
const ANY = "__any__";

// Canonical service-type strings the server's normalizeServiceType folds to.
// Sending the canonical string round-trips (see server/sync/db.ts).
const SERVICE_TYPES = ["Myself", "My Child", "My Partner & Myself", "My Family", "Other"] as const;

// Friendly labels + preferred order for the modality buckets. The bucket VALUES
// themselves are derived from the shared map below (source of truth); anything
// the map defines that isn't ordered here still appears (future-proof).
const MODALITY_ORDER = ["Telehealth", "In Person ABQ", "In Person RR", "In Person LL", "In Person", "Hybrid", "Flex"];
const MODALITY_FRIENDLY: Record<string, string> = {
  "Telehealth": "Telehealth",
  "In Person ABQ": "In Person — Albuquerque",
  "In Person RR": "In Person — Rio Rancho",
  "In Person LL": "In Person — Los Lunas",
  "In Person": "In Person (unspecified)",
  "Hybrid": "Hybrid",
  "Flex": "Flexible",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function toYMD(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function firstOfMonth(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReportBuilderModal({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const now = new Date();

  const [from, setFrom] = useState(() => firstOfMonth(now));
  const [to, setTo] = useState(() => toYMD(now));
  const [serviceType, setServiceType] = useState<string>(ANY);
  const [modality, setModality] = useState<string>(ANY);
  const [insurance, setInsurance] = useState<string>(ANY);
  const [statusCode, setStatusCode] = useState<string>(ANY);
  const [includeIdentifiers, setIncludeIdentifiers] = useState(false);
  const [busy, setBusy] = useState<null | "csv" | "xlsx">(null);

  // Modality buckets: distinct values of the shared normalizer map, ordered.
  const modalityBuckets = useMemo(() => {
    const present = Array.from(new Set(Object.values(MODALITY_NORMALIZATION_MAP)));
    const ordered = MODALITY_ORDER.filter((b) => present.includes(b));
    const extras = present.filter((b) => !MODALITY_ORDER.includes(b));
    return [...ordered, ...extras];
  }, []);

  const statusOptions = useMemo(
    () => Object.keys(STATUS_LABELS).map(Number).sort((a, b) => a - b),
    [],
  );

  const rangeValid = Boolean(from) && Boolean(to) && from <= to;

  async function download(format: "csv" | "xlsx") {
    if (!rangeValid || busy) return; // double-click / invalid guard
    setBusy(format);
    try {
      const qs = new URLSearchParams();
      qs.set("from", from);
      qs.set("to", to);
      if (serviceType !== ANY) qs.set("service_type", serviceType);
      if (modality !== ANY) qs.set("modality", modality);
      if (insurance !== ANY) qs.set("insurance", insurance);
      if (statusCode !== ANY) qs.set("status_code", statusCode);
      if (includeIdentifiers) qs.set("include_identifiers", "true");

      const res = await fetch(`/api/export/referrals.${format}?${qs.toString()}`, {
        credentials: "include",
        cache: "no-store",
      });

      if (!res.ok) {
        let msg = `Report failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {
          /* non-JSON error body */
        }
        if (res.status === 403) msg = "You don’t have access to generate reports — this is a manager-only export.";
        else if (res.status === 401) msg = "Your session has expired — please sign in again.";
        throw new Error(msg);
      }

      // Reuse the app's blob-download pattern (waitlist handleExport).
      const blob = await res.blob();
      const filename = `referrals-${from}-to-${to}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Report downloaded", description: filename });
      // Modal intentionally stays open so managers can adjust filters and re-run.
    } catch (err) {
      toast({
        title: "Report failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl" data-testid="modal-report-builder">
        <DialogHeader>
          <DialogTitle>Generate referral report</DialogTitle>
          <DialogDescription>
            Export referral submissions as CSV or Excel. Choose a date range; add optional filters to narrow the results.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Date range (required) */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="rb-from">From</Label>
              <Input
                id="rb-from"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                data-testid="input-report-from"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rb-to">To</Label>
              <Input
                id="rb-to"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                data-testid="input-report-to"
              />
            </div>
          </div>
          {!rangeValid && (
            <p className="text-sm text-destructive" data-testid="text-range-error">
              Enter a valid date range — “From” must be on or before “To”.
            </p>
          )}

          {/* Four optional filters — 2×2 grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FilterSelect
              label="Service type"
              testid="select-service-type"
              value={serviceType}
              onChange={setServiceType}
              options={SERVICE_TYPES.map((s) => ({ value: s, label: s }))}
            />
            <FilterSelect
              label="Modality"
              testid="select-modality"
              value={modality}
              onChange={setModality}
              options={modalityBuckets.map((b) => ({ value: b, label: MODALITY_FRIENDLY[b] ?? b }))}
            />
            <FilterSelect
              label="Insurance"
              testid="select-insurance"
              value={insurance}
              onChange={setInsurance}
              options={[
                ...ACCEPTED_INSURANCES.map((i) => ({ value: i, label: i })),
                { value: "Unknown", label: "Unknown" },
              ]}
            />
            <FilterSelect
              label="Current status"
              testid="select-status"
              value={statusCode}
              onChange={setStatusCode}
              options={statusOptions.map((c) => ({ value: String(c), label: `${c} — ${STATUS_LABELS[c]}` }))}
            />
          </div>

          {/* Intentional gap: the status-movement (from → to status) filter
              section lands here in the next build. Renders nothing today. */}
          <div aria-hidden className="h-2" data-testid="slot-status-movement" />

          {/* Include identifiers (PHI) */}
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <Checkbox
                checked={includeIdentifiers}
                onCheckedChange={(v) => setIncludeIdentifiers(v === true)}
                data-testid="checkbox-include-identifiers"
              />
              Include client identifiers (name, DOB)
            </label>
            <p className="text-xs text-muted-foreground pl-6">
              Export will contain protected health information.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={!rangeValid || busy !== null}
            onClick={() => download("csv")}
            data-testid="button-download-csv"
          >
            {busy === "csv" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Download CSV
          </Button>
          <Button
            disabled={!rangeValid || busy !== null}
            onClick={() => download("xlsx")}
            data-testid="button-download-xlsx"
          >
            {busy === "xlsx" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Download Excel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FilterSelect({
  label,
  testid,
  value,
  onChange,
  options,
}: {
  label: string;
  testid: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger data-testid={testid}>
          <SelectValue />
        </SelectTrigger>
        {/* Native overflow (Radix SelectContent), NOT ScrollArea. */}
        <SelectContent className="max-h-[280px]">
          <SelectItem value={ANY}>Any</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
