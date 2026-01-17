import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { OwnerBadge } from "@/components/ui/owner-badge";
import { Link } from "wouter";
import { Calendar } from "lucide-react";
import type { WaitlistContact } from "@shared/schema";
import { cn } from "@/lib/utils";

interface KanbanCardProps {
  contact: WaitlistContact;
  currentUserEmail?: string;
}

export function KanbanCard({ contact, currentUserEmail }: KanbanCardProps) {
  const isUrgent = contact.daysOnWaitlist > 60;
  const isWarning = contact.daysOnWaitlist > 30 && contact.daysOnWaitlist <= 60;

  // DATA INTEGRITY: Log warning if contactId is missing
  if (contact.contactId === undefined || contact.contactId === null) {
    console.warn("[KanbanCard] Missing contactId for contact:", contact.name);
  }

  // CANONICAL: Use contactId for navigation
  const contactHref = contact.contactId ? `/contact/${contact.contactId}` : "#";

  return (
    <Link href={contactHref} data-testid={`link-contact-${contact.name.toLowerCase().replace(/\s+/g, '-')}`}>
      <Card
        className={cn(
          "hover-elevate active-elevate-2 cursor-pointer transition-all duration-300 hover:translate-y-[-4px] hover:shadow-xl hover:shadow-black/10 dark:hover:shadow-black/30 hover:scale-[1.01] overflow-visible",
          "bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm",
          isUrgent && "ring-2 ring-red-400/50 dark:ring-red-600/50 shadow-red-500/20 animate-subtle-pulse"
        )}
        data-testid={`kanban-card-${contact.name.toLowerCase().replace(/\s+/g, '-')}`}
      >
        <CardContent className="p-3">
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium text-sm text-foreground leading-tight">
                {contact.name}
              </p>
              <Badge
                variant="secondary"
                className={cn(
                  "text-xs shrink-0 backdrop-blur-sm border-white/40 dark:border-gray-700/40 shadow-md",
                  isUrgent && "bg-red-500/20 text-red-800 dark:bg-red-500/10 dark:text-red-300 border-red-500/30 dark:border-red-500/20 shadow-red-500/20",
                  isWarning && "bg-amber-500/20 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 border-amber-500/30 dark:border-amber-500/20 shadow-amber-500/20"
                )}
              >
                {contact.daysOnWaitlist}d
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {contact.serviceRequested}
            </p>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Calendar className="h-3 w-3" />
                <span>Added {contact.dateAdded}</span>
              </div>
              {contact.assignedTo && (
                <OwnerBadge
                  email={contact.assignedTo}
                  currentUserEmail={currentUserEmail}
                  size="sm"
                />
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
