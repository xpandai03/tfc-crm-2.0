/**
 * Schedule in TN (Beta) — explicit capture modal (Phase 1 redesign).
 *
 * Replaces the prior confirmation-only modal. The user explicitly enters/confirms
 * Provider, Appointment Date + Time, and Modality before firing the automation —
 * replacing the server-side inference that caused reliability problems.
 *
 * Built fresh (NOT a refactor of the Send Email modal, which is fused to the
 * template/preview/ECC/send pipeline). Reuses only small primitives: the
 * /api/email-config provider list, the schedule-widget date/time shape, and a
 * plain modality select. Defaults pre-fill from current state but are editable
 * and re-confirmed (Lane's locked decision — no silent carry-over).
 *
 * Documents (intake + appointment-confirmation snapshot) are auto-resolved by the
 * server exactly as before; manual upload is Phase 2. If a snapshot/intake isn't
 * resolvable yet, this modal warns (advisory) but does not hard-block.
 */

import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Loader2, FlaskConical, AlertTriangle } from "lucide-react";
import type { ContactSnapshot } from "@shared/schema";
import type { TnScheduleInputs } from "@/lib/api";

// h:mm am/pm (case-insensitive) — same contract as the schedule-appointment widget.
const TIME_RE = /^\d{1,2}:\d{2}\s*(am|pm)$/i;

type Modality = "In-Person" | "Telehealth";

interface ApiProvider {
  name: string;
  credentials: string;
}

interface ScheduleTnBetaModalProps {
  isOpen: boolean;
  onClose: () => void;
  contact: ContactSnapshot | null;
  /** Default clinician name (from current assignment), if any. */
  defaultProviderName: string | null;
  /** Default appointment date 'YYYY-MM-DD' (from saved scheduled appointment). */
  defaultDate: string | null;
  /** Default appointment time 'h:mm am/pm' (from saved scheduled appointment). */
  defaultTime: string | null;
  /** Advisory flags for document auto-resolution (Phase 2 adds manual override). */
  canGenerateIntakePdf?: boolean;
  emailSent?: boolean;
  onConfirm: (inputs: TnScheduleInputs) => void;
  isSubmitting: boolean;
}

/** Map a stored free-text modality to the fixed enum, else "" (forces a pick). */
function mapModality(raw: string | null | undefined): Modality | "" {
  const m = (raw || "").toLowerCase();
  if (m.includes("in person") || m.includes("in-person")) return "In-Person";
  if (m.includes("telehealth")) return "Telehealth";
  return "";
}

export function ScheduleTnBetaModal({
  isOpen,
  onClose,
  contact,
  defaultProviderName,
  defaultDate,
  defaultTime,
  canGenerateIntakePdf,
  emailSent,
  onConfirm,
  isSubmitting,
}: ScheduleTnBetaModalProps) {
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [providerName, setProviderName] = useState<string>("");
  const [date, setDate] = useState<string>("");
  const [time, setTime] = useState<string>("");
  const [modality, setModality] = useState<Modality | "">("");
  const [timeError, setTimeError] = useState<string | null>(null);

  // Fetch provider list (same source the email modal uses) when opened.
  useEffect(() => {
    if (!isOpen) return;
    let aborted = false;
    (async () => {
      try {
        const res = await fetch("/api/email-config", { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        if (!aborted) setProviders(data.providers || []);
      } catch { /* dropdown still lets the default through */ }
    })();
    return () => { aborted = true; };
  }, [isOpen]);

  // Seed defaults each time the modal opens (editable, re-confirmed — not carried over silently).
  useEffect(() => {
    if (!isOpen) return;
    setProviderName(defaultProviderName || "");
    setDate(defaultDate || "");
    setTime(defaultTime || "");
    setModality(mapModality(contact?.modality));
    setTimeError(null);
  }, [isOpen, defaultProviderName, defaultDate, defaultTime, contact?.modality]);

  const timeValid = time.trim() !== "" && TIME_RE.test(time.trim());
  const allValid = useMemo(
    () => providerName.trim() !== "" && date.trim() !== "" && timeValid && (modality === "In-Person" || modality === "Telehealth"),
    [providerName, date, timeValid, modality]
  );

  const handleSubmit = () => {
    if (!allValid) {
      if (!timeValid) setTimeError("Use format h:mm am/pm (e.g. 2:00 pm)");
      return;
    }
    onConfirm({
      providerName: providerName.trim(),
      appointmentDate: date,
      appointmentTime: time.trim(),
      modality: modality as Modality,
    });
  };

  if (!contact) return null;

  // If the saved/assigned provider isn't in the fetched list, keep it as an option
  // so the default remains selectable.
  const providerOptions = providers.some((p) => p.name === providerName) || !providerName
    ? providers
    : [{ name: providerName, credentials: "" }, ...providers];

  const showSnapshotWarning = emailSent === false;
  const showIntakeWarning = canGenerateIntakePdf === false;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Add to Schedule in TN
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
              <FlaskConical className="h-3 w-3 mr-1" />
              Beta
            </Badge>
          </DialogTitle>
          <DialogDescription>
            Confirm the provider, appointment date &amp; time, and modality. This creates the
            patient in TherapyNotes, uploads the intake &amp; confirmation PDFs, and schedules the
            appointment (90–180s).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {/* Provider */}
          <div className="space-y-1.5">
            <Label className="text-sm">Provider <span className="text-destructive">*</span></Label>
            <Select value={providerName} onValueChange={setProviderName} disabled={isSubmitting}>
              <SelectTrigger data-testid="select-tn-provider">
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent className="max-h-[240px]">
                {providerOptions.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}{p.credentials ? ` — ${p.credentials}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date + Time */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tn-appt-date" className="text-sm">Date <span className="text-destructive">*</span></Label>
              <Input
                id="tn-appt-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                disabled={isSubmitting}
                data-testid="input-tn-appt-date"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tn-appt-time" className="text-sm">Time <span className="text-destructive">*</span></Label>
              <Input
                id="tn-appt-time"
                type="text"
                placeholder="2:00 pm"
                value={time}
                onChange={(e) => { setTime(e.target.value); if (timeError) setTimeError(null); }}
                aria-invalid={!!timeError}
                disabled={isSubmitting}
                data-testid="input-tn-appt-time"
              />
              {timeError && <p className="text-xs text-red-600">{timeError}</p>}
            </div>
          </div>

          {/* Modality — required, fixed options; eliminates the silent In-Person default. */}
          <div className="space-y-1.5">
            <Label className="text-sm">Modality <span className="text-destructive">*</span></Label>
            <Select value={modality} onValueChange={(v) => setModality(v as Modality)} disabled={isSubmitting}>
              <SelectTrigger data-testid="select-tn-modality">
                <SelectValue placeholder="Select modality" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="In-Person">In-Person</SelectItem>
                <SelectItem value="Telehealth">Telehealth</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Document advisories (Phase 1: auto-resolution only; Phase 2 adds manual upload). */}
          {showSnapshotWarning && (
            <Alert className="border-amber-300 bg-amber-50">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-800 text-xs">
                No appointment-confirmation snapshot saved yet — the confirmation PDF can't be
                auto-generated. Send the confirmation email first, or the snapshot upload may fail.
                (Manual upload is coming in Phase 2.)
              </AlertDescription>
            </Alert>
          )}
          {showIntakeWarning && (
            <Alert className="border-amber-300 bg-amber-50">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-800 text-xs">
                This contact has no intake form data — the intake PDF can't be auto-generated.
                (Manual upload is coming in Phase 2.)
              </AlertDescription>
            </Alert>
          )}

          {isSubmitting && (
            <Alert variant="default" className="border-amber-200 bg-amber-50">
              <Loader2 className="h-4 w-4 text-amber-600 animate-spin" />
              <AlertDescription className="text-amber-800 text-xs">
                Working on it… creating the patient, uploading PDFs, and scheduling the appointment.
                Please keep this tab open — this can take up to 3 minutes.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !allValid}
            className="bg-amber-600 hover:bg-amber-700 text-white"
            data-testid="button-confirm-tn-schedule"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Working on it…
              </>
            ) : (
              "Create & Schedule"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
