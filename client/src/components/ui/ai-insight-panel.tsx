import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, ArrowRight, User, MessageSquarePlus } from "lucide-react";
import { Link } from "wouter";

interface AIInsightPanelProps {
  insight: string;
  suggestedAction?: string;
  actionLabel?: string;
  onAction?: () => void;
  dataPoints?: string[]; // Fields this insight is computed from
  contactName?: string; // Referenced contact name (for display)
  contactId?: number; // Referenced contact ID (for navigation/actions) - CANONICAL
  actionsEnabled?: boolean; // Whether actions are enabled (live mode)
  onAddNote?: (contactId: number) => void; // Add note action - uses contactId
  className?: string;
}

// Format data point names for display
function formatDataPoint(point: string): string {
  const labels: Record<string, string> = {
    daysOnWaitlist: "days waiting",
    avgWaitDays: "average wait",
    serviceRequested: "service type",
    statusCode: "status",
    over60Days: "60+ day count",
    totalActive: "active contacts",
    byStatus: "status breakdown",
    readyToSchedule: "ready count",
  };
  return labels[point] || point;
}

export function AIInsightPanel({
  insight,
  suggestedAction,
  actionLabel = "Take Action",
  onAction,
  dataPoints,
  contactName,
  contactId,
  actionsEnabled = false,
  onAddNote,
  className,
}: AIInsightPanelProps) {
  // DATA INTEGRITY: Log warning if contactName exists but contactId is missing
  if (contactName && (contactId === undefined || contactId === null)) {
    console.warn("[AIInsightPanel] Missing contactId for contact:", contactName);
  }

  const handleAddNote = (e: React.MouseEvent) => {
    e.preventDefault();
    // CANONICAL: Use contactId for action
    if (contactId && onAddNote) {
      onAddNote(contactId);
    }
  };

  // CANONICAL: Use contactId for navigation
  const contactHref = contactId ? `/contact/${contactId}` : "#";

  return (
    <Card className={`bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800 overflow-visible ${className}`}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-300">
          <Sparkles className="h-4 w-4" />
          <span className="uppercase tracking-wide text-xs">AI Insight</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-blue-900 dark:text-blue-100" data-testid="text-ai-insight">
          {insight}
        </p>
        {dataPoints && dataPoints.length > 0 && (
          <p className="text-[10px] text-blue-500/70 dark:text-blue-400/60 mt-1.5">
            Based on: {dataPoints.map(formatDataPoint).join(", ")}
          </p>
        )}

        {/* Contact action buttons - shown when a contact is referenced AND has contactId */}
        {contactName && contactId && (
          <div className="flex items-center gap-2 pt-2 border-t border-blue-200 dark:border-blue-800">
            <Link href={contactHref}>
              <Button
                size="sm"
                variant="outline"
                className="text-blue-700 border-blue-300 hover:bg-blue-100 dark:text-blue-300 dark:border-blue-700 dark:hover:bg-blue-900/50 text-xs h-7"
              >
                <User className="h-3 w-3 mr-1" />
                View {contactName.split(" ")[0]}
              </Button>
            </Link>
            {onAddNote && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleAddNote}
                disabled={!actionsEnabled}
                className="text-blue-700 border-blue-300 hover:bg-blue-100 dark:text-blue-300 dark:border-blue-700 dark:hover:bg-blue-900/50 text-xs h-7 disabled:opacity-50"
                title={!actionsEnabled ? "Switch to live data to enable actions" : undefined}
              >
                <MessageSquarePlus className="h-3 w-3 mr-1" />
                Add Note
              </Button>
            )}
          </div>
        )}

        {suggestedAction && (
          <div className="pt-2 border-t border-blue-200 dark:border-blue-800">
            <p className="text-xs text-blue-600 dark:text-blue-400 mb-2">
              Suggested Action
            </p>
            <p className="text-sm text-blue-800 dark:text-blue-200 mb-3" data-testid="text-ai-suggested-action">
              {suggestedAction}
            </p>
            {onAction && (
              <Button
                size="sm"
                variant="outline"
                onClick={onAction}
                className="text-blue-700 border-blue-300 hover:bg-blue-100 dark:text-blue-300 dark:border-blue-700 dark:hover:bg-blue-900/50"
                data-testid="button-ai-action"
              >
                {actionLabel}
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
