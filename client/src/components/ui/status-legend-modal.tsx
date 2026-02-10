import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STATUS_UMBRELLAS,
  STATUS_LABELS,
  STATUS_DESCRIPTIONS,
  type UmbrellaId,
} from "@/lib/status-config";

const umbrellaStyles: Record<UmbrellaId, { bg: string; text: string; badge: string }> = {
  WL: {
    bg: "bg-slate-50 dark:bg-slate-900/50",
    text: "text-slate-700 dark:text-slate-300",
    badge: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  },
  PS: {
    bg: "bg-amber-50 dark:bg-amber-900/30",
    text: "text-amber-700 dark:text-amber-300",
    badge: "bg-amber-200 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  },
  PMR: {
    bg: "bg-purple-50 dark:bg-purple-900/30",
    text: "text-purple-700 dark:text-purple-300",
    badge: "bg-purple-200 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
  },
  INS: {
    bg: "bg-red-50 dark:bg-red-900/30",
    text: "text-red-700 dark:text-red-300",
    badge: "bg-red-200 text-red-800 dark:bg-red-900/50 dark:text-red-300",
  },
};

interface StatusLegendModalProps {
  trigger?: React.ReactNode;
}

export function StatusLegendModal({ trigger }: StatusLegendModalProps) {
  const umbrellaOrder: UmbrellaId[] = ["WL", "PS", "PMR", "INS"];

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm" className="gap-1.5">
            <Info className="h-4 w-4" />
            Status Codes
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Status Code Reference</DialogTitle>
        </DialogHeader>
        <div className="space-y-6 mt-4">
          <p className="text-sm text-muted-foreground">
            Contacts move through 4 workflow stages. Each stage has multiple status codes
            for tracking progress within that stage.
          </p>

          {umbrellaOrder.map((umbrellaId) => {
            const umbrella = STATUS_UMBRELLAS[umbrellaId];
            const styles = umbrellaStyles[umbrellaId];

            return (
              <div key={umbrellaId} className={cn("rounded-lg p-4", styles.bg)}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className={cn("font-semibold", styles.text)}>
                    {umbrella.label}
                  </h3>
                  <Badge className={styles.badge}>
                    Entry: {umbrella.entry}
                  </Badge>
                </div>
                <div className="space-y-2">
                  {umbrella.codes.map((code) => (
                    <div
                      key={code}
                      className="flex items-start gap-3 bg-white/60 dark:bg-black/20 rounded px-3 py-2"
                    >
                      <span className="font-mono text-sm font-medium min-w-[3ch]">
                        {code}
                      </span>
                      <div className="flex-1">
                        <p className="text-sm font-medium">
                          {STATUS_LABELS[code] || `Status ${code}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {STATUS_DESCRIPTIONS[code] || "No description"}
                        </p>
                      </div>
                      {code === umbrella.entry && (
                        <Badge variant="outline" className="text-[10px] h-5">
                          Default
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="pt-4 border-t">
            <h4 className="text-sm font-medium mb-2">How Drag & Drop Works</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>
                - Dragging a card to a different column sets the <strong>entry status</strong> for that stage
              </li>
              <li>
                - To change to a specific sub-status (e.g., 101, 102), open the contact detail page
              </li>
              <li>
                - Contacts cannot be dragged to the "Needs Review" column
              </li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
