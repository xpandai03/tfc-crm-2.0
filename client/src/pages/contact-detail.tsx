import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { AIInsightPanel } from "@/components/ui/ai-insight-panel";
import { getStatusLabel } from "@/components/ui/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LoadingState } from "@/components/ui/loading-spinner";
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
  ChevronLeft,
  Mail,
  Phone,
  Calendar,
  User,
  Clock,
  FileText,
  AlertCircle,
} from "lucide-react";
import { getContactSnapshot, type WithSource } from "@/lib/api";
import { useDataSource } from "@/lib/data-source-context";
import { contactStatuses, type ContactStatus, type ContactSnapshot } from "@shared/schema";

export default function ContactDetail() {
  const params = useParams();
  const contactName = decodeURIComponent(params.name || "");
  const { updateSource, updateSyncTime, isFallback } = useDataSource();
  
  const { 
    data: contactData, 
    isLoading, 
    error 
  } = useQuery<WithSource<ContactSnapshot>>({
    queryKey: ["/api/contact", contactName],
    queryFn: () => getContactSnapshot(contactName),
    enabled: !!contactName,
  });

  const contact = contactData;

  useEffect(() => {
    if (contactData?._source) {
      updateSource(contactData._source as "mock" | "live" | "fallback");
      updateSyncTime();
    }
  }, [contactData, updateSource, updateSyncTime]);

  const [status, setStatus] = useState<ContactStatus | undefined>(undefined);
  const [newNote, setNewNote] = useState("");

  // Update local status when contact data loads
  const currentStatus = status ?? contact?.status ?? "intake";

  if (isLoading) {
    return (
      <PageLayout>
        <LoadingState message="Loading contact..." />
      </PageLayout>
    );
  }

  if (error || !contact) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16">
          <AlertCircle className="h-8 w-8 text-destructive mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">
            Contact Not Found
          </h2>
          <p className="text-muted-foreground mb-4">
            Could not find a contact named "{contactName}"
          </p>
          <Link href="/">
            <Button variant="outline">
              <ChevronLeft className="h-4 w-4 mr-1" />
              Back to Today
            </Button>
          </Link>
        </div>
      </PageLayout>
    );
  }

  const initials = contact.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  const aiInsight = contact.daysOnWaitlist > 60
    ? `${contact.name} has been waiting ${contact.daysOnWaitlist} days, which is above the 60-day threshold. This may indicate a provider availability issue or specific service requirements.`
    : contact.status === "ready_to_schedule"
    ? `${contact.name} is ready to schedule. A provider has been matched and appointment options should be sent soon.`
    : `${contact.name} is progressing normally through the intake process.`;

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
          <span className="text-foreground font-medium" data-testid="text-breadcrumb-current">{contact.name}</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Contact Header */}
            <Card className="overflow-visible">
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  <Avatar className="h-16 w-16">
                    <AvatarFallback className="text-lg bg-primary/10 text-primary">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div>
                        <h1 className="text-2xl font-semibold text-foreground" data-testid="text-contact-name">
                          {contact.name}
                        </h1>
                        <p className="text-muted-foreground">
                          {contact.serviceRequested}
                        </p>
                      </div>
                      <Select
                        value={currentStatus}
                        onValueChange={(val) => setStatus(val as ContactStatus)}
                      >
                        <SelectTrigger className="w-[180px]" data-testid="select-status">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {contactStatuses.map((s) => (
                            <SelectItem key={s} value={s}>
                              {getStatusLabel(s)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-wrap gap-4 mt-4 text-sm">
                      {contact.email && (
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <Mail className="h-4 w-4" />
                          <span>{contact.email}</span>
                        </div>
                      )}
                      {contact.phone && (
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <Phone className="h-4 w-4" />
                          <span>{contact.phone}</span>
                        </div>
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
                  <p className="text-2xl font-bold text-foreground" data-testid="text-days-waiting">
                    {contact.daysOnWaitlist}
                  </p>
                </CardContent>
              </Card>
              <Card className="overflow-visible">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Calendar className="h-4 w-4" />
                    <span className="text-xs">Date Added</span>
                  </div>
                  <p className="text-sm font-medium text-foreground" data-testid="text-date-added">
                    {contact.dateAdded}
                  </p>
                </CardContent>
              </Card>
              <Card className="overflow-visible">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Calendar className="h-4 w-4" />
                    <span className="text-xs">Last Contact</span>
                  </div>
                  <p className="text-sm font-medium text-foreground" data-testid="text-last-contact">
                    {contact.lastContact || "N/A"}
                  </p>
                </CardContent>
              </Card>
              <Card className="overflow-visible">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <User className="h-4 w-4" />
                    <span className="text-xs">Assigned To</span>
                  </div>
                  <p className="text-sm font-medium text-foreground" data-testid="text-assigned-to">
                    {contact.assignedTo || "Unassigned"}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Notes Section */}
            <Card className="overflow-visible">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <FileText className="h-4 w-4" />
                  Notes
                </CardTitle>
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
                    data-testid="button-add-note"
                  >
                    Add Note
                  </Button>
                </div>

                <Separator />

                {/* Notes Timeline */}
                <div className="space-y-4">
                  {contact.notes && contact.notes.length > 0 ? (
                    contact.notes.map((note, idx) => (
                      <div key={idx} className="flex gap-3">
                        <div className="flex-shrink-0 w-2 h-2 mt-2 rounded-full bg-muted-foreground/30" />
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">
                            {note.date}
                          </p>
                          <p className="text-sm text-foreground">{note.content}</p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No notes yet
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* AI Insight Sidebar */}
          <div className="lg:col-span-1">
            <div className="lg:sticky lg:top-20 space-y-4">
              <AIInsightPanel
                insight={aiInsight}
                suggestedAction={
                  contact.daysOnWaitlist > 60
                    ? "Review provider availability for this service type."
                    : contact.status === "ready_to_schedule"
                    ? "Send appointment options to the contact."
                    : undefined
                }
                actionLabel={
                  contact.daysOnWaitlist > 60
                    ? "Check Providers"
                    : "Send Options"
                }
              />

              <Card className="overflow-visible">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Quick Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Button variant="outline" className="w-full justify-start" size="sm" data-testid="button-send-email">
                    <Mail className="h-4 w-4 mr-2" />
                    Send Email
                  </Button>
                  <Button variant="outline" className="w-full justify-start" size="sm" data-testid="button-schedule-call">
                    <Phone className="h-4 w-4 mr-2" />
                    Schedule Call
                  </Button>
                  <Button variant="outline" className="w-full justify-start" size="sm" data-testid="button-schedule-appt">
                    <Calendar className="h-4 w-4 mr-2" />
                    Schedule Appointment
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
