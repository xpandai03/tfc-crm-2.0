/**
 * Reminder Modal
 *
 * Creates email reminders for contacts.
 * Fire-and-forget: no list, no edit, no delete in v1.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";

interface ReminderModalProps {
  isOpen: boolean;
  onClose: () => void;
  contact: { contactId: number; name: string } | null;
  userEmail: string;
  onSubmit: (params: {
    contactId: number;
    contactName: string;
    createdByEmail: string;
    reminderText: string;
    reminderDateTime: string;
    secondReminderDateTime?: string;
  }) => void;
  isSubmitting?: boolean;
}

// Get the user's browser timezone abbreviation (e.g. "PST", "MST")
function getUserTimezone(): string {
  return new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value || "local time";
}

// Format date for datetime-local input (must use LOCAL time components, not UTC)
function getMinDateTime(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// Convert local datetime-local value to ISO string
function localToISO(localDateTime: string): string {
  return new Date(localDateTime).toISOString();
}

// Check if date is less than 24 hours away
function isLessThan24HoursAway(dateTimeStr: string): boolean {
  const date = new Date(dateTimeStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  return diffHours < 24;
}

// Calculate 1 day before
function getOneDayBefore(dateTimeStr: string): string {
  const date = new Date(dateTimeStr);
  date.setDate(date.getDate() - 1);
  return date.toISOString();
}

export function ReminderModal({
  isOpen,
  onClose,
  contact,
  userEmail,
  onSubmit,
  isSubmitting = false,
}: ReminderModalProps) {
  const [reminderText, setReminderText] = useState("");
  const [reminderDateTime, setReminderDateTime] = useState("");
  const [addSecondReminder, setAddSecondReminder] = useState(false);

  const handleClose = () => {
    setReminderText("");
    setReminderDateTime("");
    setAddSecondReminder(false);
    onClose();
  };

  const handleSubmit = () => {
    if (!contact || !reminderText.trim() || !reminderDateTime) return;

    const params: Parameters<typeof onSubmit>[0] = {
      contactId: contact.contactId,
      contactName: contact.name,
      createdByEmail: userEmail,
      reminderText: reminderText.trim(),
      reminderDateTime: localToISO(reminderDateTime),
    };

    // Add second reminder if enabled and date is far enough away
    if (addSecondReminder && !isLessThan24HoursAway(reminderDateTime)) {
      params.secondReminderDateTime = getOneDayBefore(reminderDateTime);
    }

    onSubmit(params);
  };

  // Allow current minute — only block if selected time is before the current minute
  const isDateInPast = reminderDateTime && new Date(reminderDateTime).getTime() < Date.now() - 60_000;
  const showSecondReminderWarning = addSecondReminder && reminderDateTime && isLessThan24HoursAway(reminderDateTime);
  const canSubmit = contact && reminderText.trim() && reminderDateTime && !isDateInPast && !isSubmitting;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add Reminder</DialogTitle>
          <DialogDescription>
            Schedule an email reminder for {contact?.name || "this contact"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Reminder Text */}
          <div className="space-y-2">
            <Label htmlFor="reminder-text">What do you want to be reminded about?</Label>
            <Textarea
              id="reminder-text"
              placeholder="e.g., Follow up about scheduling appointment"
              value={reminderText}
              onChange={(e) => setReminderText(e.target.value)}
              className="min-h-[80px] resize-none"
              autoFocus
            />
          </div>

          {/* Date & Time */}
          <div className="space-y-2">
            <Label htmlFor="reminder-datetime">When should we remind you? <span className="text-muted-foreground font-normal">({getUserTimezone()})</span></Label>
            <Input
              id="reminder-datetime"
              type="datetime-local"
              value={reminderDateTime}
              onChange={(e) => setReminderDateTime(e.target.value)}
              min={getMinDateTime()}
              className="w-full"
            />
            {isDateInPast && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                Please select a future date and time
              </p>
            )}
          </div>

          {/* Second Reminder Checkbox */}
          <div className="flex items-start space-x-2">
            <Checkbox
              id="second-reminder"
              checked={addSecondReminder}
              onCheckedChange={(checked) => setAddSecondReminder(checked === true)}
            />
            <div className="grid gap-1.5 leading-none">
              <Label
                htmlFor="second-reminder"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Also remind me 1 day before
              </Label>
              {showSecondReminderWarning && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Reminder is less than 24 hours away — second reminder will be skipped
                </p>
              )}
            </div>
          </div>

          {/* Email Destination Info */}
          <p className="text-xs text-muted-foreground">
            Reminder will be sent to: <span className="font-medium">{userEmail}</span>
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting ? "Scheduling..." : "Schedule Reminder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
