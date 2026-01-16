import { cn } from "@/lib/utils";
import { TimelineEventCard } from "@/components/ui/timeline-event";
import type { TimelineEvent } from "@/lib/timeline";
import { groupEventsByDate } from "@/lib/timeline";
import { Clock } from "lucide-react";

interface TimelineProps {
  events: TimelineEvent[];
  isLoading?: boolean;
  className?: string;
}

function TimelineSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3">
          <div className="flex flex-col items-center">
            <div className="w-2.5 h-2.5 rounded-full bg-muted animate-pulse" />
            <div className="flex-1 w-px bg-border" />
          </div>
          <div className="flex-1 pb-4">
            <div className="h-20 rounded-lg bg-muted animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyTimeline() {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
        <Clock className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-muted-foreground">
        No activity recorded yet
      </p>
      <p className="text-xs text-muted-foreground/70 mt-1">
        Notes and milestones will appear here
      </p>
    </div>
  );
}

export function Timeline({ events, isLoading, className }: TimelineProps) {
  if (isLoading) {
    return <TimelineSkeleton />;
  }

  if (!events || events.length === 0) {
    return <EmptyTimeline />;
  }

  const groupedEvents = groupEventsByDate(events);

  return (
    <div className={cn("relative", className)}>
      {groupedEvents.map(([dateKey, dateEvents], groupIndex) => (
        <div key={dateKey} className="relative">
          {/* Date group header */}
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2.5 h-2.5 rounded-full bg-foreground" />
            <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
              {dateKey}
            </span>
          </div>

          {/* Events in this group */}
          <div className="relative pl-5 ml-[4px] border-l border-border">
            {dateEvents.map((event, eventIndex) => (
              <div
                key={event.id}
                className={cn(
                  "relative pb-4",
                  // Add negative margin to connect line to dot
                  eventIndex === dateEvents.length - 1 &&
                    groupIndex < groupedEvents.length - 1 &&
                    "pb-6"
                )}
              >
                {/* Connecting dot on the timeline */}
                <div className="absolute left-[-21px] top-3 w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />

                <TimelineEventCard event={event} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
