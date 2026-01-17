import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { OwnerBadge } from "@/components/ui/owner-badge";
import { Link } from "wouter";
import { Calendar, MessageSquarePlus, CheckCircle, Check } from "lucide-react";
import type { WaitlistContact } from "@shared/schema";

interface PriorityCardProps {
  contact: WaitlistContact;
  priority: "high" | "medium" | "standard";
  position?: number; // 1-indexed position in the list
  avgWaitDays?: number; // Average wait days for comparison
  currentUserEmail?: string; // For owner badge "You" display
  // Phase 3: Action props
  actionsEnabled?: boolean; // true when live mode is active
  isHandled?: boolean; // true when action has been taken on this contact
  onAddNote?: (contact: WaitlistContact) => void;
  onMarkContacted?: (contact: WaitlistContact) => void;
}

// Gradient border styles using pseudo-element for glassmorphic effect
const priorityStyles = {
  high: "relative rounded-l-none before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-red-500 before:via-red-400 before:to-red-600 before:rounded-l-lg before:shadow-[0_0_8px_rgba(239,68,68,0.4)]",
  medium: "relative rounded-l-none before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-amber-500 before:via-amber-400 before:to-amber-600 before:rounded-l-lg before:shadow-[0_0_8px_rgba(245,158,11,0.4)]",
  standard: "relative rounded-l-none before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-blue-500 before:via-blue-400 before:to-blue-600 before:rounded-l-lg before:shadow-[0_0_8px_rgba(59,130,246,0.4)]",
};

// Urgency based on days waiting (independent of bucket)
function getUrgencyLevel(days: number): "critical" | "urgent" | "normal" {
  if (days >= 60) return "critical";
  if (days >= 30) return "urgent";
  return "normal";
}

const urgencyBadgeStyles = {
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  urgent: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  normal: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

// Format date for display
function formatDateAdded(dateString: string | null): string {
  if (!dateString) return "Unknown date";
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "Unknown date";
  }
}

// Get comparison text
function getComparisonText(days: number, avgDays: number): string | null {
  if (avgDays === 0) return null;
  const diff = days - avgDays;
  if (diff <= 0) return null;
  return `${diff}d above avg`;
}

export function PriorityCard({
  contact,
  priority,
  position,
  avgWaitDays = 0,
  currentUserEmail,
  actionsEnabled = false,
  isHandled = false,
  onAddNote,
  onMarkContacted,
}: PriorityCardProps) {
  // Defensive: guard against missing contact data
  const contactName = contact?.name || "Unknown";
  const contactId = contact?.contactId;
  const days = contact?.daysOnWaitlist || 0;
  const urgency = getUrgencyLevel(days);
  const isTopPriority = position === 1;
  const comparisonText = getComparisonText(days, avgWaitDays);
  const testIdSlug = contactName.toLowerCase().replace(/\s+/g, '-');

  // DATA INTEGRITY: Log warning if contactId is missing
  if (contactId === undefined || contactId === null) {
    console.warn("[PriorityCard] Missing contactId for contact:", contactName);
  }

  // Check if any actions are available
  const hasActions = onAddNote || onMarkContacted;

  // Handle action button clicks - stop propagation to prevent navigation
  const handleAddNote = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (actionsEnabled && onAddNote) {
      onAddNote(contact);
    }
  };

  const handleMarkContacted = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (actionsEnabled && onMarkContacted) {
      onMarkContacted(contact);
    }
  };

  // Tooltip content for disabled actions
  const disabledTooltip = "Switch to live data to enable actions";

  // CANONICAL: Use contactId for navigation, fall back to preventing navigation if missing
  const contactHref = contactId ? `/contact/${contactId}` : "#";

  return (
    <Link href={contactHref} data-testid={`link-priority-${testIdSlug}`}>
      <Card
        className={cn(
          "hover-elevate active-elevate-2 cursor-pointer transition-all duration-300 hover:translate-y-[-4px] hover:shadow-xl hover:shadow-black/10 dark:hover:shadow-black/30 hover:scale-[1.02] overflow-visible group",
          "bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm",
          priorityStyles[priority],
          isTopPriority && "ring-2 ring-offset-2 ring-offset-background/50",
          isTopPriority && priority === "high" && "ring-red-400/50 dark:ring-red-600/50 shadow-red-500/20 animate-subtle-pulse",
          isTopPriority && priority === "medium" && "ring-amber-400/50 dark:ring-amber-600/50 shadow-amber-500/20",
          isTopPriority && priority === "standard" && "ring-blue-400/50 dark:ring-blue-600/50 shadow-blue-500/20",
          // Visual feedback when handled
          isHandled && "opacity-60"
        )}
        data-testid={`priority-card-${testIdSlug}`}
      >
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              {position && (
                <span className={cn(
                  "flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold",
                  isTopPriority
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground",
                  // Show checkmark when handled
                  isHandled && "bg-green-500 text-white"
                )}>
                  {isHandled ? <Check className="h-3 w-3" /> : position}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className={cn(
                  "text-sm text-foreground truncate",
                  isTopPriority ? "font-semibold" : "font-medium"
                )}>
                  {contactName}
                </p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {contact?.serviceRequested || "—"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {/* Handled indicator */}
              {isHandled && (
                <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">
                  Done
                </span>
              )}
              <Badge
                variant="secondary"
                className={cn(
                  "text-xs font-bold shrink-0 tabular-nums",
                  urgencyBadgeStyles[urgency]
                )}
              >
                {days}d
              </Badge>
            </div>
          </div>

          {/* Owner badge row */}
          {contact?.assignedTo && (
            <div className="mt-2 pt-2 border-t border-border/30">
              <OwnerBadge
                email={contact.assignedTo}
                currentUserEmail={currentUserEmail}
                size="sm"
              />
            </div>
          )}

          {/* Hover context row with actions */}
          <div className="grid grid-rows-[0fr] group-hover:grid-rows-[1fr] transition-[grid-template-rows] duration-150">
            <div className="overflow-hidden">
              <div className="flex items-center justify-between pt-2 mt-2 border-t border-border/50">
                {/* Left: Context info */}
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Added {formatDateAdded(contact?.dateAdded)}
                  </span>
                  {comparisonText && (
                    <span className={cn(
                      "font-medium",
                      urgency === "critical" && "text-red-600 dark:text-red-400",
                      urgency === "urgent" && "text-amber-600 dark:text-amber-400"
                    )}>
                      {comparisonText}
                    </span>
                  )}
                </div>

                {/* Right: Action buttons (hover only) */}
                {hasActions && !isHandled && (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {onAddNote && (
                      <Tooltip delayDuration={200}>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={cn(
                              "h-6 px-2 text-[10px] gap-1",
                              !actionsEnabled && "opacity-50 cursor-not-allowed"
                            )}
                            onClick={handleAddNote}
                            disabled={!actionsEnabled}
                            data-testid={`button-add-note-${testIdSlug}`}
                          >
                            <MessageSquarePlus className="h-3 w-3" />
                            Note
                          </Button>
                        </TooltipTrigger>
                        {!actionsEnabled && (
                          <TooltipContent side="top" className="text-xs">
                            {disabledTooltip}
                          </TooltipContent>
                        )}
                      </Tooltip>
                    )}
                    {onMarkContacted && (
                      <Tooltip delayDuration={200}>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={cn(
                              "h-6 px-2 text-[10px] gap-1",
                              !actionsEnabled && "opacity-50 cursor-not-allowed"
                            )}
                            onClick={handleMarkContacted}
                            disabled={!actionsEnabled}
                            data-testid={`button-mark-contacted-${testIdSlug}`}
                          >
                            <CheckCircle className="h-3 w-3" />
                            Contacted
                          </Button>
                        </TooltipTrigger>
                        {!actionsEnabled && (
                          <TooltipContent side="top" className="text-xs">
                            {disabledTooltip}
                          </TooltipContent>
                        )}
                      </Tooltip>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
