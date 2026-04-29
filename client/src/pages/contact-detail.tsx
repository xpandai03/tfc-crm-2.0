import { useParams, Link, useLocation } from "wouter";
import { computeDaysWaiting } from "@/lib/days-waiting";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo, useRef } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { AIInsightPanel } from "@/components/ui/ai-insight-panel";
import { getStatusLabel } from "@/components/ui/status-badge";
import { getStatusLabel as getStatusLabelByCode } from "@/lib/status-config";
import { Timeline } from "@/components/ui/timeline";
import { TimelineErrorBoundary } from "@/components/ui/timeline-error-boundary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChevronLeft,
  ChevronDown,
  ChevronRight,
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
  Download,
  Pencil,
  Save,
  X,
  Trash2,
  Hourglass,
} from "lucide-react";
import { getContactSnapshot, updateContactStatus, addNoteToContact, deleteNote, deleteAssignment as deleteAssignmentApi, createReminder, assignContact, getIntakeComments, createIntakeComment, getAttentionFlags, clearAttentionFlag, getTherapyNotesStatus, createTherapyNotesPatient, resetTherapyNotesLink, getAssignments, syncContactFromExcel, updateContactIntake, updateContactIdentity, deleteContact, type WithSource, type IntakeComment, type ProviderAssignment } from "@/lib/api";
import { ReminderModal } from "@/components/ui/reminder-modal";
import { AssignProviderModal } from "@/components/ui/assign-provider-modal";
import { SendEmailModal } from "@/components/ui/send-email-modal";
import { AssignmentSelector } from "@/components/ui/assignment-selector";
import { useDataSource, type DataSource } from "@/lib/data-source-context";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";
import type { ContactSnapshot, WaitlistContact } from "@shared/schema";
import { buildTimelineEvents, formatFullDate, matchSnapshotForEmailEvent, type EmailSnapshotMeta, type TimelineEvent } from "@/lib/timeline";
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

/** Expandable intake submission entry with full details + PDF download */
function IntakeHistoryEntry({ sub, label, isLatest, defaultExpanded }: {
  sub: { id: number; createdAt: string; payload: Record<string, unknown> };
  label: string;
  isLatest: boolean;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const p = sub.payload;

  const detailFields: { label: string; key: string }[] = [
    { label: "For", key: "requestingFor" },
    { label: "Reason for Seeking", key: "reasonForSeeking" },
    { label: "Reason for Therapy", key: "reasonForTherapy" },
    { label: "Detailed Reason", key: "detailedReason" },
    { label: "Modality", key: "modality" },
    { label: "Insurance", key: "insurancePayer" },
    { label: "Insurance Plan", key: "insurancePlan" },
    { label: "Insurance ID", key: "insuranceId" },
    { label: "Service Requested", key: "serviceRequested" },
    { label: "Completed By", key: "formCompletedBy" },
    { label: "DOB", key: "patientDob" },
    { label: "Gender", key: "gender" },
    { label: "Referral Source", key: "referralSource" },
    { label: "Prior Services", key: "priorServices" },
    { label: "Prior Provider", key: "priorProvider" },
    { label: "Preferred Contact", key: "preferredContact" },
  ];

  return (
    <div
      className={cn(
        "rounded-md border text-sm",
        isLatest
          ? "bg-blue-50/50 dark:bg-blue-950/20 border-blue-100 dark:border-blue-900/30"
          : "bg-muted/30 border-border/50"
      )}
    >
      {/* Collapsed header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-2.5 text-left hover:bg-muted/40 rounded-md transition-colors"
      >
        <div className="flex items-center gap-2">
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          <div>
            <span className="text-xs font-semibold text-foreground">{label}</span>
            {p.patientDob && (
              <span className="text-[10px] text-muted-foreground ml-2">
                DOB: {String(p.patientDob)}
              </span>
            )}
          </div>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {formatDate(sub.createdAt)}
        </span>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5">
          <div className="border-t border-border/40 pt-2 space-y-1">
            {detailFields.map((f) => {
              const val = p[f.key];
              if (!val) return null;
              const display = Array.isArray(val)
                ? (val as string[]).filter(Boolean).join(", ")
                : String(val);
              if (!display.trim()) return null;
              return (
                <div key={f.key} className="flex gap-2 text-xs">
                  <span className="text-muted-foreground shrink-0 w-28">{f.label}:</span>
                  <span className="font-medium text-foreground">{display}</span>
                </div>
              );
            })}
          </div>
          {/* Participants — supports both "participants" and legacy "participantNames" payload keys */}
          {(() => {
            const participantList = (
              Array.isArray(p.participants) ? p.participants
              : Array.isArray(p.participantNames) ? p.participantNames
              : []
            ) as Array<Record<string, unknown>>;
            if (participantList.length === 0) return null;
            return (
              <div className="border-t border-border/40 pt-2 space-y-2">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Participants</span>
                {participantList.map((participant, idx) => {
                  const phone = participant.phoneNumber ?? participant.phone;
                  return (
                    <div key={idx} className="rounded border border-border/40 bg-muted/20 p-2 space-y-0.5">
                      {participant.name && (
                        <div className="flex gap-2 text-xs">
                          <span className="text-muted-foreground shrink-0 w-28">Name:</span>
                          <span className="font-medium text-foreground">{String(participant.name)}</span>
                        </div>
                      )}
                      {participant.dob && (
                        <div className="flex gap-2 text-xs">
                          <span className="text-muted-foreground shrink-0 w-28">DOB:</span>
                          <span className="font-medium text-foreground">{String(participant.dob)}</span>
                        </div>
                      )}
                      {participant.email && (
                        <div className="flex gap-2 text-xs">
                          <span className="text-muted-foreground shrink-0 w-28">Email:</span>
                          <span className="font-medium text-foreground">{String(participant.email)}</span>
                        </div>
                      )}
                      {phone && (
                        <div className="flex gap-2 text-xs">
                          <span className="text-muted-foreground shrink-0 w-28">Phone:</span>
                          <span className="font-medium text-foreground">{String(phone)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs mt-2"
            onClick={() => window.open(`/api/intake/pdf/${sub.id}`, "_blank")}
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Download Intake PDF
          </Button>
        </div>
      )}
    </div>
  );
}

export default function ContactDetail() {
  const params = useParams();
  const [, navigate] = useLocation();
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

  // Time-in-status: pulls the same payload the insights page uses, finds this
  // contact's row. Returns null when no logged status_changed event places this
  // contact on its current status_code (e.g., n8n-driven contacts with no UI
  // mutation since logging shipped). React Query dedupes across pages.
  const { data: statusDurationsData } = useQuery<{
    byContact: Array<{
      contactId: number;
      statusCode: number | null;
      timeInCurrentStatusSeconds: number | null;
    }>;
  }>({
    queryKey: ["/api/insights/status-durations"],
    queryFn: async () => {
      const res = await fetch("/api/insights/status-durations", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch status durations");
      return res.json();
    },
    enabled: isValidId,
    staleTime: 60_000,
  });

  // Treat null OR zero seconds as "no measurable tenure" — see notes on the
  // insights page for the rationale (sub-86400-second floors and the zero-vs-
  // null ambiguity both render as the empty state).
  const statusDurationDays = useMemo(() => {
    if (!statusDurationsData || contactId === null) return null;
    const row = statusDurationsData.byContact.find((b) => b.contactId === contactId);
    if (!row || row.timeInCurrentStatusSeconds === null || row.timeInCurrentStatusSeconds <= 0) {
      return null;
    }
    return Math.floor(row.timeInCurrentStatusSeconds / 86400);
  }, [statusDurationsData, contactId]);

  useEffect(() => {
    if (contactData?._source) {
      updateSource(contactData._source as DataSource);
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

  // Contact identity edit mode (name, email, phone)
  const [isEditingIdentity, setIsEditingIdentity] = useState(false);
  const [identityEdits, setIdentityEdits] = useState<{ name: string; email: string; phone: string }>({ name: "", email: "", phone: "" });
  const [identityErrors, setIdentityErrors] = useState<{ name?: string; email?: string }>({});

  const startEditingIdentity = () => {
    if (!contact) return;
    setIdentityEdits({
      name: contact.name || "",
      email: contact.email || "",
      phone: contact.phone || "",
    });
    setIdentityErrors({});
    setIsEditingIdentity(true);
  };

  const cancelEditingIdentity = () => {
    setIsEditingIdentity(false);
    setIdentityEdits({ name: "", email: "", phone: "" });
    setIdentityErrors({});
  };

  const validateIdentityEdits = (): boolean => {
    const errors: { name?: string; email?: string } = {};
    if (!identityEdits.name.trim()) errors.name = "Name is required";
    if (identityEdits.email.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(identityEdits.email.trim())) errors.email = "Invalid email format";
    }
    setIdentityErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const updateIdentityMutation = useMutation({
    mutationFn: (updates: { name?: string; email?: string; phone?: string }) =>
      updateContactIdentity(contactId!, updates),
    onSuccess: (data) => {
      const count = data.changes?.length || 0;
      toast({
        title: "Contact updated",
        description: `${count} field(s) saved`,
      });
      setIsEditingIdentity(false);
      setIdentityEdits({ name: "", email: "", phone: "" });
      setIdentityErrors({});
      queryClient.invalidateQueries({ queryKey: ["/api/contact", contactId] });
      queryClient.invalidateQueries({ queryKey: ["/api/get-waitlist-board"] });
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity/contact", contactId] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to update contact",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleSaveIdentity = () => {
    if (!contact || !validateIdentityEdits()) return;
    const updates: { name?: string; email?: string; phone?: string } = {};
    if (identityEdits.name.trim() !== (contact.name || "")) updates.name = identityEdits.name.trim();
    if (identityEdits.email.trim() !== (contact.email || "")) updates.email = identityEdits.email.trim();
    if (identityEdits.phone.trim() !== (contact.phone || "")) updates.phone = identityEdits.phone.trim();
    if (Object.keys(updates).length === 0) {
      toast({ title: "No changes", description: "Nothing was modified" });
      setIsEditingIdentity(false);
      return;
    }
    updateIdentityMutation.mutate(updates);
  };

  // Delete contact state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const deleteContactMutation = useMutation({
    mutationFn: () => deleteContact(contactId!, "delete"),
    onSuccess: (data) => {
      toast({
        title: "Contact deleted",
        description: `${data.name} has been permanently removed`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/get-waitlist-board"] });
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
      navigate("/waitlist");
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to delete contact",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Intake edit mode state
  const [isEditingIntake, setIsEditingIntake] = useState(false);
  const [intakeEdits, setIntakeEdits] = useState<Record<string, string>>({});

  const startEditingIntake = () => {
    if (!contact) return;
    setIntakeEdits({
      requestingFor: contact.requestingFor || "",
      reasonForSeeking: contact.reasonForSeeking || "",
      reasonForTherapy: contact.reasonForTherapy || "",
      modality: contact.modality || "",
      formCompletedBy: contact.formCompletedBy || "",
      insurancePayer: contact.insurancePayer || "",
      insurancePlan: contact.insurancePlan || "",
      insuranceId: contact.insuranceId || "",
      patientDob: contact.patientDob || "",
      gender: contact.gender || "",
      streetAddress: contact.streetAddress || "",
      city: contact.city || "",
      state: contact.state || "",
      zipCode: contact.zipCode || "",
      referralSource: contact.referralSource || "",
      priorServices: contact.priorServices || "",
      priorProvider: contact.priorProvider || "",
      preferredContact: contact.preferredContact || "",
      rfsLink: contact.rfsLink || "",
    });
    setIsEditingIntake(true);
  };

  const cancelEditingIntake = () => {
    setIsEditingIntake(false);
    setIntakeEdits({});
  };

  const updateIntakeMutation = useMutation({
    mutationFn: (fields: Record<string, string | null>) =>
      updateContactIntake(contactId!, fields, authorInitials),
    onSuccess: (data) => {
      toast({
        title: "Intake updated",
        description: `${data.updated.length} field(s) saved`,
      });
      setIsEditingIntake(false);
      setIntakeEdits({});
      queryClient.invalidateQueries({ queryKey: ["/api/contact", contactId] });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to update intake",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleSaveIntake = () => {
    if (!contact) return;
    // Only send fields that actually changed
    const changed: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(intakeEdits)) {
      const original = (contact as any)[key] || "";
      if (value !== original) {
        changed[key] = value.trim() || null;
      }
    }
    if (Object.keys(changed).length === 0) {
      toast({ title: "No changes", description: "Nothing was modified" });
      setIsEditingIntake(false);
      return;
    }
    updateIntakeMutation.mutate(changed);
  };

  // TherapyNotes integration
  const TN_ALLOWED_EMAILS = ["raunek@tfc.health", "dawn@tfc.health", "amanda@tfc.health", "chantel@tfc.health", "jmontano@tfc.health", "lsego@tfc.health", "sandra@tfc.health"];
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

  // Detect legacy TherapyNotes URL from historical notes
  // Priority: 1) therapy_notes_records table, 2) legacy note URL, 3) none
  const legacyTnUrl = useMemo(() => {
    if (tnRecord?.tnStatus === "created") return null; // DB record takes precedence
    const notes = contact?.notes;
    if (!notes || !Array.isArray(notes)) return null;
    const tnUrlPattern = /https?:\/\/(?:www\.)?therapynotes\.com\/[^\s"<>]+/i;
    // Scan from most recent to oldest
    for (let i = notes.length - 1; i >= 0; i--) {
      const content = notes[i]?.content;
      if (!content) continue;
      const match = content.match(tnUrlPattern);
      if (match) return match[0];
    }
    return null;
  }, [contact?.notes, tnRecord?.tnStatus]);

  // Refresh activity when TN status reaches terminal state (created/failed)
  const tnStatus = tnRecord?.tnStatus;
  useEffect(() => {
    if (tnStatus === "created" || tnStatus === "failed") {
      queryClient.invalidateQueries({ queryKey: ["/api/activity/contact", contactId] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
    }
  }, [tnStatus, contactId, queryClient]);

  const createTnMutation = useMutation({
    mutationFn: () => createTherapyNotesPatient(Number(contactId), contact?.name),
    onSuccess: () => {
      toast({ title: "TherapyNotes creation started", description: "This may take 30-40 seconds..." });
      setShowCreateTnModal(false);
      refetchTn();
      // Immediately show "started" event in activity
      queryClient.invalidateQueries({ queryKey: ["/api/activity/contact", contactId] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
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
      await queryClient.cancelQueries({ queryKey: ["/api/contact", variables.contactId] });
      const previousData = queryClient.getQueryData<WithSource<ContactSnapshot>>(["/api/contact", variables.contactId]);

      // Optimistically update cache with new note
      if (previousData) {
        queryClient.setQueryData<WithSource<ContactSnapshot>>(
          ["/api/contact", variables.contactId],
          {
            ...previousData,
            notes: [{ date: variables.timestamp, content: variables.note, author: variables.author }, ...(previousData.notes || [])],
          }
        );
      }
      setNewNote("");
      return { previousData };
    },
    onSuccess: (_data, variables) => {
      toast({ title: "Note added" });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/contact", variables.contactId], refetchType: "active" });
        queryClient.invalidateQueries({ queryKey: ["/api/waitlist-contacts"], refetchType: "active" });
      }, 300);
    },
    onError: (error, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(["/api/contact", variables.contactId], context.previousData);
      }
      toast({ title: "Failed to add note", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
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

  // Contact-scoped activity events (emails sent, TN creation, etc.)
  const { data: contactActivityData } = useQuery<{ activities: Array<{ id: number; type: string; actorEmail: string; summary: string; metadata: Record<string, unknown>; createdAt: string }> }>({
    queryKey: ["/api/activity/contact", contactId],
    queryFn: async () => {
      const res = await fetch(`/api/activity/contact/${contactId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch contact activity");
      return res.json();
    },
    enabled: isValidId,
    staleTime: 30_000,
  });
  const contactActivities = contactActivityData?.activities || [];

  // Intake submission history (multiple intakes per contact)
  const { data: intakeHistoryData } = useQuery<{ submissions: Array<{ id: number; createdAt: string; payload: Record<string, unknown> }> }>({
    queryKey: ["/api/intake-history", contactId],
    queryFn: async () => {
      const res = await fetch(`/api/intake-history/${contactId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch intake history");
      return res.json();
    },
    enabled: isValidId,
    staleTime: 60_000,
  });
  const intakeSubmissions = intakeHistoryData?.submissions || [];

  // Household members — other contacts sharing email/phone
  const { data: householdData } = useQuery<{ members: Array<{
    contactId: number;
    name: string;
    requestingFor: string | null;
    patientDob: string | null;
    assignedTo: string | null;
    statusCode: string | null;
  }> }>({
    queryKey: ["/api/household", contactId],
    queryFn: async () => {
      const res = await fetch(`/api/household/${contactId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch household");
      return res.json();
    },
    enabled: isValidId,
    staleTime: 60_000,
  });
  const householdMembers = householdData?.members || [];

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
      toast({ title: "Contact synced", description: "Fresh data loaded." });
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
      // Shared claim set so activity-log and notes-path matchers don't double-assign a snapshot
      const claimedSnapshotIds = new Set<number>();

      const baseEvents = buildTimelineEvents(
        {
          ...contact,
          _source: contactData?._source as "live" | "mock" | undefined,
        },
        snapshotsData?.snapshots,
        assignments,
        claimedSnapshotIds,
      );

      // Merge activity_log events (emails, TN, etc.) into timeline.
      // Preserve `email_sent` type so the violet Mail icon + Download Snapshot button render.
      const activityEvents: TimelineEvent[] = contactActivities
        .filter(a => ["email_sent", "therapy_notes_started", "therapy_notes_created", "therapy_notes_failed", "contact_updated"].includes(a.type))
        .map((a): TimelineEvent => {
          const isEmail = a.type === "email_sent";
          const templateId = isEmail ? (a.metadata?.template as string | undefined) ?? null : null;
          const snapshotId = isEmail
            ? matchSnapshotForEmailEvent(
                templateId,
                new Date(a.createdAt).getTime(),
                snapshotsData?.snapshots,
                claimedSnapshotIds,
              )
            : undefined;

          return {
            id: `activity-${a.id}`,
            type: isEmail ? "email_sent" : "system",
            timestamp: a.createdAt,
            content: a.summary,
            author: a.actorEmail === "system" ? "System" : a.actorEmail.split("@")[0].substring(0, 3).toUpperCase(),
            source: "live",
            emailTemplate: isEmail ? (a.metadata?.templateName as string | undefined) : undefined,
            snapshotId,
          };
        });

      // Combine and sort by timestamp descending
      const all = [...baseEvents, ...activityEvents];
      all.sort((a, b) => {
        const ta = new Date(a.timestamp || "").getTime() || 0;
        const tb = new Date(b.timestamp || "").getTime() || 0;
        return tb - ta;
      });

      return all;
    } catch (e) {
      console.error("[contact-detail] Error building timeline events:", e);
      return [];
    }
  }, [contact, contactData?._source, snapshotsData?.snapshots, assignments, contactActivities]);

  // Handle deleting timeline events (notes or assignments)
  const handleDeleteTimelineEvent = async (event: TimelineEvent) => {
    if (!contact) return;
    try {
      if (event.type === "note" && event.content) {
        await deleteNote(contact.contactId, event.content);
        toast({ title: "Note deleted" });
      } else if (event.type === "assignment" && event.assignmentId) {
        await deleteAssignmentApi(event.assignmentId);
        toast({ title: "Assignment removed" });
      } else {
        return;
      }
      // Refresh data
      queryClient.invalidateQueries({ queryKey: ["/api/contact", String(contact.contactId)] });
      queryClient.invalidateQueries({ queryKey: ["/api/assignments", contact.contactId] });
      queryClient.invalidateQueries({ queryKey: ["/api/waitlist-contacts"] });
    } catch (err) {
      toast({ title: "Failed to delete", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  };

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
  const daysWaiting = computeDaysWaiting(contact?.dateAdded, contact?.daysOnWaitlist);
  const dateAdded = formatDate(contact?.dateAdded);
  // Show requesting-for + therapy type (matches waitlist card display)
  // Falls back to serviceRequested only if both are empty
  const serviceSubtitle = [
    contact?.requestingFor,
    contact?.reasonForTherapy,
  ].filter(Boolean).join(" · ") || contact?.serviceRequested || "Unknown Service";
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
            <Card className="overflow-visible bg-white dark:bg-gray-800/90">
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
                      <div className="flex-1 min-w-0">
                        {isLoading ? (
                          <>
                            <Skeleton className="h-8 w-48 mb-2" />
                            <Skeleton className="h-5 w-32" />
                          </>
                        ) : isEditingIdentity ? (
                          <div className="space-y-2">
                            <div>
                              <Input
                                value={identityEdits.name}
                                onChange={(e) => setIdentityEdits(p => ({ ...p, name: e.target.value }))}
                                placeholder="Full name"
                                className={cn("text-lg font-semibold h-9", identityErrors.name && "border-destructive")}
                                autoFocus
                                onKeyDown={(e) => { if (e.key === "Enter") handleSaveIdentity(); if (e.key === "Escape") cancelEditingIdentity(); }}
                              />
                              {identityErrors.name && <p className="text-xs text-destructive mt-0.5">{identityErrors.name}</p>}
                            </div>
                            <p className="text-muted-foreground text-sm">{serviceSubtitle}</p>
                          </div>
                        ) : (
                          <div className="group/identity">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h1 className="text-2xl font-semibold text-foreground" data-testid="text-contact-name">
                                {displayName}
                              </h1>
                              {contact?.intakeSource === "uploaded_referral" && (
                                <Badge
                                  variant="outline"
                                  className="text-blue-600 border-blue-300 dark:text-blue-400 dark:border-blue-700"
                                  data-testid="badge-uploaded-referral"
                                >
                                  Uploaded Referral
                                </Badge>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 opacity-0 group-hover/identity:opacity-100 transition-opacity"
                                onClick={startEditingIdentity}
                                title="Edit contact details"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                            <p className="text-muted-foreground">
                              {serviceSubtitle}
                            </p>
                          </div>
                        )}
                      </div>
                      {isLoading ? (
                        <Skeleton className="h-10 w-[200px]" />
                      ) : (
                        <div className="flex items-end gap-2">
                          {isEditingIdentity && (
                            <div className="flex items-center gap-1.5">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 text-xs"
                                onClick={cancelEditingIdentity}
                                disabled={updateIdentityMutation.isPending}
                              >
                                <X className="h-3.5 w-3.5 mr-1" />
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                className="h-8 text-xs"
                                onClick={handleSaveIdentity}
                                disabled={updateIdentityMutation.isPending}
                              >
                                {updateIdentityMutation.isPending ? (
                                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                ) : (
                                  <Save className="h-3.5 w-3.5 mr-1" />
                                )}
                                Save
                              </Button>
                            </div>
                          )}
                          {!isEditingIdentity && (
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
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-4 mt-4 text-sm">
                      {isLoading ? (
                        <>
                          <Skeleton className="h-5 w-32" />
                          <Skeleton className="h-5 w-28" />
                        </>
                      ) : isEditingIdentity ? (
                        <div className="flex flex-wrap gap-3">
                          <div className="flex-1 min-w-[180px]">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">Email</span>
                            </div>
                            <Input
                              type="email"
                              value={identityEdits.email}
                              onChange={(e) => setIdentityEdits(p => ({ ...p, email: e.target.value }))}
                              placeholder="email@example.com"
                              className={cn("h-8 text-sm", identityErrors.email && "border-destructive")}
                              onKeyDown={(e) => { if (e.key === "Enter") handleSaveIdentity(); if (e.key === "Escape") cancelEditingIdentity(); }}
                            />
                            {identityErrors.email && <p className="text-xs text-destructive mt-0.5">{identityErrors.email}</p>}
                          </div>
                          <div className="flex-1 min-w-[160px]">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">Phone</span>
                            </div>
                            <Input
                              type="tel"
                              value={identityEdits.phone}
                              onChange={(e) => setIdentityEdits(p => ({ ...p, phone: e.target.value }))}
                              placeholder="505-000-0000"
                              className="h-8 text-sm"
                              onKeyDown={(e) => { if (e.key === "Enter") handleSaveIdentity(); if (e.key === "Escape") cancelEditingIdentity(); }}
                            />
                          </div>
                        </div>
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
              <Card className="overflow-visible bg-white dark:bg-gray-800/90">
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
              <Card className="overflow-visible bg-white dark:bg-gray-800/90">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Hourglass className="h-4 w-4" />
                    <span className="text-xs">Status Duration</span>
                  </div>
                  {isLoading ? (
                    <Skeleton className="h-5 w-24" />
                  ) : statusDurationDays !== null && contact?.statusCode !== undefined ? (
                    <p
                      className="text-sm font-medium text-foreground"
                      data-testid="text-status-duration"
                    >
                      {getStatusLabelByCode(contact.statusCode)} for {statusDurationDays}{" "}
                      {statusDurationDays === 1 ? "day" : "days"}
                    </p>
                  ) : (
                    <div data-testid="text-status-duration-empty">
                      <p className="text-2xl font-bold text-foreground">—</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Tracking begins on next status change
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card className="overflow-visible bg-white dark:bg-gray-800/90">
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
              <Card className="overflow-visible bg-white dark:bg-gray-800/90">
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
              <Card className="overflow-visible bg-white dark:bg-gray-800/90">
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
              <Card className="overflow-visible bg-white dark:bg-gray-800/90">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <UserPlus className="h-4 w-4" />
                    <span className="text-xs">Assigned Provider</span>
                  </div>
                  {isLoading ? (
                    <Skeleton className="h-5 w-24" />
                  ) : latestAssignment ? (
                    <p className="text-sm font-medium text-foreground">
                      {latestAssignment.providerName}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">—</p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Activity Timeline */}
            <Card className="overflow-visible bg-white dark:bg-gray-800/90">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <Activity className="h-4 w-4" />
                  Activity Timeline
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Chronological history of notes
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
                  <Timeline events={timelineEvents} onDeleteEvent={handleDeleteTimelineEvent} />
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

              {/* Intake Summary - Editable intake state with color-coded sections */}
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
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-sm font-medium flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        Intake Summary
                      </CardTitle>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {isEditingIntake ? "Editing · Changes saved to CRM" : "Intake form data"}
                      </p>
                    </div>
                    {!isEditingIntake ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={startEditingIntake}
                      >
                        <Pencil className="h-3 w-3 mr-1" />
                        Edit
                      </Button>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={cancelEditingIntake}
                          disabled={updateIntakeMutation.isPending}
                        >
                          <X className="h-3 w-3 mr-1" />
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={handleSaveIntake}
                          disabled={updateIntakeMutation.isPending}
                        >
                          {updateIntakeMutation.isPending ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <Save className="h-3 w-3 mr-1" />
                          )}
                          Save
                        </Button>
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {/* Intake Details Section — Blue */}
                  {(isEditingIntake || contact?.requestingFor || contact?.reasonForSeeking || contact?.reasonForTherapy || contact?.formCompletedBy || contact?.modality) && (
                    <div className="space-y-2 rounded-md p-2.5 bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30">
                      <h4 className="text-xs font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wide">Intake Details</h4>
                      {isEditingIntake ? (
                        <div className="space-y-2">
                          <div>
                            <label className="text-muted-foreground text-xs">Requesting For</label>
                            <Input className="h-8 text-sm" value={intakeEdits.requestingFor} onChange={(e) => setIntakeEdits(p => ({ ...p, requestingFor: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-muted-foreground text-xs">Reason</label>
                            <Input className="h-8 text-sm" value={intakeEdits.reasonForSeeking} onChange={(e) => setIntakeEdits(p => ({ ...p, reasonForSeeking: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-muted-foreground text-xs">Reason(s) for Therapy</label>
                            <Input className="h-8 text-sm" value={intakeEdits.reasonForTherapy} onChange={(e) => setIntakeEdits(p => ({ ...p, reasonForTherapy: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-muted-foreground text-xs">Modality</label>
                            <Input className="h-8 text-sm" value={intakeEdits.modality} onChange={(e) => setIntakeEdits(p => ({ ...p, modality: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-muted-foreground text-xs">Form Completed By</label>
                            <Input className="h-8 text-sm" value={intakeEdits.formCompletedBy} onChange={(e) => setIntakeEdits(p => ({ ...p, formCompletedBy: e.target.value }))} />
                          </div>
                        </div>
                      ) : (
                        <>
                          {contact?.requestingFor && (
                            <div><span className="text-muted-foreground text-xs">Requesting For:</span><p className="font-medium text-foreground">{contact.requestingFor}</p></div>
                          )}
                          {contact?.reasonForSeeking && (
                            <div><span className="text-muted-foreground text-xs">Reason:</span><p className="font-medium text-foreground">{contact.reasonForSeeking}</p></div>
                          )}
                          {contact?.reasonForTherapy && (
                            <div><span className="text-muted-foreground text-xs">Reason(s) for Therapy:</span><p className="font-medium text-foreground">{contact.reasonForTherapy}</p></div>
                          )}
                          {contact?.modality && (
                            <div><span className="text-muted-foreground text-xs">Modality:</span><p className="font-medium text-foreground">{contact.modality}</p></div>
                          )}
                          {contact?.formCompletedBy && (
                            <div><span className="text-muted-foreground text-xs">Form Completed By:</span><p className="font-medium text-foreground">{contact.formCompletedBy}</p></div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Insurance Section — Green */}
                  {(isEditingIntake || contact?.insurancePayer || contact?.insurancePlan || contact?.insuranceId || contact?.insuranceStatus) && (
                    <div className="space-y-2 rounded-md p-2.5 bg-green-50/50 dark:bg-green-950/20 border border-green-100 dark:border-green-900/30">
                      <h4 className="text-xs font-semibold text-green-700 dark:text-green-400 uppercase tracking-wide">Insurance</h4>
                      {isEditingIntake ? (
                        <div className="space-y-2">
                          <div>
                            <label className="text-muted-foreground text-xs">Payer</label>
                            <Input className="h-8 text-sm" value={intakeEdits.insurancePayer} onChange={(e) => setIntakeEdits(p => ({ ...p, insurancePayer: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-muted-foreground text-xs">Plan</label>
                            <Input className="h-8 text-sm" value={intakeEdits.insurancePlan} onChange={(e) => setIntakeEdits(p => ({ ...p, insurancePlan: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-muted-foreground text-xs">Member ID</label>
                            <Input className="h-8 text-sm" value={intakeEdits.insuranceId} onChange={(e) => setIntakeEdits(p => ({ ...p, insuranceId: e.target.value }))} />
                          </div>
                        </div>
                      ) : (
                        <>
                          {contact?.insurancePayer && (
                            <div><span className="text-muted-foreground text-xs">Payer:</span><p className="font-medium text-foreground">{contact.insurancePayer}</p></div>
                          )}
                          {contact?.insurancePlan && (
                            <div><span className="text-muted-foreground text-xs">Plan:</span><p className="font-medium text-foreground">{contact.insurancePlan}</p></div>
                          )}
                          {contact?.insuranceId && (
                            <div><span className="text-muted-foreground text-xs">Member ID:</span><p className="font-medium text-foreground">{contact.insuranceId}</p></div>
                          )}
                          {contact?.insuranceStatus && (
                            <div><span className="text-muted-foreground text-xs">Status:</span><p className="font-medium text-foreground">{contact.insuranceStatus}</p></div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Referral & History Section */}
                  {(isEditingIntake || contact?.referralSource || contact?.referralAuth || contact?.referralStatus || contact?.priorServices || contact?.priorProvider) && (
                    <div className="space-y-2 rounded-md p-2.5 bg-orange-50/50 dark:bg-orange-950/20 border border-orange-100 dark:border-orange-900/30">
                      <h4 className="text-xs font-semibold text-orange-700 dark:text-orange-400 uppercase tracking-wide">Referral & History</h4>
                      {isEditingIntake ? (
                        <div className="space-y-2">
                          <div>
                            <label className="text-muted-foreground text-xs">Referral Source</label>
                            <Input className="h-8 text-sm" value={intakeEdits.referralSource} onChange={(e) => setIntakeEdits(p => ({ ...p, referralSource: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-muted-foreground text-xs">Prior Services</label>
                            <Input className="h-8 text-sm" value={intakeEdits.priorServices} onChange={(e) => setIntakeEdits(p => ({ ...p, priorServices: e.target.value }))} />
                          </div>
                          <div>
                            <label className="text-muted-foreground text-xs">Prior Provider</label>
                            <Input className="h-8 text-sm" value={intakeEdits.priorProvider} onChange={(e) => setIntakeEdits(p => ({ ...p, priorProvider: e.target.value }))} />
                          </div>
                        </div>
                      ) : (
                        <>
                          {contact?.referralSource && (
                            <div><span className="text-muted-foreground text-xs">Referral Source:</span><p className="font-medium text-foreground">{contact.referralSource}</p></div>
                          )}
                          {contact?.referralAuth && (
                            <div><span className="text-muted-foreground text-xs">Authorization:</span><p className="font-medium text-foreground">{contact.referralAuth}</p></div>
                          )}
                          {contact?.referralStatus && (
                            <div><span className="text-muted-foreground text-xs">Referral Status:</span><p className="font-medium text-foreground">{contact.referralStatus}</p></div>
                          )}
                          {contact?.priorServices && (
                            <div><span className="text-muted-foreground text-xs">Prior Services:</span><p className="font-medium text-foreground">{contact.priorServices}</p></div>
                          )}
                          {contact?.priorProvider && (
                            <div><span className="text-muted-foreground text-xs">Prior Provider:</span><p className="font-medium text-foreground">{contact.priorProvider}</p></div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Demographics Section — Purple */}
                  {(isEditingIntake || contact?.patientDob || contact?.gender) && (
                    <div className="space-y-2 rounded-md p-2.5 bg-purple-50/50 dark:bg-purple-950/20 border border-purple-100 dark:border-purple-900/30">
                      <h4 className="text-xs font-semibold text-purple-700 dark:text-purple-400 uppercase tracking-wide">Demographics</h4>
                      {isEditingIntake ? (
                        <div className="space-y-2">
                          <div>
                            <label className="text-muted-foreground text-xs">Date of Birth</label>
                            <Input className="h-8 text-sm" value={intakeEdits.patientDob} onChange={(e) => setIntakeEdits(p => ({ ...p, patientDob: e.target.value }))} placeholder="YYYY-MM-DD" />
                          </div>
                          <div>
                            <label className="text-muted-foreground text-xs">Gender</label>
                            <Input className="h-8 text-sm" value={intakeEdits.gender} onChange={(e) => setIntakeEdits(p => ({ ...p, gender: e.target.value }))} />
                          </div>
                        </div>
                      ) : (
                        <>
                          {contact?.patientDob && (
                            <div><span className="text-muted-foreground text-xs">Date of Birth:</span><p className="font-medium text-foreground">{formatDob(contact.patientDob)}</p></div>
                          )}
                          {contact?.gender && (
                            <div><span className="text-muted-foreground text-xs">Gender:</span><p className="font-medium text-foreground">{contact.gender}</p></div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Address Section — Gray */}
                  {(isEditingIntake || contact?.streetAddress || contact?.city || contact?.state || contact?.zipCode) && (
                    <div className="space-y-2 rounded-md p-2.5 bg-slate-50/50 dark:bg-slate-950/20 border border-slate-200 dark:border-slate-800/30">
                      <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Address</h4>
                      {isEditingIntake ? (
                        <div className="space-y-2">
                          <div>
                            <label className="text-muted-foreground text-xs">Street</label>
                            <Input className="h-8 text-sm" value={intakeEdits.streetAddress} onChange={(e) => setIntakeEdits(p => ({ ...p, streetAddress: e.target.value }))} />
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <label className="text-muted-foreground text-xs">City</label>
                              <Input className="h-8 text-sm" value={intakeEdits.city} onChange={(e) => setIntakeEdits(p => ({ ...p, city: e.target.value }))} />
                            </div>
                            <div>
                              <label className="text-muted-foreground text-xs">State</label>
                              <Input className="h-8 text-sm" value={intakeEdits.state} onChange={(e) => setIntakeEdits(p => ({ ...p, state: e.target.value }))} />
                            </div>
                            <div>
                              <label className="text-muted-foreground text-xs">Zip</label>
                              <Input className="h-8 text-sm" value={intakeEdits.zipCode} onChange={(e) => setIntakeEdits(p => ({ ...p, zipCode: e.target.value }))} />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div>
                          {contact?.streetAddress && (
                            <p className="font-medium text-foreground">{contact.streetAddress}</p>
                          )}
                          {(contact?.city || contact?.state || contact?.zipCode) && (
                            <p className="font-medium text-foreground">
                              {[contact.city, contact.state, contact.zipCode].filter(Boolean).join(", ")}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Preferences */}
                  {(isEditingIntake || contact?.preferredContact) && (
                    <div className="space-y-2 rounded-md p-2.5 bg-sky-50/50 dark:bg-sky-950/20 border border-sky-100 dark:border-sky-900/30">
                      <h4 className="text-xs font-semibold text-sky-700 dark:text-sky-400 uppercase tracking-wide">Preferences</h4>
                      {isEditingIntake ? (
                        <div>
                          <label className="text-muted-foreground text-xs">Preferred Contact</label>
                          <Input className="h-8 text-sm" value={intakeEdits.preferredContact} onChange={(e) => setIntakeEdits(p => ({ ...p, preferredContact: e.target.value }))} />
                        </div>
                      ) : (
                        <div><span className="text-muted-foreground text-xs">Preferred Contact:</span><p className="font-medium text-foreground">{contact?.preferredContact}</p></div>
                      )}
                    </div>
                  )}

                  {/* Admin / Flags Section (read-only — not editable) */}
                  {(contact?.custody || contact?.flags || contact?.priority) && (
                    <div className="space-y-2 rounded-md p-2.5 bg-muted/30 border border-border">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Admin</h4>
                      {contact.custody && (
                        <div><span className="text-muted-foreground text-xs">Custody:</span><p className="font-medium text-foreground">{contact.custody}</p></div>
                      )}
                      {contact.flags && (
                        <div><span className="text-muted-foreground text-xs">Flags:</span><p className="font-medium text-foreground text-amber-600">{contact.flags}</p></div>
                      )}
                      {contact.priority && (
                        <div><span className="text-muted-foreground text-xs">Priority:</span><p className="font-medium text-foreground">{contact.priority}</p></div>
                      )}
                    </div>
                  )}

                  {/* Links Section */}
                  {(contact?.rfsLink || contact?.documentLink) && !isEditingIntake && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Documents</h4>
                      {contact.rfsLink && (
                        <a href={contact.rfsLink} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline flex items-center gap-1">
                          <FileText className="h-3 w-3" /> Open RFS Form
                        </a>
                      )}
                      {contact.documentLink && (
                        <a href={contact.documentLink} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline flex items-center gap-1">
                          <FileText className="h-3 w-3" /> View Documents
                        </a>
                      )}
                    </div>
                  )}
                  {isEditingIntake && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <div>
                        <label className="text-muted-foreground text-xs">RFS Link</label>
                        <Input className="h-8 text-sm" value={intakeEdits.rfsLink} onChange={(e) => setIntakeEdits(p => ({ ...p, rfsLink: e.target.value }))} />
                      </div>
                    </div>
                  )}

                  {/* Download Intake PDF */}
                  {!isEditingIntake && (contact?.requestingFor || contact?.reasonForSeeking || contact?.reasonForTherapy || contact?.formCompletedBy ||
                    contact?.modality || contact?.insurancePayer || contact?.referralSource ||
                    contact?.priorServices || contact?.patientDob || contact?.gender ||
                    contact?.streetAddress || contact?.city) && (
                    <div className="pt-3 border-t border-border">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full text-xs"
                        onClick={() => window.open(`/api/contact/${contactId}/intake-pdf`, "_blank")}
                      >
                        <Download className="h-3.5 w-3.5 mr-1.5" />
                        Download Intake PDF
                      </Button>
                    </div>
                  )}

                  {/* Empty state if no intake fields */}
                  {!isEditingIntake && !contact?.requestingFor && !contact?.reasonForSeeking && !contact?.reasonForTherapy && !contact?.formCompletedBy &&
                   !contact?.modality && !contact?.insurancePayer && !contact?.referralSource &&
                   !contact?.priorServices && !contact?.patientDob && !contact?.gender &&
                   !contact?.streetAddress && !contact?.city && !contact?.preferredContact &&
                   !contact?.rfsLink && !contact?.custody && (
                    <p className="text-muted-foreground text-xs italic">No intake data available</p>
                  )}
                </CardContent>
              </Card>

              {/* Intake History — expandable per-submission view */}
              {intakeSubmissions.length > 0 && (
                <Card className="overflow-visible">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Intake History ({intakeSubmissions.length})
                    </CardTitle>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {intakeSubmissions.length === 1
                        ? "Intake submission for this contact"
                        : `${intakeSubmissions.length} persons requesting services`}
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {intakeSubmissions.map((sub, idx) => {
                      const p = sub.payload as Record<string, unknown>;
                      const requestingFor = p.requestingFor ? String(p.requestingFor) : null;
                      const label = requestingFor
                        ? `Person — ${requestingFor}`
                        : `Intake #${sub.id}`;
                      return (
                        <IntakeHistoryEntry
                          key={sub.id}
                          sub={sub}
                          label={label}
                          isLatest={idx === 0}
                          defaultExpanded={intakeSubmissions.length === 1}
                        />
                      );
                    })}
                  </CardContent>
                </Card>
              )}

              {/* Household Members — other contacts sharing email/phone */}
              {householdMembers.length > 0 && (
                <Card className="overflow-visible">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      Household Members ({householdMembers.length})
                    </CardTitle>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Other contacts sharing this email or phone
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-1.5">
                    {householdMembers.map((m) => (
                      <Link key={m.contactId} href={`/contact/${m.contactId}`}>
                        <div className="rounded-md border border-border/50 p-2.5 hover:bg-muted/40 transition-colors cursor-pointer">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-foreground">{m.name}</span>
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                            {m.requestingFor && <span>{m.requestingFor}</span>}
                            {m.patientDob && <span>DOB: {m.patientDob}</span>}
                            {m.assignedTo && <span>Assigned: {m.assignedTo}</span>}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Intake Comments — CRM-only coordination notes */}
              <Card className="overflow-visible">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <MessageSquareWarning className="h-4 w-4" />
                    Intake Comments
                  </CardTitle>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Flag issues for review
                  </p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Comment input */}
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Describe what needs correction..."
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
                    ) : legacyTnUrl ? (
                      <Button
                        variant="outline"
                        className="w-full justify-start border-green-300 text-green-700 hover:bg-green-50"
                        size="sm"
                        onClick={() => window.open(legacyTnUrl, "_blank")}
                      >
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Open in TherapyNotes
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

                  <Separator className="my-2" />

                  <Button
                    variant="outline"
                    className="w-full justify-start border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
                    size="sm"
                    disabled={isLoading}
                    onClick={() => { setDeleteConfirmText(""); setShowDeleteModal(true); }}
                    data-testid="button-delete-contact"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Contact
                  </Button>
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
            // Refetch contact data + activity to update timeline
            queryClient.invalidateQueries({ queryKey: ["/api/contact", contactId] });
            queryClient.invalidateQueries({ queryKey: ["/api/activity/contact", contactId] });
            queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
            queryClient.invalidateQueries({ queryKey: ["/api/email-snapshots", contactId] });
          } else {
            toast({
              title: "Failed to send email",
              description: result.error || "An error occurred",
              variant: "destructive",
            });
          }
        }}
      />

      {/* Delete Contact Confirmation Dialog */}
      <Dialog open={showDeleteModal} onOpenChange={setShowDeleteModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red-600">Delete Contact</DialogTitle>
            <DialogDescription>
              This will permanently delete <span className="font-semibold text-foreground">{displayName}</span> and
              all related records (submissions, assignments, reminders, comments).
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <label className="text-sm text-muted-foreground">
              Type <span className="font-mono font-semibold text-foreground">delete</span> to confirm
            </label>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="delete"
              className="font-mono"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && deleteConfirmText === "delete") {
                  deleteContactMutation.mutate();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteModal(false)}
              disabled={deleteContactMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteConfirmText !== "delete" || deleteContactMutation.isPending}
              onClick={() => deleteContactMutation.mutate()}
            >
              {deleteContactMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              Delete Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
}
