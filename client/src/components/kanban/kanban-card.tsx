import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { Calendar } from "lucide-react";
import type { WaitlistContact } from "@shared/schema";
import { cn } from "@/lib/utils";

interface KanbanCardProps {
  contact: WaitlistContact;
}

export function KanbanCard({ contact }: KanbanCardProps) {
  const isUrgent = contact.daysOnWaitlist > 60;
  const isWarning = contact.daysOnWaitlist > 30 && contact.daysOnWaitlist <= 60;

  return (
    <Link href={`/contact/${encodeURIComponent(contact.name)}`} data-testid={`link-contact-${contact.name.toLowerCase().replace(/\s+/g, '-')}`}>
      <Card
        className={cn(
          "hover-elevate active-elevate-2 cursor-pointer transition-transform duration-200 hover:translate-y-[-1px] overflow-visible",
          isUrgent && "ring-1 ring-red-300 dark:ring-red-700"
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
                  "text-xs shrink-0",
                  isUrgent && "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
                  isWarning && "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                )}
              >
                {contact.daysOnWaitlist}d
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {contact.serviceRequested}
            </p>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              <span>Added {contact.dateAdded}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
