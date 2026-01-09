import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface QuickNoteModalProps {
  isOpen: boolean;
  contactName: string;
  onClose: () => void;
  onSubmit: (note: string) => void;
  isSubmitting?: boolean;
}

export function QuickNoteModal({
  isOpen,
  contactName,
  onClose,
  onSubmit,
  isSubmitting = false,
}: QuickNoteModalProps) {
  const [note, setNote] = useState("");

  const handleSubmit = () => {
    if (note.trim()) {
      onSubmit(note.trim());
      setNote("");
    }
  };

  const handleClose = () => {
    setNote("");
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add Note</DialogTitle>
          <DialogDescription>
            Add a quick note for {contactName}
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Textarea
            placeholder="Type your note here..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="min-h-[120px] resize-none"
            data-testid="input-quick-note"
            autoFocus
          />
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isSubmitting}
            data-testid="button-cancel-note"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!note.trim() || isSubmitting}
            data-testid="button-submit-note"
          >
            {isSubmitting ? "Adding..." : "Add Note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
