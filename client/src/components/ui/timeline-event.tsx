import { useState } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageSquare, Flag, RefreshCw, Info, ChevronDown, ChevronUp } from "lucide-react";
import type { TimelineEvent } from "@/lib/timeline";
import { formatRelativeTime, formatFullDate } from "@/lib/timeline";

interface TimelineEventCardProps {
  event: TimelineEvent;
  className?: string;
}

const MAX_CONTENT_LENGTH = 280;

// Icon mapping by event type
function getEventIcon(event: TimelineEvent) {
  switch (event.type) {
    case "note":
      return MessageSquare;
    case "milestone":
      return Flag;
    case "status_change":
      return RefreshCw;
    case "system":
    default:
      return Info;
  }
}

// Style mapping by event type
function getEventStyles(event: TimelineEvent) {
  switch (event.type) {
    case "note":
      return {
        iconBg: "bg-slate-100 dark:bg-slate-800",
        iconColor: "text-slate-600 dark:text-slate-400",
        borderColor: "",
      };
    case "milestone":
      return {
        iconBg: "bg-emerald-100 dark:bg-emerald-900/30",
        iconColor: "text-emerald-600 dark:text-emerald-400",
        borderColor: "border-l-2 border-l-emerald-500",
      };
    case "status_change":
      return {
        iconBg: "bg-blue-100 dark:bg-blue-900/30",
        iconColor: "text-blue-600 dark:text-blue-400",
        borderColor: "border-l-2 border-l-blue-500",
      };
    case "system":
    default:
      return {
        iconBg: "bg-gray-100 dark:bg-gray-800",
        iconColor: "text-gray-500 dark:text-gray-400",
        borderColor: "",
      };
  }
}

export function TimelineEventCard({ event, className }: TimelineEventCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const Icon = getEventIcon(event);
  const styles = getEventStyles(event);
  const content = event.content || "";
  const needsTruncation = content.length > MAX_CONTENT_LENGTH;
  const displayContent = needsTruncation && !isExpanded
    ? content.slice(0, MAX_CONTENT_LENGTH) + "..."
    : content;

  const relativeTime = formatRelativeTime(event.timestamp);
  const fullDate = formatFullDate(event.timestamp);

  return (
    <Card className={cn("shadow-sm", styles.borderColor, className)}>
      <CardContent className="p-3">
        {/* Header row: Icon, author (if any), and time */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <div className={cn(
              "flex items-center justify-center w-6 h-6 rounded-full",
              styles.iconBg
            )}>
              <Icon className={cn("h-3.5 w-3.5", styles.iconColor)} />
            </div>
            {event.author && (
              <span className="text-xs font-medium text-muted-foreground">
                {event.author}
              </span>
            )}
            {event.type === "milestone" && event.milestoneType && (
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                {event.milestoneType === "added" ? "Waitlist" : event.milestoneType}
              </span>
            )}
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {relativeTime}
          </span>
        </div>

        {/* Content */}
        {displayContent && (
          <p className="text-sm text-foreground whitespace-pre-wrap break-words">
            {displayContent}
          </p>
        )}

        {/* Show more/less toggle */}
        {needsTruncation && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 mt-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? (
              <>
                Show less <ChevronUp className="h-3 w-3 ml-1" />
              </>
            ) : (
              <>
                Show more <ChevronDown className="h-3 w-3 ml-1" />
              </>
            )}
          </Button>
        )}

        {/* Full date (subtle) */}
        <p className="text-[10px] text-muted-foreground/70 mt-2">
          {fullDate}
        </p>
      </CardContent>
    </Card>
  );
}
