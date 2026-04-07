import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { OwnerBadge } from "@/components/ui/owner-badge";
import { Link } from "wouter";
import { Calendar, Cake, UserCheck } from "lucide-react";
import type { WaitlistContact } from "@shared/schema";
import { cn, formatDate, formatDob } from "@/lib/utils";
import { isActiveStatus } from "@/lib/status-config";
import { computeDaysWaiting } from "@/lib/days-waiting";

interface KanbanCardProps {
  contact: WaitlistContact;
  currentUserEmail?: string;
}

export function KanbanCard({ contact, currentUserEmail }: KanbanCardProps) {
  const daysWaiting = computeDaysWaiting(contact.dateAdded, contact.daysOnWaitlist);
  const isUrgent = daysWaiting > 60;
  const isWarning = daysWaiting > 30 && daysWaiting <= 60;
  const isInactive = !isActiveStatus(contact.statusCode);

  // DATA INTEGRITY: Log warning if contactId is missing
  if (contact.contactId === undefined || contact.contactId === null) {
    console.warn("[KanbanCard] Missing contactId for contact:", contact.name);
  }

  // Format DOB for display — handles Excel serials, ISO, US formats
  const dobDisplay = (() => {
    const raw = contact?.patientDob;
    if (!raw) return null;
    const result = formatDob(raw);
    return result === "---" ? null : result;
  })();

  // CANONICAL: Use contactId for navigation
  const contactHref = contact.contactId ? `/contact/${contact.contactId}` : "#";

  return (
    <Link href={contactHref} data-testid={`link-contact-${contact.name.toLowerCase().replace(/\s+/g, '-')}`}>
      <Card
        className={cn(
          "hover-elevate active-elevate-2 cursor-pointer transition-all duration-300 hover:translate-y-[-4px] hover:shadow-xl hover:shadow-black/10 dark:hover:shadow-black/30 hover:scale-[1.01] overflow-visible group",
          "bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm",
          isUrgent && !isInactive && "ring-2 ring-red-400/50 dark:ring-red-600/50 shadow-red-500/20 animate-subtle-pulse",
          isInactive && "opacity-60"
        )}
        data-testid={`kanban-card-${contact.name.toLowerCase().replace(/\s+/g, '-')}`}
      >
        <CardContent className="p-3">
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <p className={cn("font-medium text-sm leading-tight", isInactive ? "text-muted-foreground" : "text-foreground")}>
                  {contact.name}
                </p>
                {isInactive && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 text-muted-foreground border-muted-foreground/30">
                    Inactive
                  </Badge>
                )}
              </div>
              <Badge
                variant="secondary"
                className={cn(
                  "text-xs shrink-0 backdrop-blur-sm border-white/40 dark:border-gray-700/40 shadow-md",
                  !isInactive && isUrgent && "bg-red-500/20 text-red-800 dark:bg-red-500/10 dark:text-red-300 border-red-500/30 dark:border-red-500/20 shadow-red-500/20",
                  !isInactive && isWarning && "bg-amber-500/20 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 border-amber-500/30 dark:border-amber-500/20 shadow-amber-500/20"
                )}
              >
                {daysWaiting}d
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {contact.requestingFor ?? contact.serviceRequested}
            </p>
            {/* Ownership row - always visible */}
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/30">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Assigned to:</span>
                {contact.assignedTo ? (
                  <OwnerBadge
                    email={contact.assignedTo}
                    currentUserEmail={currentUserEmail}
                    size="sm"
                  />
                ) : (
                  <span className="text-[10px] text-muted-foreground italic">Unassigned</span>
                )}
              </div>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Calendar className="h-3 w-3" />
                <span>{formatDate(contact.dateAdded)}</span>
              </div>
            </div>

            {/* Hover context: DOB */}
            <div className="grid grid-rows-[0fr] group-hover:grid-rows-[1fr] transition-[grid-template-rows] duration-150">
              <div className="overflow-hidden">
                <div className="pt-1 space-y-1">
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <Cake className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">DOB:</span>
                    <span className={cn(
                      "font-medium",
                      !dobDisplay ? "text-muted-foreground italic" : "text-foreground"
                    )}>
                      {dobDisplay || "---"}
                    </span>
                  </div>
                  {contact.assignedProviderName && (
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <UserCheck className="h-3 w-3 text-blue-500 flex-shrink-0" />
                      <span className="text-muted-foreground">Provider:</span>
                      <span className="font-medium truncate text-blue-700 dark:text-blue-300">
                        {contact.assignedProviderName}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
