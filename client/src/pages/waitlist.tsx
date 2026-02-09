import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearch, useLocation } from "wouter";
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
import { WaitlistListView } from "@/components/waitlist/waitlist-list-view";
import { QuickNoteModal } from "@/components/ui/quick-note-modal";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { PageLoader } from "@/components/ui/page-loader";
import { SyncStatus } from "@/components/ui/sync-status";
import { FallbackBanner } from "@/components/ui/fallback-banner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, LayoutGrid, List, User } from "lucide-react";
import { StatusLegendModal } from "@/components/ui/status-legend-modal";
import { getWaitlistBoard, updateContactStatus, addNoteToContact } from "@/lib/api";
import { useDataSource } from "@/lib/data-source-context";
import { useAuth } from "@/lib/auth-context";
import {
  PIPELINE_COLUMNS,
  getColumnForStatus,
  getUmbrellaForStatus,
  getEntryStatusForUmbrella,
  stringStatusToCode,
  type PipelineColumnId,
  type UmbrellaId,
} from "@/lib/status-config";
import type { WaitlistContact } from "@shared/schema";

/**
 * NOTE:
 * Kanban requires contact-level rows.
 * Aggregates alone are insufficient.
 * Do NOT mark Kanban as live unless rows come from Excel-backed source.
 */
// View mode type
type ViewMode = "kanban" | "list";

// localStorage key for view preference
const VIEW_MODE_KEY = "waitlist-view-mode";

// Helper to derive author initials from full name
function getAuthorInitials(name: string | undefined): string {
  if (!name || name.trim() === "") return "??";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].substring(0, 2).toUpperCase();
  }
  return parts
    .map((p) => p[0])
    .join("")
    .toUpperCase()
    .substring(0, 3); // Max 3 initials
}

// Helper to generate timestamp in consistent format
function generateTimestamp(): string {
  return new Date().toISOString();
}

export default function Waitlist() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { updateContactsSource, updateSyncTime, lastSyncTime } = useDataSource();
  const [activeCard, setActiveCard] = useState<WaitlistContact | null>(null);
  const [noteModalContact, setNoteModalContact] = useState<{ contactId: number; name: string } | null>(null);
  const [, setLocation] = useLocation();

  // Parse URL query params for drill-down filtering from Insights
  const searchString = useSearch();
  const urlParams = useMemo(() => {
    const params = new URLSearchParams(searchString);
    return {
      insurance: params.get("insurance"),
      modality: params.get("modality"),
      status: params.get("status"),
      umbrella: params.get("umbrella"),
    };
  }, [searchString]);

  // Check if any filter params are present (for forcing list view)
  const hasFilterParams = !!(urlParams.insurance || urlParams.modality || urlParams.status || urlParams.umbrella);

  // Derive author initials from authenticated user
  const authorInitials = getAuthorInitials(user?.name);

  // View mode state - persisted in localStorage
  // Force list view when URL filter params are present
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    // If URL has filter params, force list view
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("insurance") || params.get("modality") || params.get("status") || params.get("umbrella")) {
        return "list";
      }
      const saved = localStorage.getItem(VIEW_MODE_KEY);
      if (saved === "kanban" || saved === "list") {
        return saved;
      }
    }
    return "kanban";
  });

  // Force list view when filter params are added via navigation
  useEffect(() => {
    if (hasFilterParams && viewMode !== "list") {
      setViewMode("list");
    }
  }, [hasFilterParams, viewMode]);

  // Persist view mode to localStorage (only when not filter-driven)
  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem(VIEW_MODE_KEY, mode);
    // Clear URL params when switching views manually
    if (hasFilterParams) {
      setLocation("/waitlist");
    }
  };
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Task ownership filter state
  const [showOnlyMine, setShowOnlyMine] = useState(false);

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
    queryKey: ["/api/get-waitlist-board"],
    queryFn: getWaitlistBoard,
  });

  const allContacts = contactsData?.contacts;

  // Filter contacts by ownership if toggle is enabled
  // Normalize both sides: trim whitespace, lowercase, treat empty string as unassigned
  const contacts = useMemo(() => {
    if (!allContacts || allContacts.length === 0) return allContacts;
    if (!showOnlyMine || !user?.email) return allContacts;
    const normalizedUserEmail = user.email.trim().toLowerCase();
    return allContacts.filter(c => {
      const assigned = c.assignedTo?.trim().toLowerCase();
      return assigned && assigned === normalizedUserEmail;
    });
  }, [allContacts, showOnlyMine, user?.email]);

  // Waitlist page is authoritative over its own data source
  // Use board response _source directly - ignore context state
  const isLiveBoard = contactsData?._source === "live";
  const isDemoMode = !isLiveBoard;
  
  // Debug log to verify data source (REQUIRED - DO NOT REMOVE)
  console.log("WAITLIST PAGE RENDER", {
    boardSource: contactsData?._source,
    contactsCount: contactsData?.contacts?.length,
    hasData: !!contactsData,
    isLiveBoard,
    isDemoMode,
  });

  useEffect(() => {
    if (contactsData?._source) {
      updateContactsSource(contactsData._source as "mock" | "live" | "fallback");
      updateSyncTime();
    }
  }, [contactsData, updateContactsSource, updateSyncTime]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refetchContacts();
    setIsRefreshing(false);
  };

  // Extended mutation variables for better debugging and UX
  type StatusUpdateVars = {
    contactId: number;
    contactName: string; // For display only
    statusCode: number;
    previousStatus?: number;
    targetLabel?: string;
  };

  const updateStatusMutation = useMutation({
    mutationFn: ({ contactId, statusCode }: StatusUpdateVars) =>
      updateContactStatus(contactId, statusCode),
    onMutate: async ({ contactId, statusCode }) => {
      // Cancel outgoing refetches to prevent overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: ["/api/get-waitlist-board"] });

      // Snapshot previous value for rollback
      const previousData = queryClient.getQueryData<{ contacts: WaitlistContact[]; _source?: string }>(["/api/get-waitlist-board"]);

      // Optimistically update the cache using contactId
      queryClient.setQueryData<{ contacts: WaitlistContact[]; _source?: string }>(["/api/get-waitlist-board"], (old) => {
        if (!old) return old;
        return {
          ...old,
          contacts: old.contacts.map((c) =>
            c.contactId === contactId ? { ...c, statusCode } : c
          ),
        };
      });

      return { previousData };
    },
    onSuccess: (_data, variables) => {
      // Invalidate to refetch fresh data
      queryClient.invalidateQueries({ queryKey: ["/api/get-waitlist-board"] });
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contact", variables.contactId] });

      // Show success toast
      toast({
        title: "Status updated",
        description: `${variables.contactName} moved to ${variables.targetLabel || "new status"}`,
      });

      console.log("[waitlist] Status update succeeded:", variables);
    },
    onError: (error, variables, context) => {
      // Rollback to previous state
      if (context?.previousData) {
        queryClient.setQueryData(["/api/get-waitlist-board"], context.previousData);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-summary"] });

      // Extract error message
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      console.error("[waitlist] Status update failed:", {
        contactId: variables.contactId,
        contactName: variables.contactName,
        attemptedStatus: variables.statusCode,
        previousStatus: variables.previousStatus,
        error: errorMessage,
      });

      toast({
        title: "Failed to update status",
        description: `Could not update ${variables.contactName}. ${errorMessage}`,
        variant: "destructive",
      });
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: ({ contactId, note, author, timestamp }: {
      contactId: number;
      note: string;
      author: string;
      timestamp: string;
    }) => addNoteToContact({ contactId, note, author, timestamp }),
    onMutate: async () => {
      // Create pending toast
      const toastRef = toast({
        title: "Adding note...",
        description: "Saving to Excel",
      });

      // Close modal immediately (optimistic)
      setNoteModalContact(null);

      return { toastRef };
    },
    onSuccess: (_data, variables, context) => {
      // Update toast to success
      if (context?.toastRef) {
        context.toastRef.update({
          id: context.toastRef.id,
          title: "Note added",
          description: "Note has been saved to Excel.",
        });
        setTimeout(() => context.toastRef.dismiss(), 2000);
      }

      // Refetch to reconcile with server
      queryClient.invalidateQueries({ queryKey: ["/api/get-waitlist-board"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contact", variables.contactId] });
    },
    onError: (error, _variables, context) => {
      // Update toast to error
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (context?.toastRef) {
        context.toastRef.update({
          id: context.toastRef.id,
          title: "Failed to add note",
          description: errorMessage,
          variant: "destructive",
        });
        setTimeout(() => context.toastRef.dismiss(), 5000);
      }
    },
  });

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    // CANONICAL: Look up by contactId (the drag ID is now contactId.toString())
    const draggedContactId = parseInt(active.id as string, 10);
    const draggedContact = contacts?.find((c) => c.contactId === draggedContactId);
    setActiveCard(draggedContact || null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveCard(null);

    // Disable drag in demo mode
    if (isDemoMode) {
      toast({
        title: "Demo Mode",
        description: "Status updates are disabled when viewing demo data.",
        variant: "destructive",
      });
      return;
    }

    if (!over || !contacts) return;

    // CANONICAL: Parse contactId from the drag ID (now uses contactId.toString())
    const draggedContactId = parseInt(active.id as string, 10);
    const targetColumnId = over.id as PipelineColumnId | "other";

    // Look up contact by contactId - the ONLY valid identifier
    const contact = contacts.find((c) => c.contactId === draggedContactId);

    // DATA INTEGRITY GUARD: Reject if contact not found or contactId is invalid
    if (!contact) {
      console.error("[DATA INTEGRITY ERROR] Contact not found for drag ID:", active.id);
      toast({
        title: "Error",
        description: "Contact not found. Please refresh the page.",
        variant: "destructive",
      });
      return;
    }

    // Get the current umbrella for this contact
    const currentStatusCode = contact.statusCode ?? stringStatusToCode(contact.status);
    const currentUmbrella = getUmbrellaForStatus(currentStatusCode);

    // No-op: dropping on "other" column or same umbrella
    if (targetColumnId === "other") return;
    if (currentUmbrella === targetColumnId) return;

    // Get the entry status code for the target umbrella
    // Entry status = the default status assigned when moving to this workflow stage
    const newStatusCode = getEntryStatusForUmbrella(targetColumnId as UmbrellaId);
    const targetColumn = PIPELINE_COLUMNS.find(col => col.id === targetColumnId);

    // Log the update attempt for debugging - contactId is the canonical identifier
    console.log("[waitlist] Drag status update:", {
      contactId: contact.contactId,
      contactName: contact.name, // For debugging only
      fromStatus: currentStatusCode,
      toStatus: newStatusCode,
      targetUmbrella: targetColumnId,
    });

    // Show pending toast
    toast({
      title: "Updating status...",
      description: `Moving ${contact.name} to ${targetColumn?.label ?? targetColumnId}`,
    });

    // Execute mutation with contactId as the canonical identifier
    updateStatusMutation.mutate({
      contactId: contact.contactId,
      contactName: contact.name, // For display only
      statusCode: newStatusCode,
      previousStatus: currentStatusCode,
      targetLabel: targetColumn?.label ?? targetColumnId,
    });
  };

  const handleAddNote = (contact: WaitlistContact) => {
    // Disable notes in demo mode
    if (isDemoMode) {
      toast({
        title: "Demo Mode",
        description: "Adding notes is disabled when viewing demo data.",
        variant: "destructive",
      });
      return;
    }
    // DATA INTEGRITY GUARD: contactId is now required but check at runtime
    if (contact.contactId === undefined || contact.contactId === null) {
      console.error("[DATA INTEGRITY ERROR] Missing contactId for add note:", contact.name);
      toast({
        title: "Data Error",
        description: "Contact is missing an ID. Please refresh and try again.",
        variant: "destructive",
      });
      return;
    }
    setNoteModalContact({ contactId: contact.contactId, name: contact.name });
  };

  const handleSubmitNote = (note: string) => {
    if (noteModalContact) {
      // Generate timestamp and use derived author initials
      const timestamp = generateTimestamp();
      addNoteMutation.mutate({
        contactId: noteModalContact.contactId,
        note,
        author: authorInitials,
        timestamp,
      });
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
        <PageLoader context="waitlist" />
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

  // Generate demo mode banner message
  const getDemoBannerMessage = () => {
    return "Showing demo data. Click 'Enable Live Excel' in header to connect.";
  };

  return (
    <PageLayout>
      <FallbackBanner 
        show={isDemoMode} 
        message={getDemoBannerMessage()}
        variant="info"
      />
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground" data-testid="text-page-title">Waitlist Pipeline</h1>
            <p className="text-sm text-muted-foreground mt-1" data-testid="text-page-subtitle">
              {viewMode === "kanban"
                ? isDemoMode
                  ? "Demo rows (drag & drop disabled)"
                  : "Drag cards between columns to update status"
                : "Click a row to view contact details"
              }
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Assigned to Me filter toggle */}
            <div className="flex items-center gap-2 bg-white/60 dark:bg-gray-900/60 backdrop-blur-sm rounded-lg px-3 py-2 border border-white/20 dark:border-gray-700/30">
              <User className="h-4 w-4 text-muted-foreground" />
              <Switch
                id="waitlist-show-only-mine"
                checked={showOnlyMine}
                onCheckedChange={setShowOnlyMine}
              />
              <Label htmlFor="waitlist-show-only-mine" className="text-sm cursor-pointer">
                Assigned to Me
              </Label>
            </div>

            {/* View Toggle */}
            <div className="flex items-center border rounded-md">
              <Button
                variant={viewMode === "kanban" ? "default" : "ghost"}
                size="sm"
                className="rounded-r-none"
                onClick={() => handleViewModeChange("kanban")}
              >
                <LayoutGrid className="h-4 w-4 mr-1" />
                Kanban
              </Button>
              <Button
                variant={viewMode === "list" ? "default" : "ghost"}
                size="sm"
                className="rounded-l-none"
                onClick={() => handleViewModeChange("list")}
              >
                <List className="h-4 w-4 mr-1" />
                List
              </Button>
            </div>

            <StatusLegendModal />
            <SyncStatus
              lastSyncTime={lastSyncTime}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
            />
          </div>
        </div>

        {/* Conditional View Rendering */}
        {viewMode === "kanban" ? (
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
                    color={column.color as "slate" | "amber" | "purple" | "red"}
                    className="h-[calc(100vh-220px)] min-h-[400px]"
                    currentUserEmail={user?.email}
                    isInactiveColumn={column.id === "INS"}
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
                    currentUserEmail={user?.email}
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
        ) : (
          <WaitlistListView 
            contacts={contacts} 
            currentUserEmail={user?.email}
            initialInsuranceFilter={urlParams.insurance}
            initialModalityFilter={urlParams.modality}
            initialStatusFilter={urlParams.status}
            initialUmbrellaFilter={urlParams.umbrella}
          />
        )}
      </div>

      <QuickNoteModal
        isOpen={!!noteModalContact}
        contactName={noteModalContact?.name || ""}
        onClose={() => setNoteModalContact(null)}
        onSubmit={handleSubmitNote}
      />
    </PageLayout>
  );
}
