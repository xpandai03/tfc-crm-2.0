import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Plus, Clock } from "lucide-react";
import type { WaitlistContact } from "@shared/schema";

interface DraggableCardProps {
  contact: WaitlistContact;
  onAddNote: (contact: WaitlistContact) => void;
  isDragging?: boolean;
}

export function DraggableCard({ contact, onAddNote, isDragging = false }: DraggableCardProps) {
  // CRITICAL: Use contactId as the canonical drag identifier
  // This ensures status updates target the correct Excel row
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: contact.contactId.toString(), // contactId is now required - use it as the drag ID
  });

  const isUrgent = contact.daysOnWaitlist > 60;
  const isWarning = contact.daysOnWaitlist > 30 && contact.daysOnWaitlist <= 60;

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
      }
    : undefined;

  const handleAddNoteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onAddNote(contact);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "touch-none",
        isDragging && "opacity-50"
      )}
    >
      <Card
        className={cn(
          "cursor-grab active:cursor-grabbing transition-all duration-200 overflow-visible group relative",
          isUrgent && "ring-1 ring-red-300 dark:ring-red-700",
          isDragging && "shadow-lg rotate-2 scale-105"
        )}
        {...attributes}
        {...listeners}
        data-testid={`card-contact-${contact.name.toLowerCase().replace(/\s+/g, '-')}`}
      >
        <CardContent className="p-3">
          <div className="flex items-start justify-between gap-2">
            <Link
              href={`/contact/${contact.contactId}`}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-w-0"
              data-testid={`link-contact-${contact.name.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <p className="font-medium text-sm text-foreground truncate hover:underline">
                {contact.name}
              </p>
            </Link>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
              onClick={handleAddNoteClick}
              data-testid={`button-add-note-${contact.name.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {contact.serviceRequested}
          </p>
          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>{contact.daysOnWaitlist}d</span>
            </div>
            {isUrgent && (
              <Badge variant="destructive" className="text-xs px-1.5 py-0">
                Urgent
              </Badge>
            )}
            {isWarning && !isUrgent && (
              <Badge variant="secondary" className="text-xs px-1.5 py-0 bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                30+ days
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
