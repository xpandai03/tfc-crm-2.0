import { useDroppable } from "@dnd-kit/core";
import { DraggableCard } from "./draggable-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { WaitlistContact } from "@shared/schema";

interface DroppableColumnProps {
  columnId: string;
  title: string;
  contacts: WaitlistContact[];
  onAddNote: (contactName: string) => void;
  className?: string;
}

export function DroppableColumn({
  columnId,
  title,
  contacts,
  onAddNote,
  className,
}: DroppableColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: columnId,
  });

  return (
    <Card
      ref={setNodeRef}
      className={cn(
        "w-[280px] flex-shrink-0 flex flex-col overflow-visible transition-colors duration-200",
        isOver && "ring-2 ring-primary ring-offset-2",
        className
      )}
      data-testid={`column-${columnId}`}
    >
      <CardHeader className="pb-3 flex-shrink-0">
        <CardTitle className="flex items-center justify-between">
          <span className="text-sm font-medium">{title}</span>
          <Badge variant="secondary" className="ml-2" data-testid={`badge-count-${columnId}`}>
            {contacts.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 pt-0 overflow-hidden">
        <ScrollArea className="h-full pr-2">
          <div className="space-y-2">
            {contacts.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                No contacts
              </div>
            ) : (
              contacts.map((contact) => (
                <DraggableCard
                  key={contact.name}
                  contact={contact}
                  onAddNote={onAddNote}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
