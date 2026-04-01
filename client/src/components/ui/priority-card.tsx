import { cn, formatDob } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { OwnerBadge } from "@/components/ui/owner-badge";
import { Link } from "wouter";
import { Check, Shield, FileText, Video, Brain, Cake } from "lucide-react";
import { normalizeInsurance } from "@/lib/insurance-utils";
import type { WaitlistContact } from "@shared/schema";
import { computeDaysWaiting } from "@/lib/days-waiting";

interface PriorityCardProps {
  contact: WaitlistContact;
  priority: "high" | "medium" | "standard";
  position?: number; // 1-indexed position in the list
  avgWaitDays?: number; // Average wait days for comparison
  currentUserEmail?: string; // For owner badge "You" display
  // Phase 3: Action props (kept for backward compatibility, but actions no longer shown on hover)
  actionsEnabled?: boolean;
  isHandled?: boolean;
  onAddNote?: (contact: WaitlistContact) => void;
  onMarkContacted?: (contact: WaitlistContact) => void;
}

// Gradient border styles using pseudo-element for glassmorphic effect
const priorityStyles = {
  high: "relative rounded-l-none before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-red-500 before:via-red-400 before:to-red-600 before:rounded-l-lg before:shadow-[0_0_8px_rgba(239,68,68,0.4)]",
  medium: "relative rounded-l-none before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-amber-500 before:via-amber-400 before:to-amber-600 before:rounded-l-lg before:shadow-[0_0_8px_rgba(245,158,11,0.4)]",
  standard: "relative rounded-l-none before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-blue-500 before:via-blue-400 before:to-blue-600 before:rounded-l-lg before:shadow-[0_0_8px_rgba(59,130,246,0.4)]",
};

// Urgency based on days waiting (independent of bucket)
function getUrgencyLevel(days: number): "critical" | "urgent" | "normal" {
  if (days >= 60) return "critical";
  if (days >= 30) return "urgent";
  return "normal";
}

const urgencyBadgeStyles = {
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  urgent: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  normal: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

/**
 * Normalize modality/location for display
 * Maps raw modality values to cleaner display labels
 */
function formatModality(rawModality: string | null | undefined): string {
  if (!rawModality) return "Unknown";
  const trimmed = rawModality.trim();
  if (!trimmed) return "Unknown";
  
  // Clean up common patterns
  const lower = trimmed.toLowerCase();
  if (lower.includes("telehealth") || lower === "th") return "Telehealth";
  if (lower.includes("hybrid")) return "Hybrid";
  if (lower.includes("in person") || lower.includes("in-person")) {
    // Extract location if present
    if (lower.includes("abq") || lower.includes("albuquerque")) return "In Person - ABQ";
    if (lower.includes("rr") || lower.includes("rio rancho")) return "In Person - Rio Rancho";
    if (lower.includes("los lunas")) return "In Person - Los Lunas";
    return "In Person";
  }
  if (lower.includes("flex")) return "Flexible";
  
  return trimmed;
}

export function PriorityCard({
  contact,
  priority,
  position,
  avgWaitDays = 0,
  currentUserEmail,
  actionsEnabled = false,
  isHandled = false,
  onAddNote,
  onMarkContacted,
}: PriorityCardProps) {
  // Defensive: guard against missing contact data
  const contactName = contact?.name || "Unknown";
  const contactId = contact?.contactId;
  const days = computeDaysWaiting(contact?.dateAdded, contact?.daysOnWaitlist);
  const urgency = getUrgencyLevel(days);
  const isTopPriority = position === 1;
  const testIdSlug = contactName.toLowerCase().replace(/\s+/g, '-');

  // DATA INTEGRITY: Log warning if contactId is missing
  if (contactId === undefined || contactId === null) {
    console.warn("[PriorityCard] Missing contactId for contact:", contactName);
  }

  // Intake decision data for hover display
  const insurance = normalizeInsurance(contact?.insurancePayer);
  const modality = formatModality(contact?.modality);
  const service = (contact as any)?.requestingFor?.trim() || contact?.serviceRequested?.trim() || "Unknown";

  // Format reasonForTherapy MCQ for hover display (may be array or comma-separated string)
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

  // Format DOB for display — handles Excel serials, ISO, US formats
  const dobDisplay = (() => {
    const raw = contact?.patientDob;
    if (!raw) return null;
    const result = formatDob(raw);
    return result === "---" ? null : result;
  })();

  // CANONICAL: Use contactId for navigation, fall back to preventing navigation if missing
  const contactHref = contactId ? `/contact/${contactId}` : "#";

  return (
    <Link href={contactHref} data-testid={`link-priority-${testIdSlug}`}>
      <Card
        className={cn(
          "hover-elevate active-elevate-2 cursor-pointer transition-all duration-300 hover:translate-y-[-4px] hover:shadow-xl hover:shadow-black/10 dark:hover:shadow-black/30 hover:scale-[1.02] overflow-visible group",
          "bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm",
          priorityStyles[priority],
          isTopPriority && "ring-2 ring-offset-2 ring-offset-background/50",
          isTopPriority && priority === "high" && "ring-red-400/50 dark:ring-red-600/50 shadow-red-500/20 animate-subtle-pulse",
          isTopPriority && priority === "medium" && "ring-amber-400/50 dark:ring-amber-600/50 shadow-amber-500/20",
          isTopPriority && priority === "standard" && "ring-blue-400/50 dark:ring-blue-600/50 shadow-blue-500/20",
          // Visual feedback when handled
          isHandled && "opacity-60"
        )}
        data-testid={`priority-card-${testIdSlug}`}
      >
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              {position && (
                <span className={cn(
                  "flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold",
                  isTopPriority
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground",
                  // Show checkmark when handled
                  isHandled && "bg-green-500 text-white"
                )}>
                  {isHandled ? <Check className="h-3 w-3" /> : position}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className={cn(
                  "text-sm text-foreground truncate",
                  isTopPriority ? "font-semibold" : "font-medium"
                )}>
                  {contactName}
                </p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {(contact as any)?.requestingFor ?? contact?.serviceRequested ?? "—"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {/* Handled indicator */}
              {isHandled && (
                <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">
                  Done
                </span>
              )}
              <Badge
                variant="secondary"
                className={cn(
                  "text-xs font-bold shrink-0 tabular-nums",
                  urgencyBadgeStyles[urgency]
                )}
              >
                {days}d
              </Badge>
            </div>
          </div>

          {/* Ownership row - always visible */}
          <div className="mt-2 pt-2 border-t border-border/30 flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">Assigned to:</span>
            {contact?.assignedTo ? (
              <OwnerBadge
                email={contact.assignedTo}
                currentUserEmail={currentUserEmail}
                size="sm"
              />
            ) : (
              <span className="text-[10px] text-muted-foreground italic">Unassigned</span>
            )}
          </div>

          {/* Hover context: Intake decision data */}
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
                {/* Service / Who therapy is for */}
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
                {/* Reason for therapy (MCQ) - only shown when available */}
                {reasonDisplay && (
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <Brain className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">Reason:</span>
                    <span className="font-medium text-foreground truncate">
                      {reasonDisplay}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
