import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { WaitlistContact, ContactStatus } from "@shared/schema";
import { KanbanCard } from "./kanban-card";

interface KanbanColumnProps {
  title: string;
  status: ContactStatus;
  contacts: WaitlistContact[];
  className?: string;
}

const columnStyles: Record<ContactStatus, string> = {
  intake: "bg-purple-50/50 dark:bg-purple-950/20",
  waiting: "bg-yellow-50/50 dark:bg-yellow-950/20",
  ready_to_schedule: "bg-green-50/50 dark:bg-green-950/20",
  scheduled: "bg-blue-50/50 dark:bg-blue-950/20",
  on_hold: "bg-gray-50/50 dark:bg-gray-800/20",
  closed: "bg-slate-50/50 dark:bg-slate-800/20",
};

export function KanbanColumn({
  title,
  status,
  contacts,
  className,
}: KanbanColumnProps) {
  return (
    <div
      className={cn(
        "flex flex-col min-w-[280px] max-w-[320px] rounded-lg border",
        columnStyles[status],
        className
      )}
      data-testid={`kanban-column-${status}`}
    >
      <div className="flex items-center justify-between p-3 border-b">
        <h3 className="font-medium text-sm text-foreground">{title}</h3>
        <Badge variant="secondary" className="text-xs">
          {contacts.length}
        </Badge>
      </div>
      <ScrollArea className="flex-1 p-2">
        <div className="space-y-2">
          {contacts.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No contacts
            </p>
          ) : (
            contacts.map((contact) => (
              <KanbanCard key={contact.name} contact={contact} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
