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
import { formatDob } from "@/lib/utils";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { ContactSnapshot } from "@shared/schema";

interface CreateTnModalProps {
  isOpen: boolean;
  onClose: () => void;
  contact: ContactSnapshot | null;
  onConfirm: () => void;
  isSubmitting: boolean;
}

function parseName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: parts[0] || "", lastName: "" };
  const lastName = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(" ");
  return { firstName, lastName };
}

export function CreateTnModal({
  isOpen,
  onClose,
  contact,
  onConfirm,
  isSubmitting,
}: CreateTnModalProps) {
  if (!contact) return null;

  const { firstName, lastName } = parseName(contact.name || "");

  const fields: { label: string; value: string }[] = [
    { label: "First Name", value: firstName },
    { label: "Last Name", value: lastName },
    { label: "Date of Birth", value: formatDob(contact.patientDob as string) },
    { label: "Address", value: (contact.streetAddress as string) || "" },
    { label: "Zip Code", value: (contact.zipCode as string) || "" },
    { label: "Sex", value: (contact.gender as string) || "" },
    { label: "Insurance ID", value: (contact.insuranceId as string) || "" },
    { label: "Phone", value: (contact.phone as string) || "" },
    { label: "RFS Link", value: (contact.rfsLink as string) || "" },
  ];

  const missingFields = fields.filter((f) => !f.value || f.value.trim() === "");

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to TherapyNotes EHR</DialogTitle>
          <DialogDescription>
            Review the information below before creating this patient in TherapyNotes.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
          {fields.map((field) => (
            <div key={field.label}>
              <p className="text-xs text-muted-foreground mb-0.5">{field.label}</p>
              <p className="text-sm font-medium truncate">
                {field.value || <span className="text-muted-foreground italic">Empty</span>}
              </p>
            </div>
          ))}
        </div>

        {missingFields.length > 0 && (
          <Alert variant="default" className="border-amber-200 bg-amber-50">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800 text-xs">
              <strong>Missing fields:</strong>{" "}
              {missingFields.map((f) => f.label).join(", ")}.
              These will be sent empty to TherapyNotes.
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Patient"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
