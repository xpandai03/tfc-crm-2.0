/**
 * Fallback-mode banner — shown when the CRM is running on temporary
 * infrastructure during a data outage. Reusable: driven entirely by the
 * server's FALLBACK_MODE flag (exposed at GET /api/app-config), so it can be
 * switched on for any future outage and off afterward WITHOUT a code change.
 *
 * Default OFF. When off, this renders nothing.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function FallbackBanner() {
  const [open, setOpen] = useState(false);

  const { data } = useQuery<{ fallbackMode: boolean }>({
    queryKey: ["/api/app-config"],
    queryFn: async () => {
      const r = await fetch("/api/app-config");
      if (!r.ok) return { fallbackMode: false };
      return r.json();
    },
    staleTime: 60 * 1000,
    retry: false,
  });

  if (!data?.fallbackMode) return null;

  return (
    <>
      <div
        role="status"
        className="sticky top-0 z-50 w-full bg-amber-100 border-b border-amber-300 text-amber-900 dark:bg-amber-900/40 dark:border-amber-700 dark:text-amber-100"
      >
        <div className="mx-auto flex items-center justify-center gap-2 px-4 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="text-center">
            <span className="font-semibold">Fallback Mode</span> — running on temporary
            infrastructure due to a cloud-provider outage. Your data is safe and being recovered.
          </span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-amber-500"
            aria-label="What does Fallback Mode mean?"
          >
            <Info className="h-4 w-4" />
            Learn more
          </button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              You're in Fallback Mode
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Our cloud provider is doing emergency work on the server that holds the CRM's
              database — a rare event, similar to routine hardware maintenance. It's temporary.
            </p>
            <p className="font-medium text-foreground">Your data is safe.</p>
            <p>
              Nothing has been lost. While the main database is being recovered, the CRM is running
              on a temporary backup setup so you can keep working — take new submissions, add and
              assign providers, and use the day-to-day tools.
            </p>
            <p>
              You may notice some <span className="font-medium text-foreground">history is missing
              for now</span> (older contacts, past notes, prior activity). That information isn't
              gone — it will reappear automatically once recovery finishes and we switch back to the
              main database.
            </p>
            <p>
              Thanks for your patience. If something looks off, it's expected during this window —
              no need to re-enter old data.
            </p>
          </div>
          <div className="flex justify-end pt-2">
            <Button onClick={() => setOpen(false)}>
              <X className="h-4 w-4 mr-1.5" />
              Got it
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
