import { useParams, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { AIInsightPanel } from "@/components/ui/ai-insight-panel";
import { getStatusLabel } from "@/components/ui/status-badge";
import { Timeline } from "@/components/ui/timeline";
import { TimelineErrorBoundary } from "@/components/ui/timeline-error-boundary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
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
  FileText,
  Users,
} from "lucide-react";
import { getContactSnapshot, updateContactStatus, addNoteToContact, type WithSource } from "@/lib/api";
import { useDataSource } from "@/lib/data-source-context";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";
import type { ContactSnapshot } from "@shared/schema";
import { buildTimelineEvents } from "@/lib/timeline";
import { ProviderMatchingModal } from "@/components/ui/provider-matching-modal";
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

      // Re-fetch to reconcile with server
      queryClient.invalidateQueries({ queryKey: ["/api/contact", variables.contactId] });
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
      return buildTimelineEvents({
        ...contact,
        _source: contactData?._source as "live" | "mock" | undefined,
      });
    } catch (e) {
      console.error("[contact-detail] Error building timeline events:", e);
      return [];
    }
  }, [contact, contactData?._source]);

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
  const dateAdded = contact?.dateAdded || "N/A";
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
            <Card className="overflow-visible">
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
              <Card className="overflow-visible">
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
              <Card className="overflow-visible">
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
              <Card className="overflow-visible">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Calendar className="h-4 w-4" />
                    <span className="text-xs">Last Contact</span>
                  </div>
                  {isLoading ? (
                    <Skeleton className="h-5 w-24" />
                  ) : (
                    <p className="text-sm font-medium text-foreground" data-testid="text-last-contact">
                      {contact?.lastContact || "N/A"}
                    </p>
                  )}
                </CardContent>
              </Card>
              <Card className="overflow-visible">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <User className="h-4 w-4" />
                    <span className="text-xs">Assigned To</span>
                  </div>
                  {isLoading ? (
                    <Skeleton className="h-5 w-28" />
                  ) : (
                    <p className="text-sm font-medium text-foreground" data-testid="text-assigned-to">
                      {contact?.assignedTo || "Unassigned"}
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Activity Timeline - Parsed from Excel "Notes added by agent" column */}
            <Card className="overflow-visible">
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
              <Card className="overflow-visible">
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
                  {(contact?.requestingFor || contact?.reasonForSeeking || contact?.formCompletedBy || contact?.modality) && (
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
                          <p className="font-medium text-foreground">{contact.patientDob}</p>
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
                  {!contact?.requestingFor && !contact?.reasonForSeeking && !contact?.formCompletedBy &&
                   !contact?.modality && !contact?.insurancePayer && !contact?.referralSource &&
                   !contact?.priorServices && !contact?.patientDob && !contact?.gender &&
                   !contact?.streetAddress && !contact?.city && !contact?.preferredContact &&
                   !contact?.rfsLink && !contact?.custody && (
                    <p className="text-muted-foreground text-xs italic">No intake data available</p>
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
                    data-testid="button-schedule-appt"
                  >
                    <Calendar className="h-4 w-4 mr-2" />
                    Schedule Appointment
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
    </PageLayout>
  );
}
