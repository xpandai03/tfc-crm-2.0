import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import type { WaitlistContact } from "@shared/schema";

interface PriorityCardProps {
  contact: WaitlistContact;
  priority: "high" | "medium" | "standard";
}

const priorityStyles = {
  high: "border-l-4 border-l-red-500",
  medium: "border-l-4 border-l-amber-500",
  standard: "border-l-4 border-l-blue-500",
};

export function PriorityCard({ contact, priority }: PriorityCardProps) {
  return (
    <Link href={`/contact/${encodeURIComponent(contact.name)}`} data-testid={`link-priority-${contact.name.toLowerCase().replace(/\s+/g, '-')}`}>
      <Card
        className={cn(
          "hover-elevate active-elevate-2 cursor-pointer transition-transform duration-200 hover:translate-y-[-2px] overflow-visible",
          priorityStyles[priority]
        )}
        data-testid={`priority-card-${contact.name.toLowerCase().replace(/\s+/g, '-')}`}
      >
        <CardContent className="p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm text-foreground truncate">
                {contact.name}
              </p>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {contact.serviceRequested}
              </p>
            </div>
            <Badge
              variant="secondary"
              className={cn(
                "text-xs font-semibold shrink-0",
                priority === "high" && "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
                priority === "medium" && "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
                priority === "standard" && "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
              )}
            >
              {contact.daysOnWaitlist}d
            </Badge>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
