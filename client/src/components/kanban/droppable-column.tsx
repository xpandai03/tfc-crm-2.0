import { useDroppable } from "@dnd-kit/core";
import { DraggableCard } from "./draggable-card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { WaitlistContact } from "@shared/schema";

interface DroppableColumnProps {
  columnId: string;
  title: string;
  contacts: WaitlistContact[];
  onAddNote: (contact: WaitlistContact) => void;
  className?: string;
  color?: "slate" | "amber" | "purple" | "red";
  currentUserEmail?: string;
  isInactiveColumn?: boolean;
}

// Color scheme mapping for umbrella columns
const colorStyles = {
  slate: {
    header: "bg-slate-50 dark:bg-slate-900/50",
    badge: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    border: "border-slate-200 dark:border-slate-800",
  },
  amber: {
    header: "bg-amber-50 dark:bg-amber-900/30",
    badge: "bg-amber-200 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
    border: "border-amber-200 dark:border-amber-800",
  },
  purple: {
    header: "bg-purple-50 dark:bg-purple-900/30",
    badge: "bg-purple-200 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
    border: "border-purple-200 dark:border-purple-800",
  },
  red: {
    header: "bg-red-50 dark:bg-red-900/30",
    badge: "bg-red-200 text-red-800 dark:bg-red-900/50 dark:text-red-300",
    border: "border-red-200 dark:border-red-800",
  },
};

export function DroppableColumn({
  columnId,
  title,
  contacts,
  onAddNote,
  className,
  color = "slate",
  currentUserEmail,
  isInactiveColumn = false,
}: DroppableColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: columnId,
  });

  const styles = colorStyles[color] || colorStyles.slate;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "w-[290px] flex-shrink-0 flex flex-col rounded-xl bg-white/50 dark:bg-gray-900/30 border border-gray-200/50 dark:border-gray-800/50 transition-colors duration-200",
        isOver && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        isInactiveColumn && "opacity-75",
        className
      )}
      data-testid={`column-${columnId}`}
    >
      <div className={cn("px-4 py-3 flex-shrink-0 rounded-t-xl border-b border-gray-200/40 dark:border-gray-800/40", styles.header)}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">
            {title}
          </span>
          <Badge className={cn("ml-2", styles.badge)} data-testid={`badge-count-${columnId}`}>
            {isInactiveColumn ? `${contacts.length} inactive` : contacts.length}
          </Badge>
        </div>
      </div>
      <div className="flex-1 pt-3 px-2 pb-2 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="space-y-2.5 px-1 pb-1">
            {contacts.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                No contacts
              </div>
            ) : (
              contacts.map((contact, index) => (
                <DraggableCard
                  key={contact.contactId || `${contact.name}-${index}`}
                  contact={contact}
                  onAddNote={onAddNote}
                  currentUserEmail={currentUserEmail}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
