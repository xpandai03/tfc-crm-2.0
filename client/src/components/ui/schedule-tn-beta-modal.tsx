import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Loader2, FlaskConical } from "lucide-react";
import type { ContactSnapshot } from "@shared/schema";

interface ScheduleTnBetaModalProps {
  isOpen: boolean;
  onClose: () => void;
  contact: ContactSnapshot | null;
  /** Assigned clinician name sent to TN as clinician_name. */
  providerName: string | null;
  onConfirm: () => void;
  isSubmitting: boolean;
}

// 'YYYY-MM-DD' -> 'm/d/yyyy' for display (matches the payload format).
function isoToMDY(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

export function ScheduleTnBetaModal({
  isOpen,
  onClose,
  contact,
  providerName,
  onConfirm,
  isSubmitting,
}: ScheduleTnBetaModalProps) {
  if (!contact) return null;

  const apptDate = isoToMDY(contact.scheduledAppointmentDate);
  const apptTime = (contact.scheduledAppointmentTime || "").trim();

  const rows: { label: string; value: string }[] = [
    { label: "Patient", value: contact.name || "" },
    { label: "Appointment", value: [apptDate, apptTime].filter(Boolean).join(" ") },
    { label: "Clinician", value: providerName || "" },
  ];

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
            This will create a new patient in TherapyNotes, upload the intake referral and
            appointment confirmation PDFs, and schedule the appointment. This takes 90–180 seconds.
            Continue?
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-x-4 gap-y-3 py-2">
          {rows.map((r) => (
            <div key={r.label}>
              <p className="text-xs text-muted-foreground mb-0.5">{r.label}</p>
              <p className="text-sm font-medium truncate">
                {r.value || <span className="text-muted-foreground italic">Empty</span>}
              </p>
            </div>
          ))}
        </div>

        {isSubmitting && (
          <Alert variant="default" className="border-amber-200 bg-amber-50">
            <Loader2 className="h-4 w-4 text-amber-600 animate-spin" />
            <AlertDescription className="text-amber-800 text-xs">
              Working on it… creating the patient, uploading PDFs, and scheduling the appointment.
              Please keep this tab open — this can take up to 3 minutes.
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isSubmitting}
            className="bg-amber-600 hover:bg-amber-700 text-white"
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
