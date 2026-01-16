import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { PageLayout } from "@/components/layout/page-layout";
import { MetricCard } from "@/components/ui/metric-card";
import { PriorityCard } from "@/components/ui/priority-card";
import { AIInsightPanel } from "@/components/ui/ai-insight-panel";
import { QuickNoteModal } from "@/components/ui/quick-note-modal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from "@/components/ui/loading-spinner";
import { SyncStatus } from "@/components/ui/sync-status";
import { FallbackBanner } from "@/components/ui/fallback-banner";
import { AlertTriangle, Clock, CalendarCheck, AlertCircle, CheckCircle2, Inbox } from "lucide-react";
import { getWaitlistSummary, getWaitlistContacts, addNoteToContact, updateContactStatus, type WithSource } from "@/lib/api";
import { useDataSource } from "@/lib/data-source-context";
import { useAuth } from "@/lib/auth-context";
import {
  isActiveStatus,
  stringStatusToCode,
  safeNumber,
  STATUS_GROUPS,
} from "@/lib/status-config";
import { generateInsights } from "@/lib/insights";
import type { WaitlistSummary, WaitlistContact } from "@shared/schema";

/**
 * Home/Today View
 *
 * Priority queues are computed from contacts:
 * - Over 60 Days: daysOnWaitlist >= 60 AND active
 * - Ready to Schedule: statusCode in [200]
 * - Needs Follow-up: statusCode in waiting group (101, 102) AND 14 < days <= 60
 */

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

export default function Home() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { updateSummarySource, updateContactsSource, updateSyncTime, lastSyncTime, dataMode, summarySource, contactsSource, isContactsLive, isFullyLive } = useDataSource();
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Derive author initials from authenticated user
  const authorInitials = getAuthorInitials(user?.name);

  // Phase 3: Action state
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [selectedContact, setSelectedContact] = useState<WaitlistContact | null>(null);
  const [handledContacts, setHandledContacts] = useState<Set<string>>(new Set());

  // Check data sources for honest indicators
  // Only show as live when user has explicitly enabled live mode AND data is actually live
  const isSummaryLive = dataMode === "live" && summarySource === "live";
  const isDataFullyLive = dataMode === "live" && isFullyLive;

  // Phase 3: Actions are only enabled in live mode with live data
  const actionsEnabled = isDataFullyLive;

  const { 
    data: summaryData, 
    isLoading: summaryLoading, 
    error: summaryError,
    refetch: refetchSummary,
  } = useQuery<WithSource<WaitlistSummary>>({
    queryKey: ["/api/waitlist-summary"],
    queryFn: getWaitlistSummary,
  });

  const { 
    data: contactsData, 
    isLoading: contactsLoading, 
    error: contactsError,
    refetch: refetchContacts,
  } = useQuery<{ contacts: WaitlistContact[]; _source?: string }>({
    queryKey: ["/api/waitlist-contacts"],
    queryFn: getWaitlistContacts,
  });

  const isLoading = summaryLoading || contactsLoading;
  const error = summaryError || contactsError;

  const contacts = contactsData?.contacts || [];

  useEffect(() => {
    if (summaryData?._source) {
      updateSummarySource(summaryData._source as "mock" | "live" | "fallback");
      updateSyncTime();
    }
  }, [summaryData, updateSummarySource, updateSyncTime]);

  useEffect(() => {
    if (contactsData?._source) {
      updateContactsSource(contactsData._source as "mock" | "live" | "fallback");
    }
  }, [contactsData, updateContactsSource]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([refetchSummary(), refetchContacts()]);
    setIsRefreshing(false);
  };

  // Phase 3: Mutations for actions
  const { toast } = useToast();

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
      setNoteModalOpen(false);
      setSelectedContact(null);

      return { toastRef };
    },
    onSuccess: (_, variables, context) => {
      // Update toast to success
      if (context?.toastRef) {
        context.toastRef.update({
          id: context.toastRef.id,
          title: "Note added",
          description: "Note has been saved to Excel.",
        });
        setTimeout(() => context.toastRef.dismiss(), 2000);
      }

      // Mark contact as handled
      setHandledContacts(prev => new Set(prev).add(variables.contactId.toString()));
      // Refresh data to show updated note
      refetchContacts();
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

  const markContactedMutation = useMutation({
    mutationFn: ({ contactId }: { contactId: number }) =>
      // Status 102 = "Contacted - Waiting" (standard contacted status)
      updateContactStatus(contactId, 102),
    onMutate: async () => {
      // Create pending toast
      const toastRef = toast({
        title: "Marking contacted...",
        description: "Updating status",
      });

      return { toastRef };
    },
    onSuccess: (_, variables, context) => {
      // Update toast to success
      if (context?.toastRef) {
        context.toastRef.update({
          id: context.toastRef.id,
          title: "Marked contacted",
          description: "Status updated to Contacted - Waiting",
        });
        setTimeout(() => context.toastRef.dismiss(), 2000);
      }

      // Mark contact as handled
      setHandledContacts(prev => new Set(prev).add(variables.contactId.toString()));
      // Refresh data to reflect status change
      refetchContacts();
    },
    onError: (error, _variables, context) => {
      // Update toast to error
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (context?.toastRef) {
        context.toastRef.update({
          id: context.toastRef.id,
          title: "Failed to mark contacted",
          description: errorMessage,
          variant: "destructive",
        });
        setTimeout(() => context.toastRef.dismiss(), 5000);
      }
    },
  });

  // Phase 3: Action handlers
  const handleAddNote = useCallback((contact: WaitlistContact) => {
    setSelectedContact(contact);
    setNoteModalOpen(true);
  }, []);

  const handleSubmitNote = useCallback((note: string) => {
    if (selectedContact?.contactId) {
      // Generate timestamp and use derived author initials
      const timestamp = generateTimestamp();
      addNoteMutation.mutate({
        contactId: selectedContact.contactId,
        note,
        author: authorInitials,
        timestamp,
      });
    }
  }, [selectedContact, addNoteMutation, authorInitials]);

  const handleMarkContacted = useCallback((contact: WaitlistContact) => {
    if (contact?.contactId) {
      markContactedMutation.mutate({ contactId: contact.contactId });
    }
  }, [markContactedMutation]);

  // Helper to check if a contact has been handled
  const isContactHandled = useCallback((contact: WaitlistContact) => {
    return handledContacts.has(contact?.contactId?.toString() || "");
  }, [handledContacts]);

  // Handler for adding note from insight panel (by contactId - CANONICAL)
  const handleAddNoteFromInsight = useCallback((contactId: number) => {
    // Find the contact by contactId
    const contact = contacts.find(c => c.contactId === contactId);
    if (contact) {
      setSelectedContact(contact);
      setNoteModalOpen(true);
    } else {
      console.warn("[Home] Could not find contact for insight action, contactId:", contactId);
    }
  }, [contacts]);

  // Get the effective status code for a contact (handles both live and mock data)
  const getContactStatusCode = (contact: WaitlistContact): number => {
    return contact.statusCode ?? stringStatusToCode(contact.status);
  };

  // Compute metrics from contacts
  const computedMetrics = useMemo(() => {
    if (!contacts || contacts.length === 0) {
      return {
        totalActive: 0,
        avgWaitDays: 0,
        over60Days: 0,
        readyToSchedule: 0,
      };
    }

    const activeContacts = contacts.filter(c => {
      const statusCode = getContactStatusCode(c);
      return isActiveStatus(statusCode);
    });

    const totalActive = activeContacts.length;
    const avgWaitDays = totalActive > 0
      ? Math.round(activeContacts.reduce((sum, c) => sum + (c.daysOnWaitlist || 0), 0) / totalActive)
      : 0;
    const over60Days = activeContacts.filter(c => (c.daysOnWaitlist || 0) >= 60).length;
    const readyToSchedule = contacts.filter(c => getContactStatusCode(c) === 200).length;

    return { totalActive, avgWaitDays, over60Days, readyToSchedule };
  }, [contacts]);

  // Use frontend-computed metrics exclusively when we have contacts
  // Only fall back to summary for display when contacts are unavailable
  const metrics = useMemo(() => {
    // If we have contacts, use frontend-computed metrics (source of truth)
    if (contacts && contacts.length > 0) {
      return computedMetrics;
    }
    // No contacts loaded yet - use summary if available
    const summary = summaryData;
    return {
      totalActive: summary?.totalActive ?? 0,
      avgWaitDays: summary?.avgWaitDays ?? 0,
      over60Days: summary?.over60Days ?? 0,
      readyToSchedule: summary?.readyToSchedule ?? 0,
    };
  }, [computedMetrics, summaryData, contacts]);

  // Priority queues based on status codes, sorted by urgency (longest waiting first)
  const priorityQueues = useMemo(() => {
    if (!contacts || contacts.length === 0) {
      return { over60Days: [], readyToSchedule: [], needsFollowUp: [] };
    }

    // Sort helper: longest waiting first
    const sortByUrgency = (a: WaitlistContact, b: WaitlistContact) =>
      (b.daysOnWaitlist || 0) - (a.daysOnWaitlist || 0);

    const over60Days = contacts
      .filter(c => {
        const statusCode = getContactStatusCode(c);
        return (c.daysOnWaitlist || 0) >= 60 && isActiveStatus(statusCode);
      })
      .sort(sortByUrgency);

    const readyToSchedule = contacts
      .filter(c => {
        const statusCode = getContactStatusCode(c);
        return STATUS_GROUPS.ready_to_schedule.includes(statusCode as 200);
      })
      .sort(sortByUrgency);

    const needsFollowUp = contacts
      .filter(c => {
        const statusCode = getContactStatusCode(c);
        const days = c.daysOnWaitlist || 0;
        const isWaiting = (STATUS_GROUPS.waiting as readonly number[]).includes(statusCode);
        return isWaiting && days > 14 && days <= 60;
      })
      .sort(sortByUrgency);

    return { over60Days, readyToSchedule, needsFollowUp };
  }, [contacts]);

  // Generate dynamic insights from contacts and metrics
  const insights = useMemo(() => {
    return generateInsights(contacts, computedMetrics);
  }, [contacts, computedMetrics]);

  if (isLoading) {
    return (
      <PageLayout>
        <LoadingState message="Loading dashboard..." />
      </PageLayout>
    );
  }

  if (error || (!summaryData && contacts.length === 0)) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-muted-foreground">Failed to load dashboard data</p>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <FallbackBanner
        show={!isDataFullyLive}
        message={
          dataMode === "mock"
            ? "Viewing demo data"
            : isSummaryLive && !isContactsLive
              ? "Aggregate metrics are live — contact data is demo"
              : summarySource === "fallback"
                ? "Live data temporarily unavailable — showing cached data"
                : "Viewing demo data"
        }
        variant="info"
        lastSyncTime={lastSyncTime}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
      />
      <div className="space-y-8">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground" data-testid="text-page-title">Today</h1>
            <p className="text-sm text-muted-foreground mt-1" data-testid="text-page-subtitle">
              What needs your attention right now
            </p>
          </div>
          <SyncStatus 
            lastSyncTime={lastSyncTime} 
            onRefresh={handleRefresh}
            isRefreshing={isRefreshing}
          />
        </div>

        {/* Metrics Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard
            label="Active Waitlist"
            value={safeNumber(metrics.totalActive)}
            tooltip="Total contacts in active pipeline (excludes declined/inactive)"
          />
          <MetricCard
            label="Avg Wait Time"
            value={metrics.avgWaitDays > 0 ? `${metrics.avgWaitDays}d` : "---"}
            variant="warning"
            tooltip={`Calculated from ${metrics.totalActive} active contacts`}
          />
          <MetricCard
            label="Over 60 Days"
            value={safeNumber(metrics.over60Days)}
            variant="danger"
            tooltip="Contacts waiting 60+ days require immediate follow-up"
          />
          <MetricCard
            label="Ready to Schedule"
            value={safeNumber(metrics.readyToSchedule)}
            variant="success"
            tooltip="Contacts matched with providers, awaiting appointment"
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
          {/* Priority Queues */}
          <div className="xl:col-span-3 grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Over 60 Days */}
            <Card className="flex flex-col h-[calc(100vh-320px)] overflow-visible">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                  Over 60 Days
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col min-h-0 pt-0">
                <ScrollArea className="flex-1 pr-2">
                  <div className="space-y-2">
                    {priorityQueues.over60Days.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 text-center">
                        <CheckCircle2 className="h-8 w-8 text-green-500 mb-2" />
                        <p className="text-sm font-medium text-foreground">No urgent contacts</p>
                        <p className="text-xs text-muted-foreground mt-1">All contacts under 60 days</p>
                      </div>
                    ) : (
                      priorityQueues.over60Days.map((contact, index) => (
                        <PriorityCard
                          key={contact.contactId || `${contact.name}-${index}`}
                          contact={contact}
                          priority="high"
                          position={index + 1}
                          avgWaitDays={metrics.avgWaitDays}
                          actionsEnabled={actionsEnabled}
                          isHandled={isContactHandled(contact)}
                          onAddNote={handleAddNote}
                          onMarkContacted={handleMarkContacted}
                        />
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Ready to Schedule */}
            <Card className="flex flex-col h-[calc(100vh-320px)] overflow-visible">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <CalendarCheck className="h-4 w-4 text-amber-500" />
                  Ready to Schedule
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col min-h-0 pt-0">
                <ScrollArea className="flex-1 pr-2">
                  <div className="space-y-2">
                    {priorityQueues.readyToSchedule.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 text-center">
                        <Inbox className="h-8 w-8 text-muted-foreground/50 mb-2" />
                        <p className="text-sm font-medium text-foreground">No contacts ready</p>
                        <p className="text-xs text-muted-foreground mt-1">Contacts will appear when ready to schedule</p>
                      </div>
                    ) : (
                      priorityQueues.readyToSchedule.map((contact, index) => (
                        <PriorityCard
                          key={contact.contactId || `${contact.name}-${index}`}
                          contact={contact}
                          priority="medium"
                          position={index + 1}
                          avgWaitDays={metrics.avgWaitDays}
                          actionsEnabled={actionsEnabled}
                          isHandled={isContactHandled(contact)}
                          onAddNote={handleAddNote}
                          onMarkContacted={handleMarkContacted}
                        />
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Needs Follow-up */}
            <Card className="flex flex-col h-[calc(100vh-320px)] overflow-visible">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <Clock className="h-4 w-4 text-blue-500" />
                  Needs Follow-up
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col min-h-0 pt-0">
                <ScrollArea className="flex-1 pr-2">
                  <div className="space-y-2">
                    {priorityQueues.needsFollowUp.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 text-center">
                        <CheckCircle2 className="h-8 w-8 text-green-500 mb-2" />
                        <p className="text-sm font-medium text-foreground">All caught up!</p>
                        <p className="text-xs text-muted-foreground mt-1">No pending follow-ups needed</p>
                      </div>
                    ) : (
                      priorityQueues.needsFollowUp.map((contact, index) => (
                        <PriorityCard
                          key={contact.contactId || `${contact.name}-${index}`}
                          contact={contact}
                          priority="standard"
                          position={index + 1}
                          avgWaitDays={metrics.avgWaitDays}
                          actionsEnabled={actionsEnabled}
                          isHandled={isContactHandled(contact)}
                          onAddNote={handleAddNote}
                          onMarkContacted={handleMarkContacted}
                        />
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* AI Suggestions Panel */}
          <div className="xl:col-span-1 space-y-4">
            {insights.slice(0, 3).map((insight) => (
              <AIInsightPanel
                key={insight.id}
                insight={insight.message}
                dataPoints={insight.dataPoints}
                contactName={insight.contactName}
                contactId={insight.contactId} // CANONICAL: pass contactId for navigation/actions
                actionsEnabled={actionsEnabled}
                onAddNote={handleAddNoteFromInsight}
              />
            ))}

            {/* Work Queue Progress */}
            {handledContacts.size > 0 && (
              <Card className="bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <p className="text-sm font-medium text-green-700 dark:text-green-300">
                      {handledContacts.size} contact{handledContacts.size === 1 ? "" : "s"} handled today
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Quick Note Modal */}
      <QuickNoteModal
        isOpen={noteModalOpen}
        contactName={selectedContact?.name || ""}
        onClose={() => {
          setNoteModalOpen(false);
          setSelectedContact(null);
        }}
        onSubmit={handleSubmitNote}
      />
    </PageLayout>
  );
}
