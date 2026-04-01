import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OwnerBadge } from "@/components/ui/owner-badge";
import { cn, formatDob } from "@/lib/utils";
import { normalizeInsurance } from "@/lib/insurance-utils";
import { getAttentionFlags } from "@/lib/api";
import { Plus, Clock, Shield, Video, FileText, Brain, AlertTriangle, Cake } from "lucide-react";
import type { WaitlistContact } from "@shared/schema";
import { computeDaysWaiting } from "@/lib/days-waiting";

/** Normalize modality/location for display (same logic as priority-card) */
function formatModality(rawModality: string | null | undefined): string {
  if (!rawModality) return "Unknown";
  const trimmed = rawModality.trim();
  if (!trimmed) return "Unknown";
  const lower = trimmed.toLowerCase();
  if (lower.includes("telehealth") || lower === "th") return "Telehealth";
  if (lower.includes("hybrid")) return "Hybrid";
  if (lower.includes("in person") || lower.includes("in-person")) {
    if (lower.includes("abq") || lower.includes("albuquerque")) return "In Person - ABQ";
    if (lower.includes("rr") || lower.includes("rio rancho")) return "In Person - Rio Rancho";
    if (lower.includes("los lunas")) return "In Person - Los Lunas";
    return "In Person";
  }
  if (lower.includes("flex")) return "Flexible";
  return trimmed;
}

interface DraggableCardProps {
  contact: WaitlistContact;
  onAddNote: (contact: WaitlistContact) => void;
  isDragging?: boolean;
  currentUserEmail?: string;
}

export function DraggableCard({ contact, onAddNote, isDragging = false, currentUserEmail }: DraggableCardProps) {
  // CRITICAL: Use contactId as the canonical drag identifier
  // This ensures status updates target the correct Excel row
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: contact.contactId.toString(), // contactId is now required - use it as the drag ID
  });

  // Attention flag check (TanStack Query deduplicates — zero extra network cost)
  const { data: flagsData } = useQuery({
    queryKey: ["/api/attention-flags"],
    queryFn: getAttentionFlags,
    staleTime: 30_000,
  });
  const isFlagged = flagsData?.flags?.some(f => f.contactId === contact.contactId) ?? false;

  const daysWaiting = computeDaysWaiting(contact.dateAdded, contact.daysOnWaitlist);
  const isUrgent = daysWaiting > 60;
  const isWarning = daysWaiting > 30 && daysWaiting <= 60;

  // Format DOB for display — handles Excel serials, ISO, US formats
  const dobDisplay = (() => {
    const raw = contact?.patientDob;
    if (!raw) return null;
    const result = formatDob(raw);
    return result === "---" ? null : result;
  })();

  // Hover expansion data
  const insurance = normalizeInsurance(contact?.insurancePayer);
  const modality = formatModality(contact?.modality);
  const service = contact?.serviceRequested || "Unknown";

  // Reason display — always show, with explicit legacy fallback
  // Cast to unknown for runtime safety: n8n may send string instead of array
  const reasonDisplay = (() => {
    const raw: unknown = contact?.reasonForTherapy;
    if (Array.isArray(raw) && raw.length > 0) {
      const valid = (raw as string[]).map(r => r?.trim()).filter(Boolean);
      if (valid.length === 0) return null;
      if (valid.length <= 2) return valid.join(", ");
      return `${valid[0]}, ${valid[1]} +${valid.length - 2} more`;
    }
    if (typeof raw === "string" && raw.trim()) {
      const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
      if (parts.length === 0) return null;
      if (parts.length <= 2) return parts.join(", ");
      return `${parts[0]}, ${parts[1]} +${parts.length - 2} more`;
    }
    return null;
  })();

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
              <div className="flex items-center gap-1">
                <p className="font-medium text-sm text-foreground truncate hover:underline">
                  {contact.name}
                </p>
                {isFlagged && (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
                )}
              </div>
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
            {contact.requestingFor ?? contact.serviceRequested}
          </p>
          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>{daysWaiting}d</span>
            </div>
            <div className="flex items-center gap-1">
              {contact.assignedTo && (
                <OwnerBadge
                  email={contact.assignedTo}
                  currentUserEmail={currentUserEmail}
                  size="sm"
                />
              )}
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
          </div>

          {/* Hover context: Intake decision data (hidden during drag) */}
          {!isDragging && (
            <div className="grid grid-rows-[0fr] group-hover:grid-rows-[1fr] transition-[grid-template-rows] duration-150">
              <div className="overflow-hidden">
                <div className="pt-2 mt-2 border-t border-border/50 space-y-1">
                  {/* DOB */}
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <Cake className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">DOB:</span>
                    <span className={cn(
                      "font-medium truncate",
                      !dobDisplay ? "text-muted-foreground italic" : "text-foreground"
                    )}>
                      {dobDisplay || "---"}
                    </span>
                  </div>
                  {/* Insurance */}
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <Shield className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">Insurance:</span>
                    <span className={cn(
                      "font-medium truncate",
                      insurance === "Unknown" ? "text-muted-foreground italic" : "text-foreground"
                    )}>
                      {insurance}
                    </span>
                  </div>
                  {/* Modality */}
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <Video className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">Modality:</span>
                    <span className={cn(
                      "font-medium truncate",
                      modality === "Unknown" ? "text-muted-foreground italic" : "text-foreground"
                    )}>
                      {modality}
                    </span>
                  </div>
                  {/* Service */}
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <FileText className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">Service:</span>
                    <span className={cn(
                      "font-medium truncate",
                      service === "Unknown" ? "text-muted-foreground italic" : "text-foreground"
                    )}>
                      {service}
                    </span>
                  </div>
                  {/* Reason for Seeking Services — always shown */}
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <Brain className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">Reason:</span>
                    <span className={cn(
                      "font-medium truncate",
                      !reasonDisplay ? "text-muted-foreground italic" : "text-foreground"
                    )}>
                      {reasonDisplay || "Not collected (legacy intake)"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
