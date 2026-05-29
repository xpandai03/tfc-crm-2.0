import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CalendarClock, Loader2, Check } from "lucide-react";
import { saveScheduledAppointment } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

// h:mm am/pm (case-insensitive), e.g. "2:00 pm", "11:30 AM"
const TIME_RE = /^\d{1,2}:\d{2}\s*(am|pm)$/i;

// TODO Issue: dedupe scheduled appointment date/time entry between widget and
// email modal. The Send Email modal (Initial Appointment Confirmation template)
// also collects appointment date/time (+ provider + location), so staff enter
// the same data twice. Consider sourcing the email modal's date/time from this
// widget's saved value (or vice versa). Not blocking — filed for a later pass.

interface ScheduleAppointmentWidgetProps {
  contactId: number;
  /** Stored ISO date 'YYYY-MM-DD' (or null). */
  initialDate: string | null;
  /** Stored time 'h:mm am/pm' (or null). */
  initialTime: string | null;
  /** Called after a successful save so the parent can refetch state. */
  onSaved?: () => void;
}

export function ScheduleAppointmentWidget({
  contactId,
  initialDate,
  initialTime,
  onSaved,
}: ScheduleAppointmentWidgetProps) {
  const { toast } = useToast();
  const [date, setDate] = useState(initialDate || "");
  const [time, setTime] = useState(initialTime || "");
  const [timeError, setTimeError] = useState<string | null>(null);

  // Re-sync local fields when the saved values arrive/refresh.
  useEffect(() => {
    setDate(initialDate || "");
    setTime(initialTime || "");
  }, [initialDate, initialTime]);

  const mutation = useMutation({
    mutationFn: () => saveScheduledAppointment(contactId, date || null, time.trim() || null),
    onSuccess: () => {
      toast({ title: "Appointment saved", description: "Scheduled appointment date and time updated." });
      onSaved?.();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save appointment", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    const trimmedTime = time.trim();
    if (trimmedTime && !TIME_RE.test(trimmedTime)) {
      setTimeError("Use format h:mm am/pm (e.g. 2:00 pm)");
      return;
    }
    setTimeError(null);
    mutation.mutate();
  };

  const dirty = (date || "") !== (initialDate || "") || time.trim() !== (initialTime || "");
  const isSet = !!initialDate && !!initialTime;

  return (
    <Card data-testid="widget-schedule-appointment">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-amber-600" />
          Schedule Appointment
          {isSet && (
            <span className="inline-flex items-center gap-1 text-xs font-normal text-green-700">
              <Check className="h-3 w-3" /> Set
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="appt-date" className="text-xs text-muted-foreground">
            Date <span className="text-muted-foreground/70">(m/d/yyyy)</span>
          </Label>
          <Input
            id="appt-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            data-testid="input-appointment-date"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="appt-time" className="text-xs text-muted-foreground">
            Time <span className="text-muted-foreground/70">(h:mm am/pm)</span>
          </Label>
          <Input
            id="appt-time"
            type="text"
            placeholder="2:00 pm"
            value={time}
            onChange={(e) => { setTime(e.target.value); if (timeError) setTimeError(null); }}
            aria-invalid={!!timeError}
            data-testid="input-appointment-time"
          />
          {timeError && <p className="text-xs text-red-600">{timeError}</p>}
        </div>

        <Button
          className="w-full"
          size="sm"
          onClick={handleSave}
          disabled={mutation.isPending || !dirty}
          data-testid="button-save-appointment"
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Appointment"
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
