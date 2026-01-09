import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { PageLayout } from "@/components/layout/page-layout";
import { DroppableColumn } from "@/components/kanban/droppable-column";
import { DraggableCard } from "@/components/kanban/draggable-card";
import { QuickNoteModal } from "@/components/ui/quick-note-modal";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { LoadingState } from "@/components/ui/loading-spinner";
import { SyncStatus } from "@/components/ui/sync-status";
import { FallbackBanner } from "@/components/ui/fallback-banner";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle } from "lucide-react";
import { getWaitlistContacts, updateContactStatus, addNoteToContact } from "@/lib/api";
import { useDataSource } from "@/lib/data-source-context";
import { 
  PIPELINE_COLUMNS, 
  getColumnForStatus, 
  stringStatusToCode,
  type PipelineColumnId 
} from "@/lib/status-config";
import type { WaitlistContact } from "@shared/schema";

export default function Waitlist() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { updateSource, updateSyncTime, lastSyncTime, isFallback } = useDataSource();
  const [activeCard, setActiveCard] = useState<WaitlistContact | null>(null);
  const [noteModalContact, setNoteModalContact] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const { 
    data: contactsData, 
    isLoading, 
    error,
    refetch: refetchContacts,
  } = useQuery<{ contacts: WaitlistContact[]; _source?: string }>({
    queryKey: ["/api/waitlist-contacts"],
    queryFn: getWaitlistContacts,
  });

  const contacts = contactsData?.contacts;

  useEffect(() => {
    if (contactsData?._source) {
      updateSource(contactsData._source as "mock" | "live" | "fallback");
      updateSyncTime();
    }
  }, [contactsData, updateSource, updateSyncTime]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refetchContacts();
    setIsRefreshing(false);
  };

  const updateStatusMutation = useMutation({
    mutationFn: ({ contactName, statusCode }: { contactName: string; statusCode: number }) =>
      updateContactStatus(contactName, statusCode),
    onMutate: async ({ contactName, statusCode }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/waitlist-contacts"] });
      const previousData = queryClient.getQueryData<{ contacts: WaitlistContact[]; _source?: string }>(["/api/waitlist-contacts"]);
      queryClient.setQueryData<{ contacts: WaitlistContact[]; _source?: string }>(["/api/waitlist-contacts"], (old) => {
        if (!old) return old;
        return {
          ...old,
          contacts: old.contacts.map((c) =>
            c.name === contactName ? { ...c, statusCode } : c
          ),
        };
      });
      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-summary"] });
    },
    onError: (_error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(["/api/waitlist-contacts"], context.previousData);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-summary"] });
      toast({
        title: "Failed to update status",
        description: `Could not update ${variables.contactName}. Please try again.`,
        variant: "destructive",
      });
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: ({ contactName, note }: { contactName: string; note: string }) =>
      addNoteToContact(contactName, note),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contact", variables.contactName] });
      setNoteModalContact(null);
      toast({
        title: "Note added",
        description: `Note added to ${variables.contactName}`,
      });
    },
    onError: (error, variables) => {
      toast({
        title: "Failed to add note",
        description: `Could not add note to ${variables.contactName}. Please try again.`,
        variant: "destructive",
      });
    },
  });

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const draggedContact = contacts?.find((c) => c.name === active.id);
    setActiveCard(draggedContact || null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveCard(null);

    if (!over || !contacts) return;

    const contactName = active.id as string;
    const targetColumnId = over.id as PipelineColumnId | "other";
    const contact = contacts.find((c) => c.name === contactName);

    if (!contact) return;

    // Get the current column for this contact
    const currentStatusCode = contact.statusCode ?? stringStatusToCode(contact.status);
    const currentColumn = getColumnForStatus(currentStatusCode);

    if (currentColumn === targetColumnId) return;

    // Get the first status code for the target column
    const targetColumn = PIPELINE_COLUMNS.find(col => col.id === targetColumnId);
    if (!targetColumn) return;

    const newStatusCode = targetColumn.codes[0];

    toast({
      title: "Status updated",
      description: `${contactName} moved to ${targetColumn.label}`,
    });

    updateStatusMutation.mutate({ contactName, statusCode: newStatusCode });
  };

  const handleAddNote = (contactName: string) => {
    setNoteModalContact(contactName);
  };

  const handleSubmitNote = (note: string) => {
    if (noteModalContact) {
      addNoteMutation.mutate({ contactName: noteModalContact, note });
    }
  };

  // Get the effective status code for a contact (handles both live and mock data)
  const getContactStatusCode = (contact: WaitlistContact): number => {
    return contact.statusCode ?? stringStatusToCode(contact.status);
  };

  // Group contacts by pipeline column based on status codes
  const getContactsByColumn = (columnId: PipelineColumnId): WaitlistContact[] => {
    if (!contacts) return [];
    return contacts.filter((c) => {
      const statusCode = getContactStatusCode(c);
      return getColumnForStatus(statusCode) === columnId;
    });
  };

  // Get contacts that don't match any known column (for "Other" column)
  const getUnknownContacts = (): WaitlistContact[] => {
    if (!contacts) return [];
    return contacts.filter((c) => {
      const statusCode = getContactStatusCode(c);
      return getColumnForStatus(statusCode) === "other";
    });
  };

  if (isLoading) {
    return (
      <PageLayout>
        <LoadingState message="Loading waitlist..." />
      </PageLayout>
    );
  }

  if (error || !contacts || !Array.isArray(contacts)) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-muted-foreground">Failed to load waitlist data</p>
        </div>
      </PageLayout>
    );
  }

  const unknownContacts = getUnknownContacts();

  return (
    <PageLayout>
      <FallbackBanner show={isFallback} />
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground" data-testid="text-page-title">Waitlist Pipeline</h1>
            <p className="text-sm text-muted-foreground mt-1" data-testid="text-page-subtitle">
              Drag cards between columns to update status
            </p>
          </div>
          <SyncStatus 
            lastSyncTime={lastSyncTime} 
            onRefresh={handleRefresh}
            isRefreshing={isRefreshing}
          />
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <ScrollArea className="w-full">
            <div className="flex gap-4 pb-4 min-w-max">
              {PIPELINE_COLUMNS.map((column) => (
                <DroppableColumn
                  key={column.id}
                  columnId={column.id}
                  title={column.label}
                  contacts={getContactsByColumn(column.id)}
                  onAddNote={handleAddNote}
                  className="h-[calc(100vh-220px)] min-h-[400px]"
                />
              ))}
              {unknownContacts.length > 0 && (
                <DroppableColumn
                  key="other"
                  columnId="other"
                  title="Needs Review"
                  contacts={unknownContacts}
                  onAddNote={handleAddNote}
                  className="h-[calc(100vh-220px)] min-h-[400px]"
                />
              )}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>

          <DragOverlay>
            {activeCard ? (
              <DraggableCard contact={activeCard} isDragging onAddNote={() => {}} />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <QuickNoteModal
        isOpen={!!noteModalContact}
        contactName={noteModalContact || ""}
        onClose={() => setNoteModalContact(null)}
        onSubmit={handleSubmitNote}
        isSubmitting={addNoteMutation.isPending}
      />
    </PageLayout>
  );
}
