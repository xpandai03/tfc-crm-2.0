import { useParams, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo, useRef } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { AIInsightPanel } from "@/components/ui/ai-insight-panel";
import { getStatusLabel } from "@/components/ui/status-badge";
import { Timeline } from "@/components/ui/timeline";
import { TimelineErrorBoundary } from "@/components/ui/timeline-error-boundary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { FallbackBanner } from "@/components/ui/fallback-banner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChevronLeft,
  Mail,
  Phone,
  Calendar,
  User,
  Clock,
  Activity,
  AlertCircle,
  AlertTriangle,
  FileText,
  Users,
  Bell,
  MessageSquareWarning,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RotateCcw,
  UserPlus,
  RefreshCw,
} from "lucide-react";
import { getContactSnapshot, updateContactStatus, addNoteToContact, createReminder, assignContact, getIntakeComments, createIntakeComment, getAttentionFlags, clearAttentionFlag, getTherapyNotesStatus, createTherapyNotesPatient, resetTherapyNotesLink, getAssignments, syncContactFromExcel, type WithSource, type IntakeComment, type ProviderAssignment } from "@/lib/api";
import { ReminderModal } from "@/components/ui/reminder-modal";
import { AssignProviderModal } from "@/components/ui/assign-provider-modal";
import { SendEmailModal } from "@/components/ui/send-email-modal";
import { AssignmentSelector } from "@/components/ui/assignment-selector";
import { useDataSource } from "@/lib/data-source-context";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";
import type { ContactSnapshot, WaitlistContact } from "@shared/schema";
import { buildTimelineEvents, formatFullDate, type EmailSnapshotMeta } from "@/lib/timeline";
import { ProviderMatchingModal } from "@/components/ui/provider-matching-modal";
import { CreateTnModal } from "@/components/ui/create-tn-modal";
import { cn, formatDate, formatDob } from "@/lib/utils";
import {
  STATUS_UMBRELLAS,
  STATUS_LABELS,
  getUmbrellaForStatus,
  type UmbrellaId,
} from "@/lib/status-config";

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

export default function ContactDetail() {
  const params = useParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();

  // Derive author initials from authenticated user
  const authorInitials = getAuthorInitials(user?.name);

  // Parse contactId from URL - this is now the canonical identifier
  const contactId = params.id ? parseInt(params.id, 10) : null;
  const isValidId = contactId !== null && !isNaN(contactId) && contactId > 0;

  const { updateSource, updateSyncTime, isFallback } = useDataSource();

  const {
    data: contactData,
    isLoading,
    error,
  } = useQuery<WithSource<ContactSnapshot>>({
    queryKey: ["/api/contact", contactId],
    queryFn: () => getContactSnapshot(contactId!),
    enabled: isValidId,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const contact = contactData;

  useEffect(() => {
    if (contactData?._source) {
      updateSource(contactData._source as "mock" | "live" | "fallback");
      updateSyncTime();

      // Defensive: Log data integrity warnings for missing critical fields
      if (contactData.statusCode === undefined) {
        console.warn(`[DATA_INTEGRITY] Contact ${contactId} missing statusCode`);
      }
      if (!contactData.name) {
        console.warn(`[DATA_INTEGRITY] Contact ${contactId} missing name`);
      }
      if (!contactData.dateAdded) {
        console.warn(`[DATA_INTEGRITY] Contact ${contactId} (${contactData.name}) missing dateAdded`);
      }
    }
  }, [contactData, contactId, updateSource, updateSyncTime]);

  const [newNote, setNewNote] = useState("");
  const [showProviderMatching, setShowProviderMatching] = useState(false);
  const [showReminderModal, setShowReminderModal] = useState(false);
  const [showSendEmailModal, setShowSendEmailModal] = useState(false);
  const [showCreateTnModal, setShowCreateTnModal] = useState(false);
  const [showAssignProviderModal, setShowAssignProviderModal] = useState(false);
  const [isCreatingReminder, setIsCreatingReminder] = useState(false);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);

  // TherapyNotes integration
  const TN_ALLOWED_EMAILS = ["raunek@tfc.health", "dawn@tfc.health", "amanda@tfc.health", "chantel@tfc.health", "jmontano@tfc.health", "lsego@tfc.health"];
  const canUseTn = !!user?.email && TN_ALLOWED_EMAILS.includes(user.email.toLowerCase());

  const { data: tnData, refetch: refetchTn } = useQuery({
    queryKey: ["/api/therapy-notes", contactId],
    queryFn: () => getTherapyNotesStatus(Number(contactId)),
    enabled: !!contactId && canUseTn,
    refetchInterval: (query) => {
      return query.state.data?.record?.tnStatus === "in_progress" ? 3000 : false;
    },
  });
  const tnRecord = tnData?.record ?? null;

  const createTnMutation = useMutation({
    mutationFn: () => createTherapyNotesPatient(Number(contactId), contact?.name),
    onSuccess: () => {
      toast({ title: "TherapyNotes creation started", description: "This may take 30-40 seconds..." });
      setShowCreateTnModal(false);
      refetchTn();
    },
    onError: (err: Error) => {
      const is409 = err.message.startsWith("409");
      if (is409) {
        toast({ title: "Already in progress", description: "TherapyNotes patient creation is already running." });
        setShowCreateTnModal(false);
        refetchTn();
      } else {
        toast({ title: "Failed to start TherapyNotes creation", description: err.message, variant: "destructive" });
      }
    },
  });

  const resetTnMutation = useMutation({
    mutationFn: () => resetTherapyNotesLink(Number(contactId)),
    onSuccess: () => {
      toast({ title: "TherapyNotes link reset", description: "You can now re-create the patient." });
      refetchTn();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to reset TherapyNotes link", description: err.message, variant: "destructive" });
    },
  });

  // Optimistic assignment state - tracks the UI value independently from query cache
  const [optimisticAssignee, setOptimisticAssignee] = useState<string | null | undefined>(undefined);
  const [isAssigning, setIsAssigning] = useState(false);

  // Sync optimistic state with server data when it changes (and we're not in the middle of an assignment)
  useEffect(() => {
    if (!isAssigning && contact?.assignedTo !== undefined) {
      setOptimisticAssignee(contact.assignedTo);
    }
  }, [contact?.assignedTo, isAssigning]);

  // The displayed assignee value - use optimistic state if set, otherwise fall back to contact data
  const displayedAssignee = optimisticAssignee !== undefined ? optimisticAssignee : (contact?.assignedTo || null);

  // Assignment handler with optimistic update and rollback
  const handleAssignmentChange = async (newAssignee: string | null) => {
    if (!contactId) return;

    const previousAssignee = displayedAssignee;

    // Optimistic update - immediately show the new value
    setOptimisticAssignee(newAssignee);
    setIsAssigning(true);

    // Show pending toast
    const toastRef = toast({
      title: "Updating assignment...",
      description: newAssignee ? `Assigning to ${newAssignee}` : "Removing assignment",
    });

    try {
      await assignContact(contactId, newAssignee);

      // Success - update toast
      toastRef.update({
        id: toastRef.id,
        title: "Assignment updated",
        description: newAssignee ? `Assigned to ${newAssignee}` : "Unassigned",
      });
      setTimeout(() => toastRef.dismiss(), 2000);

      // Optimistically update board cache so "Assigned to Me" filter reflects
      // the change immediately, even if n8n hasn't propagated yet
      const normalizedAssignee = newAssignee?.trim() || undefined;
      queryClient.setQueryData<{ contacts: WaitlistContact[]; _source?: string }>(
        ["/api/get-waitlist-board"],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            contacts: old.contacts.map(c =>
              c.contactId === contactId ? { ...c, assignedTo: normalizedAssignee } : c
            ),
          };
        }
      );

      // Invalidate queries to sync with server (will refetch in background)
      queryClient.invalidateQueries({ queryKey: ["/api/contact", contactId] });
      queryClient.invalidateQueries({ queryKey: ["/api/staff-list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/get-waitlist-board"] });
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-contacts"] });
    } catch (error) {
      // Rollback on error
      setOptimisticAssignee(previousAssignee);

      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toastRef.update({
        id: toastRef.id,
        title: "Assignment failed",
        description: `Could not update record. ${errorMessage}`,
        variant: "destructive",
      });
      setTimeout(() => toastRef.dismiss(), 5000);
    } finally {
      setIsAssigning(false);
    }
  };

  // Quick Action: prefill note and focus textarea
  const prefillNote = (text: string) => {
    setNewNote(text);
    // Focus textarea after state update
    setTimeout(() => {
      noteTextareaRef.current?.focus();
    }, 0);
  };

  // Status update mutation - same logic as Kanban drag
  // Optimistic update with toast lifecycle
  const updateStatusMutation = useMutation({
    mutationFn: ({ contactId, statusCode }: { contactId: number; statusCode: number }) =>
      updateContactStatus(contactId, statusCode),
    onMutate: async (variables) => {
      // Create pending toast
      const toastRef = toast({
        title: "Updating status...",
        description: `Changing to ${STATUS_LABELS[variables.statusCode] || variables.statusCode}`,
      });

      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["/api/contact", variables.contactId] });

      // Snapshot current data for rollback
      const previousData = queryClient.getQueryData<WithSource<ContactSnapshot>>(["/api/contact", variables.contactId]);

      // Optimistically update cache with new status
      if (previousData) {
        queryClient.setQueryData<WithSource<ContactSnapshot>>(
          ["/api/contact", variables.contactId],
          {
            ...previousData,
            statusCode: variables.statusCode,
          }
        );
      }

      return { toastRef, previousData };
    },
    onSuccess: (_data, variables, context) => {
      // Update toast to success
      if (context?.toastRef) {
        context.toastRef.update({
          id: context.toastRef.id,
          title: "Status updated",
          description: `Status changed to ${STATUS_LABELS[variables.statusCode] || variables.statusCode}`,
        });
        setTimeout(() => context.toastRef.dismiss(), 2000);
      }

      // Re-fetch to reconcile with server
      queryClient.invalidateQueries({ queryKey: ["/api/contact", variables.contactId] });
      queryClient.invalidateQueries({ queryKey: ["/api/get-waitlist-board"] });
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-summary"] });
    },
    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousData) {
        queryClient.setQueryData(["/api/contact", variables.contactId], context.previousData);
      }

      // Update toast to error
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (context?.toastRef) {
        context.toastRef.update({
          id: context.toastRef.id,
          title: "Failed to update status",
          description: errorMessage,
          variant: "destructive",
        });
        setTimeout(() => context.toastRef.dismiss(), 5000);
      }
    },
  });

  // Add note mutation - uses author initials and timestamp
  // Optimistic update with toast lifecycle
  const addNoteMutation = useMutation({
    mutationFn: ({ contactId, note, author, timestamp }: {
      contactId: number;
      note: string;
      author: string;
      timestamp: string;
    }) => addNoteToContact({ contactId, note, author, timestamp }),
    onMutate: async (variables) => {
      // Create pending toast and capture reference
      const toastRef = toast({
        title: "Adding note...",
        description: "Saving to Excel",
      });

      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["/api/contact", variables.contactId] });

      // Snapshot current data for rollback
      const previousData = queryClient.getQueryData<WithSource<ContactSnapshot>>(["/api/contact", variables.contactId]);

      // Optimistically update cache with new note
      if (previousData) {
        const optimisticNote = {
          date: variables.timestamp,
          content: variables.note,
          author: variables.author,
        };
        queryClient.setQueryData<WithSource<ContactSnapshot>>(
          ["/api/contact", variables.contactId],
          {
            ...previousData,
            notes: [optimisticNote, ...(previousData.notes || [])],
          }
        );
      }

      // Clear input immediately (optimistic)
      setNewNote("");

      return { toastRef, previousData };
    },
    onSuccess: (_data, variables, context) => {
      // Update toast to success
      if (context?.toastRef) {
        context.toastRef.update({
          id: context.toastRef.id,
          title: "Note added",
          description: "Your note has been saved to Excel.",
        });
        setTimeout(() => context.toastRef.dismiss(), 2000);
      }

      // Re-fetch to reconcile with server (refetchType: "active" ensures immediate network refetch)
      queryClient.invalidateQueries({ queryKey: ["/api/contact", variables.contactId], refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-contacts"], refetchType: "active" });
    },
    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousData) {
        queryClient.setQueryData(["/api/contact", variables.contactId], context.previousData);
      }

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

  // ============================================================================
  // Intake Comments & Attention Flags
  // ============================================================================
  const [intakeComment, setIntakeComment] = useState("");

  const { data: commentsData } = useQuery({
    queryKey: ["/api/intake-comments", contactId],
    queryFn: () => getIntakeComments(contactId!),
    enabled: isValidId,
  });

  const { data: flagsData } = useQuery({
    queryKey: ["/api/attention-flags"],
    queryFn: getAttentionFlags,
  });

  const { data: snapshotsData } = useQuery<{ snapshots: EmailSnapshotMeta[] }>({
    queryKey: ["/api/email-snapshots", contactId],
    queryFn: async () => {
      const res = await fetch(`/api/email-snapshots/${contactId}`);
      if (!res.ok) throw new Error("Failed to fetch email snapshots");
      return res.json();
    },
    enabled: isValidId,
  });

  // Provider assignments query
  const { data: assignmentsData } = useQuery({
    queryKey: ["/api/assignments", contactId],
    queryFn: () => getAssignments(contactId!),
    enabled: isValidId,
  });

  const assignments = assignmentsData?.assignments || [];
  const latestAssignment = assignments.length > 0 ? assignments[0] : null;

  const isContactFlagged = useMemo(() => {
    if (!flagsData?.flags || !contactId) return false;
    return flagsData.flags.some(f => f.contactId === contactId);
  }, [flagsData, contactId]);

  const intakeComments = commentsData?.comments || [];

  const addIntakeCommentMutation = useMutation({
    mutationFn: (params: { contactId: number; contactName: string; authorEmail: string; authorInitials: string; commentText: string }) =>
      createIntakeComment(params),
    onSuccess: () => {
      toast({ title: "Comment added", description: "Intake comment saved and contact flagged for attention." });
      setIntakeComment("");
      queryClient.invalidateQueries({ queryKey: ["/api/intake-comments", contactId] });
      queryClient.invalidateQueries({ queryKey: ["/api/attention-flags"] });
    },
    onError: (error) => {
      toast({ title: "Failed to add comment", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    },
  });

  const clearFlagMutation = useMutation({
    mutationFn: (params: { contactId: number; clearedByEmail: string }) =>
      clearAttentionFlag(params.contactId, params.clearedByEmail),
    onSuccess: () => {
      toast({ title: "Flag cleared", description: "Attention flag has been resolved." });
      queryClient.invalidateQueries({ queryKey: ["/api/attention-flags"] });
    },
    onError: (error) => {
      toast({ title: "Failed to clear flag", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    },
  });

  const handleAddIntakeComment = () => {
    if (!contactId || !intakeComment.trim() || !user?.email) return;
    addIntakeCommentMutation.mutate({
      contactId,
      contactName: contact?.name || "Unknown",
      authorEmail: user.email,
      authorInitials: authorInitials,
      commentText: intakeComment.trim(),
    });
  };

  const handleClearFlag = () => {
    if (!contactId || !user?.email) return;
    clearFlagMutation.mutate({ contactId, clearedByEmail: user.email });
  };

  // Manual sync from Excel
  const syncFromExcelMutation = useMutation({
    mutationFn: (id: number) => syncContactFromExcel(id),
    onSuccess: () => {
      toast({ title: "Contact synced", description: "Fresh data loaded from Excel." });
      queryClient.invalidateQueries({ queryKey: ["/api/contact", contactId] });
    },
    onError: (error) => {
      toast({ title: "Sync failed", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    },
  });

  // Handle status change from dropdown
  const handleStatusChange = (statusCode: number) => {
    if (!contactId) return;
    updateStatusMutation.mutate({ contactId, statusCode });
  };

  // Handle add note - derives author and timestamp automatically
  const handleAddNote = () => {
    if (!contactId || !newNote.trim()) return;

    // Generate timestamp and use derived author initials
    const timestamp = generateTimestamp();

    addNoteMutation.mutate({
      contactId,
      note: newNote.trim(),
      author: authorInitials,
      timestamp,
    });
  };

  // Handle create reminder - fire-and-forget with toast feedback
  const handleCreateReminder = async (params: {
    contactId: number;
    contactName: string;
    createdByEmail: string;
    reminderText: string;
    reminderDateTime: string;
    secondReminderDateTime?: string;
  }) => {
    setIsCreatingReminder(true);
    try {
      await createReminder(params);

      // Format date for toast
      const reminderDate = new Date(params.reminderDateTime);
      const formattedDate = reminderDate.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

      toast({
        title: "Reminder scheduled",
        description: `You'll be emailed on ${formattedDate}`,
      });

      setShowReminderModal(false);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toast({
        title: "Failed to create reminder",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsCreatingReminder(false);
    }
  };

  // Get current status code from contact data
  const currentStatusCode = contact?.statusCode ?? 100;

  // Build timeline events from contact data (fail-soft)
  const timelineEvents = useMemo(() => {
    if (!contact) return [];
    try {
      console.log("[contact-detail] Building timeline for:", contact.name, {
        hasNotes: !!contact.notes,
        notesLength: contact.notes?.length,
        dateAdded: contact.dateAdded,
        source: contactData?._source,
      });
      return buildTimelineEvents(
        {
          ...contact,
          _source: contactData?._source as "live" | "mock" | undefined,
        },
        snapshotsData?.snapshots,
        assignments,
      );
    } catch (e) {
      console.error("[contact-detail] Error building timeline events:", e);
      return [];
    }
  }, [contact, contactData?._source, snapshotsData?.snapshots, assignments]);

  // Derive "Last Contact" date from most recent note in timeline
  // Falls back to contact.lastContact if no timeline notes exist
  const derivedLastContact = useMemo(() => {
    // First check if contact has an explicit lastContact value
    if (contact?.lastContact) {
      return contact.lastContact;
    }

    // Find the most recent note event (not milestone) from timeline
    const mostRecentNote = timelineEvents.find(
      (event) => event.type === "note" && event.timestamp
    );

    if (mostRecentNote?.timestamp) {
      return formatFullDate(mostRecentNote.timestamp);
    }

    return null;
  }, [contact?.lastContact, timelineEvents]);

  // Check if we have enough data for Quick Actions
  const hasEmail = !!contact?.email;
  const hasPhone = !!contact?.phone;

  // Handle invalid contact ID
  if (!isValidId) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16">
          <AlertCircle className="h-8 w-8 text-destructive mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">
            Invalid Contact ID
          </h2>
          <p className="text-muted-foreground mb-4">
            The contact ID "{params.id}" is not valid.
          </p>
          <Link href="/waitlist">
            <Button variant="outline">
              <ChevronLeft className="h-4 w-4 mr-1" />
              Back to Waitlist
            </Button>
          </Link>
        </div>
      </PageLayout>
    );
  }

  // Two-phase rendering: Show error state only after loading completes with error
  if (!isLoading && (error || !contact)) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16">
          <AlertCircle className="h-8 w-8 text-destructive mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">
            Contact Not Found
          </h2>
          <p className="text-muted-foreground mb-4">
            Could not find contact with ID {contactId}
          </p>
          <Link href="/waitlist">
            <Button variant="outline">
              <ChevronLeft className="h-4 w-4 mr-1" />
              Back to Waitlist
            </Button>
          </Link>
        </div>
      </PageLayout>
    );
  }

  // Display name from contact data
  const displayName = contact?.name || "Unknown Contact";

  // Defensive: safely generate initials
  const initials = (() => {
    try {
      if (!displayName || displayName === "Unknown Contact") return "?";
      return displayName
        .split(" ")
        .filter(n => n && n.length > 0)
        .map((n) => n[0])
        .join("")
        .toUpperCase() || "?";
    } catch {
      return "?";
    }
  })();

  // Safe access to contact fields with defaults
  const daysWaiting = contact?.daysOnWaitlist ?? 0;
  const dateAdded = formatDate(contact?.dateAdded);
  const serviceRequested = contact?.serviceRequested || "Unknown Service";
  const contactStatus = contact?.status || "intake";

  const aiInsight = daysWaiting > 60
    ? `${displayName} has been waiting ${daysWaiting} days, which is above the 60-day threshold. This may indicate a provider availability issue or specific service requirements.`
    : contactStatus === "ready_to_schedule"
    ? `${displayName} is ready to schedule. A provider has been matched and appointment options should be sent soon.`
    : `${displayName} is progressing normally through the intake process.`;

  return (
    <PageLayout>
      <FallbackBanner show={isFallback} />
      <div className="space-y-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm" data-testid="nav-breadcrumb">
          <Link href="/" data-testid="link-breadcrumb-today">
            <span className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
              Today
            </span>
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link href="/waitlist" data-testid="link-breadcrumb-waitlist">
            <span className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
              Waitlist
            </span>
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="text-foreground font-medium" data-testid="text-breadcrumb-current">{displayName}</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Contact Header */}
            <Card className="overflow-visible bg-white/90 dark:bg-gray-800/90 backdrop-blur-md">
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  {isLoading ? (
                    <Skeleton className="h-16 w-16 rounded-full" />
                  ) : (
                    <Avatar className="h-16 w-16">
                      <AvatarFallback className="text-lg bg-primary/10 text-primary">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div>
                        {isLoading ? (
                          <>
                            <Skeleton className="h-8 w-48 mb-2" />
                            <Skeleton className="h-5 w-32" />
                          </>
                        ) : (
                          <>
                            <h1 className="text-2xl font-semibold text-foreground" data-testid="text-contact-name">
                              {displayName}
                            </h1>
                            <p className="text-muted-foreground">
                              {serviceRequested}
                            </p>
                          </>
                        )}
                      </div>
                      {isLoading ? (
                        <Skeleton className="h-10 w-[200px]" />
                      ) : (
                        <div className="flex items-end gap-2">
                          <div className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground font-medium">Workflow Status</span>
                            <Select
                              value={currentStatusCode.toString()}
                              onValueChange={(val) => handleStatusChange(parseInt(val, 10))}
                            >
                              <SelectTrigger className="w-[200px]" data-testid="select-status">
                                <SelectValue>
                                  {STATUS_LABELS[currentStatusCode] || `Status ${currentStatusCode}`}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {Object.entries(STATUS_LABELS).map(([code, label]) => (
                                  <SelectItem key={code} value={code}>
                                    {code} - {label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={syncFromExcelMutation.isPending}
                            onClick={() => { if (contactId) syncFromExcelMutation.mutate(contactId); }}
                            className="h-9"
                          >
                            <RefreshCw className={cn("h-4 w-4 mr-1.5", syncFromExcelMutation.isPending && "animate-spin")} />
                            {syncFromExcelMutation.isPending ? "Syncing..." : "Refresh"}
                          </Button>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-4 mt-4 text-sm">
                      {isLoading ? (
                        <>
                          <Skeleton className="h-5 w-32" />
                          <Skeleton className="h-5 w-28" />
                        </>
                      ) : (
                        <>
                          {contact?.email && (
                            <div className="flex items-center gap-1.5 text-muted-foreground">
                              <Mail className="h-4 w-4" />
                              <span>{contact.email}</span>
                            </div>
                          )}
                          {contact?.phone && (
                            <div className="flex items-center gap-1.5 text-muted-foreground">
                              <Phone className="h-4 w-4" />
                              <span>{contact.phone}</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Status Info */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Card className="overflow-visible bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Clock className="h-4 w-4" />
                    <span className="text-xs">Days Waiting</span>
                  </div>
                  {isLoading ? (
                    <Skeleton className="h-8 w-12" />
                  ) : (
                    <p className="text-2xl font-bold text-foreground" data-testid="text-days-waiting">
                      {daysWaiting}
                    </p>
                  )}
                </CardContent>
              </Card>
              <Card className="overflow-visible bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Calendar className="h-4 w-4" />
                    <span className="text-xs">Date Added</span>
                  </div>
                  {isLoading ? (
                    <Skeleton className="h-5 w-24" />
                  ) : (
                    <p className="text-sm font-medium text-foreground" data-testid="text-date-added">
                      {dateAdded}
                    </p>
                  )}
                </CardContent>
              </Card>
              <Card className="overflow-visible bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Calendar className="h-4 w-4" />
                    <span className="text-xs">Last Contact</span>
                  </div>
                  {isLoading ? (
                    <Skeleton className="h-5 w-24" />
                  ) : (
                    <p className="text-sm font-medium text-foreground" data-testid="text-last-contact">
                      {derivedLastContact || "N/A"}
                    </p>
                  )}
                </CardContent>
              </Card>
              <Card className="overflow-visible bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <User className="h-4 w-4" />
                    <span className="text-xs">Assigned To</span>
                  </div>
                  {isLoading ? (
                    <Skeleton className="h-9 w-full" />
                  ) : contactId ? (
                    <AssignmentSelector
                      contactId={contactId}
                      value={displayedAssignee}
                      onChange={handleAssignmentChange}
                      isLoading={isAssigning}
                    />
                  ) : (
                    <p className="text-sm font-medium text-foreground" data-testid="text-assigned-to">
                      Unassigned
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Activity Timeline - Parsed from Excel "Notes added by agent" column */}
            <Card className="overflow-visible bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <Activity className="h-4 w-4" />
                  Activity Timeline
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Chronological history from Excel notes
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Add Note */}
                <div className="space-y-2">
                  <Textarea
                    ref={noteTextareaRef}
                    placeholder="Add a note..."
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    className="min-h-[80px] resize-none"
                    data-testid="input-note"
                  />
                  <Button
                    size="sm"
                    disabled={!newNote.trim()}
                    onClick={handleAddNote}
                    data-testid="button-add-note"
                  >
                    Add Note
                  </Button>
                </div>

                <Separator />

                {/* Contact Timeline (wrapped in error boundary) */}
                <TimelineErrorBoundary contactName={displayName}>
                  <Timeline events={timelineEvents} />
                </TimelineErrorBoundary>
              </CardContent>
            </Card>
          </div>

          {/* AI Insight Sidebar */}
          <div className="lg:col-span-1">
            <div className="lg:sticky lg:top-20 space-y-4">
              <AIInsightPanel
                insight={aiInsight}
                suggestedAction={
                  daysWaiting > 60
                    ? "Review provider availability for this service type."
                    : contactStatus === "ready_to_schedule"
                    ? "Send appointment options to the contact."
                    : undefined
                }
                actionLabel={
                  daysWaiting > 60
                    ? "Check Providers"
                    : "Send Options"
                }
              />

              {/* Intake Summary - Read-only intake state from Excel row (Phase 6.2) */}
              <Card className={cn("overflow-visible", isContactFlagged && "ring-2 ring-amber-400/50 dark:ring-amber-500/40")}>
                {/* Attention Required banner */}
                {isContactFlagged && (
                  <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/50 rounded-t-lg">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                      <span className="text-sm font-medium text-amber-800 dark:text-amber-300">Attention Required</span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                      onClick={handleClearFlag}
                      disabled={clearFlagMutation.isPending}
                    >
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Mark Resolved
                    </Button>
                  </div>
                )}
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Intake Summary
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Read-only · From Excel intake form
                  </p>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  {/* Intake Details Section */}
                  {(contact?.requestingFor || contact?.reasonForSeeking || contact?.reasonForTherapy || contact?.formCompletedBy || contact?.modality) && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Intake Details</h4>
                      {contact.requestingFor && (
                        <div>
                          <span className="text-muted-foreground text-xs">Requesting For:</span>
                          <p className="font-medium text-foreground">{contact.requestingFor}</p>
                        </div>
                      )}
                      {contact.reasonForSeeking && (
                        <div>
                          <span className="text-muted-foreground text-xs">Reason:</span>
                          <p className="font-medium text-foreground">{contact.reasonForSeeking}</p>
                        </div>
                      )}
                      {contact.reasonForTherapy && (
                        <div>
                          <span className="text-muted-foreground text-xs">Reason(s) for Therapy:</span>
                          <p className="font-medium text-foreground">{contact.reasonForTherapy}</p>
                        </div>
                      )}
                      {contact.modality && (
                        <div>
                          <span className="text-muted-foreground text-xs">Modality:</span>
                          <p className="font-medium text-foreground">{contact.modality}</p>
                        </div>
                      )}
                      {contact.formCompletedBy && (
                        <div>
                          <span className="text-muted-foreground text-xs">Form Completed By:</span>
                          <p className="font-medium text-foreground">{contact.formCompletedBy}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Insurance Section (Phase 6.3 expanded) */}
                  {(contact?.insurancePayer || contact?.insurancePlan || contact?.insuranceId || contact?.insuranceStatus) && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Insurance</h4>
                      {contact.insurancePayer && (
                        <div>
                          <span className="text-muted-foreground text-xs">Payer:</span>
                          <p className="font-medium text-foreground">{contact.insurancePayer}</p>
                        </div>
                      )}
                      {contact.insurancePlan && (
                        <div>
                          <span className="text-muted-foreground text-xs">Plan:</span>
                          <p className="font-medium text-foreground">{contact.insurancePlan}</p>
                        </div>
                      )}
                      {contact.insuranceId && (
                        <div>
                          <span className="text-muted-foreground text-xs">Member ID:</span>
                          <p className="font-medium text-foreground">{contact.insuranceId}</p>
                        </div>
                      )}
                      {contact.insuranceStatus && (
                        <div>
                          <span className="text-muted-foreground text-xs">Status:</span>
                          <p className="font-medium text-foreground">{contact.insuranceStatus}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Referral Section (Phase 6.3) */}
                  {(contact?.referralSource || contact?.referralAuth || contact?.referralStatus || contact?.priorServices || contact?.priorProvider) && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Referral & History</h4>
                      {contact.referralSource && (
                        <div>
                          <span className="text-muted-foreground text-xs">Referral Source:</span>
                          <p className="font-medium text-foreground">{contact.referralSource}</p>
                        </div>
                      )}
                      {contact.referralAuth && (
                        <div>
                          <span className="text-muted-foreground text-xs">Authorization:</span>
                          <p className="font-medium text-foreground">{contact.referralAuth}</p>
                        </div>
                      )}
                      {contact.referralStatus && (
                        <div>
                          <span className="text-muted-foreground text-xs">Referral Status:</span>
                          <p className="font-medium text-foreground">{contact.referralStatus}</p>
                        </div>
                      )}
                      {contact.priorServices && (
                        <div>
                          <span className="text-muted-foreground text-xs">Prior Services:</span>
                          <p className="font-medium text-foreground">{contact.priorServices}</p>
                        </div>
                      )}
                      {contact.priorProvider && (
                        <div>
                          <span className="text-muted-foreground text-xs">Prior Provider:</span>
                          <p className="font-medium text-foreground">{contact.priorProvider}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Demographics Section (Phase 6.2) */}
                  {(contact?.patientDob || contact?.gender) && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Demographics</h4>
                      {contact.patientDob && (
                        <div>
                          <span className="text-muted-foreground text-xs">Date of Birth:</span>
                          <p className="font-medium text-foreground">{formatDob(contact.patientDob)}</p>
                        </div>
                      )}
                      {contact.gender && (
                        <div>
                          <span className="text-muted-foreground text-xs">Gender:</span>
                          <p className="font-medium text-foreground">{contact.gender}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Address Section (Phase 6.2) */}
                  {(contact?.streetAddress || contact?.city || contact?.state || contact?.zipCode) && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Address</h4>
                      <div>
                        {contact.streetAddress && (
                          <p className="font-medium text-foreground">{contact.streetAddress}</p>
                        )}
                        {(contact.city || contact.state || contact.zipCode) && (
                          <p className="font-medium text-foreground">
                            {[contact.city, contact.state, contact.zipCode].filter(Boolean).join(", ")}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Contact Preferences Section (Phase 6.2) */}
                  {contact?.preferredContact && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Preferences</h4>
                      <div>
                        <span className="text-muted-foreground text-xs">Preferred Contact:</span>
                        <p className="font-medium text-foreground">{contact.preferredContact}</p>
                      </div>
                    </div>
                  )}

                  {/* Admin / Flags Section (Phase 6.3) */}
                  {(contact?.custody || contact?.flags || contact?.priority) && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Admin</h4>
                      {contact.custody && (
                        <div>
                          <span className="text-muted-foreground text-xs">Custody:</span>
                          <p className="font-medium text-foreground">{contact.custody}</p>
                        </div>
                      )}
                      {contact.flags && (
                        <div>
                          <span className="text-muted-foreground text-xs">Flags:</span>
                          <p className="font-medium text-foreground text-amber-600">{contact.flags}</p>
                        </div>
                      )}
                      {contact.priority && (
                        <div>
                          <span className="text-muted-foreground text-xs">Priority:</span>
                          <p className="font-medium text-foreground">{contact.priority}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Links Section (Phase 6.3 - CRITICAL) */}
                  {(contact?.rfsLink || contact?.documentLink) && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Documents</h4>
                      {contact.rfsLink && (
                        <div>
                          <a
                            href={contact.rfsLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-primary hover:underline flex items-center gap-1"
                          >
                            <FileText className="h-3 w-3" />
                            Open RFS Form
                          </a>
                        </div>
                      )}
                      {contact.documentLink && (
                        <div>
                          <a
                            href={contact.documentLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-primary hover:underline flex items-center gap-1"
                          >
                            <FileText className="h-3 w-3" />
                            View Documents
                          </a>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Empty state if no intake fields */}
                  {!contact?.requestingFor && !contact?.reasonForSeeking && !contact?.reasonForTherapy && !contact?.formCompletedBy &&
                   !contact?.modality && !contact?.insurancePayer && !contact?.referralSource &&
                   !contact?.priorServices && !contact?.patientDob && !contact?.gender &&
                   !contact?.streetAddress && !contact?.city && !contact?.preferredContact &&
                   !contact?.rfsLink && !contact?.custody && (
                    <p className="text-muted-foreground text-xs italic">No intake data available</p>
                  )}
                </CardContent>
              </Card>

              {/* Intake Comments — CRM-only coordination notes */}
              <Card className="overflow-visible">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <MessageSquareWarning className="h-4 w-4" />
                    Intake Comments
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Flag issues for Excel correction
                  </p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Comment input */}
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Describe what needs correction in Excel..."
                      value={intakeComment}
                      onChange={(e) => setIntakeComment(e.target.value)}
                      className="min-h-[60px] resize-none text-sm"
                    />
                    <Button
                      size="sm"
                      variant="default"
                      className="bg-amber-600 hover:bg-amber-700 text-white"
                      disabled={!intakeComment.trim() || addIntakeCommentMutation.isPending}
                      onClick={handleAddIntakeComment}
                    >
                      <AlertTriangle className="h-3 w-3 mr-1.5" />
                      Flag & Comment
                    </Button>
                  </div>

                  {/* Comment list */}
                  {intakeComments.length > 0 && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      {intakeComments.map((comment) => (
                        <div key={comment.id} className="text-xs space-y-0.5 bg-muted/40 rounded-md p-2">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-foreground">{comment.authorInitials}</span>
                            <span className="text-muted-foreground">
                              {new Date(comment.createdAt + "Z").toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                          <p className="text-foreground">{comment.commentText}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {intakeComments.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">No comments yet</p>
                  )}
                </CardContent>
              </Card>

              {/* Assignment History — CRM-only provider assignments */}
              <Card className="overflow-visible">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <UserPlus className="h-4 w-4" />
                    Assignment History
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Current assignment badge */}
                  {latestAssignment && (
                    <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-md p-2.5">
                      <p className="text-xs font-medium text-amber-800 dark:text-amber-300">Assigned Provider</p>
                      <p className="text-sm font-semibold text-foreground">
                        {latestAssignment.providerName} — {latestAssignment.credential}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        Assigned {new Date(latestAssignment.assignedAt + "Z").toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })} by {latestAssignment.assignedByInitials}
                      </p>
                    </div>
                  )}

                  {/* Assignment list */}
                  {assignments.length > 0 && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      {assignments.map((assignment) => (
                        <div key={assignment.id} className="text-xs space-y-0.5 bg-muted/40 rounded-md p-2">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-foreground">{assignment.assignedByInitials}</span>
                            <span className="text-muted-foreground">
                              {new Date(assignment.assignedAt + "Z").toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                          <p className="text-foreground">
                            Assigned provider: {assignment.providerName} — {assignment.credential}
                          </p>
                          {assignment.assignmentComment && (
                            <p className="text-muted-foreground">Reason: {assignment.assignmentComment}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {assignments.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">No provider assigned yet</p>
                  )}
                </CardContent>
              </Card>

              {/* Quick Actions - Data-aware with tooltips */}
              <Card className="overflow-visible">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Quick Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block">
                          <Button
                            variant="outline"
                            className="w-full justify-start"
                            size="sm"
                            disabled={!hasEmail || isLoading}
                            onClick={() => setShowSendEmailModal(true)}
                            data-testid="button-send-email"
                          >
                            <Mail className="h-4 w-4 mr-2" />
                            Send Email
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {!hasEmail && !isLoading && (
                        <TooltipContent>
                          <p>No email address available</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>

                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block">
                          <Button
                            variant="outline"
                            className="w-full justify-start"
                            size="sm"
                            disabled={!hasPhone || isLoading}
                            onClick={() => prefillNote(`Scheduled a call with ${displayName}.`)}
                            data-testid="button-schedule-call"
                          >
                            <Phone className="h-4 w-4 mr-2" />
                            Schedule Call
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {!hasPhone && !isLoading && (
                        <TooltipContent>
                          <p>No phone number available</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>

                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    size="sm"
                    disabled={isLoading}
                    onClick={() => prefillNote(`Scheduled an appointment with ${displayName}.`)}
                    data-testid="button-schedule-appt"
                  >
                    <Calendar className="h-4 w-4 mr-2" />
                    Schedule Appointment
                  </Button>

                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    size="sm"
                    disabled={isLoading || !user?.email}
                    onClick={() => setShowReminderModal(true)}
                    data-testid="button-add-reminder"
                  >
                    <Bell className="h-4 w-4 mr-2" />
                    Add Reminder
                  </Button>

                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    size="sm"
                    disabled={isLoading}
                    onClick={() => setShowProviderMatching(true)}
                    data-testid="button-find-providers"
                  >
                    <Users className="h-4 w-4 mr-2" />
                    Find Provider Matches
                  </Button>

                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    size="sm"
                    disabled={isLoading}
                    onClick={() => setShowAssignProviderModal(true)}
                    data-testid="button-assign-provider"
                  >
                    <UserPlus className="h-4 w-4 mr-2" />
                    Assign Provider
                  </Button>

                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    size="sm"
                    disabled={syncFromExcelMutation.isPending}
                    onClick={() => {
                      if (contactId) syncFromExcelMutation.mutate(contactId);
                    }}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${syncFromExcelMutation.isPending ? "animate-spin" : ""}`} />
                    {syncFromExcelMutation.isPending ? "Syncing..." : "Sync From Excel"}
                  </Button>

                  {canUseTn && (
                    tnRecord?.tnStatus === "created" ? (
                      <>
                        <Button
                          variant="outline"
                          className="w-full justify-start border-green-300 text-green-700 hover:bg-green-50"
                          size="sm"
                          onClick={() => window.open(tnRecord.tnPatientUrl || "", "_blank")}
                        >
                          <ExternalLink className="h-4 w-4 mr-2" />
                          Open in TherapyNotes
                        </Button>
                        <Button
                          variant="ghost"
                          className="w-full justify-start text-muted-foreground text-xs h-7"
                          size="sm"
                          disabled={resetTnMutation.isPending}
                          onClick={() => {
                            if (window.confirm("Reset TherapyNotes link? This will allow re-creating the patient.")) {
                              resetTnMutation.mutate();
                            }
                          }}
                        >
                          <RotateCcw className="h-3 w-3 mr-2" />
                          {resetTnMutation.isPending ? "Resetting..." : "Reset TherapyNotes Link"}
                        </Button>
                      </>
                    ) : tnRecord?.tnStatus === "in_progress" ? (
                      <Button
                        variant="outline"
                        className="w-full justify-start"
                        size="sm"
                        disabled
                      >
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Creating in TherapyNotes...
                      </Button>
                    ) : tnRecord?.tnStatus === "failed" ? (
                      <Button
                        variant="outline"
                        className="w-full justify-start border-red-300 text-red-700 hover:bg-red-50"
                        size="sm"
                        onClick={() => setShowCreateTnModal(true)}
                      >
                        <AlertCircle className="h-4 w-4 mr-2" />
                        Retry TherapyNotes
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        className="w-full justify-start"
                        size="sm"
                        disabled={isLoading}
                        onClick={() => setShowCreateTnModal(true)}
                      >
                        <FileText className="h-4 w-4 mr-2" />
                        Add to TherapyNotes EHR
                      </Button>
                    )
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>

      {/* Provider Matching Modal */}
      <ProviderMatchingModal
        isOpen={showProviderMatching}
        onClose={() => setShowProviderMatching(false)}
        contact={contact || null}
      />

      {/* Reminder Modal */}
      <ReminderModal
        isOpen={showReminderModal}
        onClose={() => setShowReminderModal(false)}
        contact={contact ? { contactId: contact.contactId, name: contact.name } : null}
        userEmail={user?.email || ""}
        onSubmit={handleCreateReminder}
        isSubmitting={isCreatingReminder}
      />

      {/* TherapyNotes Modal */}
      {canUseTn && (
        <CreateTnModal
          isOpen={showCreateTnModal}
          onClose={() => setShowCreateTnModal(false)}
          contact={contact || null}
          onConfirm={() => createTnMutation.mutate()}
          isSubmitting={createTnMutation.isPending}
        />
      )}

      {/* Assign Provider Modal */}
      <AssignProviderModal
        isOpen={showAssignProviderModal}
        onClose={() => setShowAssignProviderModal(false)}
        contact={contact ? { contactId: contact.contactId, name: contact.name } : null}
        userEmail={user?.email || ""}
        authorInitials={authorInitials}
        onAssigned={() => {
          toast({ title: "Provider assigned", description: `Provider assigned to ${contact?.name}` });
          queryClient.invalidateQueries({ queryKey: ["/api/assignments", contactId] });
        }}
      />

      {/* Send Email Modal */}
      <SendEmailModal
        isOpen={showSendEmailModal}
        onClose={() => setShowSendEmailModal(false)}
        contact={contact || null}
        userEmail={user?.email || ""}
        onSend={(result) => {
          if (result.success) {
            toast({
              title: "Email sent",
              description: `Email sent successfully to ${contact?.name}`,
            });
            // Refetch contact data to update timeline
            queryClient.invalidateQueries({ queryKey: ["/api/contact", contactId] });
          } else {
            toast({
              title: "Failed to send email",
              description: result.error || "An error occurred",
              variant: "destructive",
            });
          }
        }}
      />
    </PageLayout>
  );
}
