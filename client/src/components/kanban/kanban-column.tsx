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
  intake: "bg-purple-500/20 dark:bg-purple-500/10 backdrop-blur-lg border-purple-500/30 dark:border-purple-500/20 shadow-lg shadow-purple-500/5",
  waiting: "bg-yellow-500/20 dark:bg-yellow-500/10 backdrop-blur-lg border-yellow-500/30 dark:border-yellow-500/20 shadow-lg shadow-yellow-500/5",
  ready_to_schedule: "bg-green-500/20 dark:bg-green-500/10 backdrop-blur-lg border-green-500/30 dark:border-green-500/20 shadow-lg shadow-green-500/5",
  scheduled: "bg-blue-500/20 dark:bg-blue-500/10 backdrop-blur-lg border-blue-500/30 dark:border-blue-500/20 shadow-lg shadow-blue-500/5",
  on_hold: "bg-gray-500/20 dark:bg-gray-500/10 backdrop-blur-lg border-gray-500/30 dark:border-gray-500/20 shadow-lg shadow-gray-500/5",
  closed: "bg-slate-500/20 dark:bg-slate-500/10 backdrop-blur-lg border-slate-500/30 dark:border-slate-500/20 shadow-lg shadow-slate-500/5",
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
      <div className="flex items-center justify-between p-3 border-b border-white/20 dark:border-gray-700/30 bg-white/30 dark:bg-gray-900/30 backdrop-blur-sm">
        <h3 className="font-medium text-sm text-foreground">{title}</h3>
        <Badge variant="secondary" className="text-xs bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm border-white/40 dark:border-gray-700/40 shadow-md">
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
            contacts.map((contact, index) => (
              <KanbanCard key={contact.contactId || `${contact.name}-${index}`} contact={contact} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
