/**
 * Patient Matching Modal
 *
 * Displays ranked waitlist contacts compatible with a given provider.
 * Inverse of provider-matching-modal: Provider → Patients.
 * Advisory only — no actions, no persistence.
 */

import { useMemo } from "react";
import { computeDaysWaiting } from "@/lib/days-waiting";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  UserSearch,
  AlertTriangle,
  Info,
  Loader2,
  Check,
  Minus,
  ExternalLink,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getWaitlistContacts } from "@/lib/api";
import {
  computePatientMatches,
  type PatientMatch,
} from "@/lib/reverse-matching";
import { getCapacityStatus } from "@/lib/provider-matching";
import type { ProviderWithInsurance } from "@/lib/provider-api";

interface PatientMatchingModalProps {
  isOpen: boolean;
  onClose: () => void;
  provider: ProviderWithInsurance | null;
}

// --- Shared styles (mirroring provider-match-card.tsx) ---

const tierStyles = {
  excellent: {
    badge: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    label: "Excellent",
  },
  good: {
    badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    label: "Good",
  },
  fair: {
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    label: "Fair",
  },
  poor: {
    badge: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    label: "Poor",
  },
};

const reasonIcons = {
  positive: Check,
  neutral: Minus,
  warning: AlertTriangle,
};

const reasonStyles = {
  positive: "text-green-600 dark:text-green-400",
  neutral: "text-muted-foreground",
  warning: "text-amber-600 dark:text-amber-400",
};

const urgencyBadgeStyles = {
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  urgent: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  normal: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

function getUrgencyLevel(days: number): "critical" | "urgent" | "normal" {
  if (days >= 60) return "critical";
  if (days >= 30) return "urgent";
  return "normal";
}

// --- PatientMatchCard (inline) ---

function PatientMatchCard({
  match,
  rank,
}: {
  match: PatientMatch;
  rank: number;
}) {
  const { contact, score, tier, reasons } = match;
  const tierStyle = tierStyles[tier];
  const days = computeDaysWaiting(contact.dateAdded, contact.daysOnWaitlist);
  const urgency = getUrgencyLevel(days);

  // Subtitle parts
  const subtitleParts: string[] = [];
  if (contact.serviceRequested) subtitleParts.push(contact.serviceRequested);
  if (contact.insurancePayer) subtitleParts.push(contact.insurancePayer);
  if (contact.modality) subtitleParts.push(contact.modality);

  // Reason for therapy display
  const reasonDisplay = (() => {
    const r = contact.reasonForTherapy;
    if (!r || !Array.isArray(r) || r.length === 0) return null;
    const valid = r.map((s) => s?.trim()).filter(Boolean);
    if (valid.length === 0) return null;
    if (valid.length <= 2) return valid.join(", ");
    return `${valid[0]}, ${valid[1]} +${valid.length - 2} more`;
  })();

  return (
    <Card className="hover:bg-muted/30 transition-colors">
      <CardContent className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            {/* Rank badge */}
            <span
              className={cn(
                "flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold",
                rank === 1
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {rank}
            </span>

            {/* Name and days */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                {contact.contactId ? (
                  <Link href={`/contact/${contact.contactId}`}>
                    <h4 className="font-medium text-foreground truncate hover:underline cursor-pointer">
                      {contact.name}
                    </h4>
                  </Link>
                ) : (
                  <h4 className="font-medium text-foreground truncate">
                    {contact.name}
                  </h4>
                )}
                <Badge
                  className={cn(
                    "text-xs font-bold shrink-0 tabular-nums",
                    urgencyBadgeStyles[urgency]
                  )}
                >
                  {days}d
                </Badge>
              </div>
              {subtitleParts.length > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {subtitleParts.join(" \u00b7 ")}
                </p>
              )}
            </div>
          </div>

          {/* Score and tier */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 cursor-help">
                    <span className="text-lg font-bold text-foreground tabular-nums">
                      {score}
                    </span>
                    <Info className="h-3.5 w-3.5 text-muted-foreground/60" />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-[220px]">
                  <p className="font-medium mb-1">Match Score (0-125)</p>
                  <p className="text-xs text-muted-foreground mb-2">
                    Based on insurance, age group, specialty, and modality fit.
                  </p>
                  <p className="text-xs">
                    <span className="text-green-600">100+ Excellent</span>
                    {" \u00b7 "}
                    <span className="text-blue-600">75-99 Good</span>
                    <br />
                    <span className="text-amber-600">50-74 Fair</span>
                    {" \u00b7 "}
                    <span className="text-muted-foreground">&lt;50 Poor</span>
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Badge className={cn("text-xs font-medium", tierStyle.badge)}>
              {tierStyle.label}
            </Badge>
          </div>
        </div>

        {/* Reason for therapy */}
        {reasonDisplay && (
          <div className="mt-2 pl-9 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Reason:</span>{" "}
            {reasonDisplay}
          </div>
        )}

        {/* Match reasons */}
        {reasons.length > 0 && (
          <div className="mt-2 pl-9 space-y-1">
            {reasons.slice(0, 4).map((reason, index) => {
              const Icon = reasonIcons[reason.type];
              return (
                <div
                  key={index}
                  className={cn(
                    "flex items-center gap-2 text-xs",
                    reasonStyles[reason.type]
                  )}
                >
                  <Icon className="h-3 w-3 flex-shrink-0" />
                  <span>{reason.text}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Footer: assigned-to + view link */}
        <div className="mt-3 pl-9 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <User className="h-3 w-3" />
            {contact.assignedTo ? (
              <span>{contact.assignedTo}</span>
            ) : (
              <span className="italic">Unassigned</span>
            )}
          </div>
          <Link
            href={`/contact/${contact.contactId}`}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-2 gap-1"
            >
              View Contact
              <ExternalLink className="h-3 w-3" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Main Modal ---

export function PatientMatchingModal({
  isOpen,
  onClose,
  provider,
}: PatientMatchingModalProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/waitlist-contacts"],
    queryFn: getWaitlistContacts,
    enabled: isOpen,
  });

  const matchResults = useMemo(() => {
    if (!provider || !data?.contacts) return null;
    return computePatientMatches(provider, data.contacts);
  }, [provider, data?.contacts]);

  // Loading state
  if (isOpen && isLoading) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserSearch className="h-5 w-5 text-primary" />
              Patient Matches
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
            <p className="text-sm text-muted-foreground">
              Loading waitlist contacts...
            </p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Error state
  if (isOpen && error) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserSearch className="h-5 w-5 text-primary" />
              Patient Matches
            </DialogTitle>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Failed to load waitlist contacts. Please try again later.
            </AlertDescription>
          </Alert>
          <div className="flex justify-end pt-4">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!provider || !matchResults) return null;

  const { matches, warnings } = matchResults;
  const hasWarnings = warnings.length > 0;
  const hasMatches = matches.length > 0;

  // Capacity is a property of THIS provider (fixed in this direction), so it
  // surfaces once as a banner — advisory only, never blocks any patient.
  const capacity = getCapacityStatus(provider);
  const capacityDetail = (() => {
    const parts: string[] = [];
    if (typeof capacity.info.reportedAccepting === "number") parts.push(`reported ${capacity.info.reportedAccepting}`);
    if (typeof capacity.info.assignedSinceForm === "number") parts.push(`${capacity.info.assignedSinceForm} assigned`);
    return parts.length > 0 ? parts.join(" · ") : null;
  })();

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <UserSearch className="h-5 w-5 text-primary" />
            Patient Matches
          </DialogTitle>
          <DialogDescription className="text-left">
            <span className="font-medium text-foreground">
              {provider.name}
            </span>
            {provider.credentials && (
              <>
                <span className="mx-1">,</span>
                <span>{provider.credentials}</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Info banner */}
        <div className="flex-shrink-0 text-xs text-muted-foreground bg-muted/50 rounded-md px-3 py-2 flex items-start gap-2">
          <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>
            Matches based on insurance, age group, modality, and reason for
            therapy. Advisory only.
          </span>
        </div>

        {/* Capacity advisory — informational only; this provider is still
            fully assignable/schedulable regardless of this banner. */}
        {capacity.atCapacity && (
          <Alert
            variant="default"
            className="flex-shrink-0 bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800"
          >
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800 dark:text-amber-200 text-sm">
              Not accepting new patients
              {capacityDetail && <span className="opacity-80"> ({capacityDetail})</span>}
              {". "}
              Still assignable — capacity is advisory only.
            </AlertDescription>
          </Alert>
        )}

        {/* Warnings */}
        {hasWarnings && (
          <Alert
            variant="default"
            className="flex-shrink-0 bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800"
          >
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800 dark:text-amber-200 text-sm">
              {warnings.length === 1 ? (
                warnings[0]
              ) : (
                <ul className="list-disc list-inside space-y-0.5">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* Results */}
        <div>
          {hasMatches ? (
            <div className="max-h-[calc(85vh-320px)] overflow-y-auto pr-2">
              <div className="space-y-3 pb-1">
                {matches.map((match, index) => (
                  <PatientMatchCard
                    key={match.contact.contactId}
                    match={match}
                    rank={index + 1}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Info className="h-10 w-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium text-foreground">
                No matching patients on the active waitlist
              </p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[300px]">
                No active waitlist contacts match this provider's capabilities.
                This may change as new contacts are added.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 pt-4 border-t flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {hasMatches
              ? `${matches.length} patient${matches.length !== 1 ? "s" : ""} matched`
              : "Results are advisory only"}
          </p>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
