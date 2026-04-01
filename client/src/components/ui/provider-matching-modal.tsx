/**
 * Provider Matching Modal
 *
 * Displays provider match results for a contact.
 * Advisory only - no actions, no persistence.
 *
 * v1.1: Uses live provider data from API with insurance matching
 */

import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Users, AlertTriangle, Info, Loader2 } from "lucide-react";
import { ProviderMatchCard } from "./provider-match-card";
import {
  computeProviderMatches,
  formatContextSummary,
} from "@/lib/provider-matching";
import {
  computeProviderMatchesV2,
  formatContextSummaryV2,
} from "@/lib/provider-matching-v2";
import { useProviders } from "@/lib/provider-api";
import { isInsuranceAcceptedByTFC, normalizeInsurance } from "@/lib/insurance-utils";
import type { ContactSnapshot } from "@shared/schema";

interface ProviderMatchingModalProps {
  isOpen: boolean;
  onClose: () => void;
  contact: ContactSnapshot | null;
}

export function ProviderMatchingModal({
  isOpen,
  onClose,
  contact,
}: ProviderMatchingModalProps) {
  // Fetch providers from API
  const { providers, isLoading, error } = useProviders();

  // Compute matches when contact or providers change
  const matchResults = useMemo(() => {
    if (!contact) return null;
    return computeProviderMatches(contact, providers);
  }, [contact, providers]);

  // v2 shadow run — comparison only, not displayed to users
  const v2Results = useMemo(() => {
    if (!contact) return null;
    return computeProviderMatchesV2(contact, providers);
  }, [contact, providers]);

  // Log comparison when both results are available
  useMemo(() => {
    if (!matchResults || !v2Results || !contact) return;
    const v1Top = matchResults.matches.slice(0, 5).map((m) => ({
      name: m.provider.name,
      score: m.score,
      tier: m.tier,
    }));
    const v2Top = v2Results.matches.slice(0, 5).map((m) => ({
      name: m.provider.name,
      score: m.score,
      tier: m.tier,
    }));
    const v1Names = v1Top.map((m) => m.name);
    const v2Names = v2Top.map((m) => m.name);
    const topChanged = v1Names[0] !== v2Names[0];
    const orderChanged = v1Names.join(",") !== v2Names.join(",");
    console.log(
      `%c[MATCHING COMPARISON] ${contact.name}`,
      topChanged ? "color: #ef4444; font-weight: bold" : "color: #3b82f6",
      {
        v1Context: formatContextSummary(matchResults.context),
        v2Context: formatContextSummaryV2(v2Results.context),
        v1Top5: v1Top,
        v2Top5: v2Top,
        topMatchChanged: topChanged,
        orderChanged,
        v1Warnings: matchResults.warnings,
        v2Warnings: v2Results.warnings,
      }
    );
  }, [matchResults, v2Results, contact]);

  // Show loading state while fetching providers
  if (isOpen && isLoading) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Provider Matches
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
            <p className="text-sm text-muted-foreground">Loading providers...</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Show error state
  if (isOpen && error) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Provider Matches
            </DialogTitle>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Failed to load provider data. Please try again later.
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

  if (!contact || !matchResults) {
    return null;
  }

  const { matches, context, warnings } = matchResults;
  const contextSummary = formatContextSummary(context);
  const hasWarnings = warnings.length > 0;
  const hasMatches = matches.length > 0;

  // Check if contact's insurance is accepted by TFC
  const contactInsurance = normalizeInsurance(contact.insurancePayer);
  const insuranceAccepted = isInsuranceAcceptedByTFC(contactInsurance);
  // Show rejection if: insurance is known and not accepted, OR contact has status 400 (Insurance Not Accepted)
  const hasStatus400 = contact.statusCode === 400;
  const showInsuranceRejection = (contactInsurance !== "Unknown" && !insuranceAccepted) || hasStatus400;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            Provider Matches
          </DialogTitle>
          <DialogDescription className="text-left">
            <span className="font-medium text-foreground">{contact.name}</span>
            <span className="mx-2">·</span>
            <span>{contextSummary}</span>
          </DialogDescription>
        </DialogHeader>

        {/* Matching criteria info */}
        <div className="flex-shrink-0 text-xs text-muted-foreground bg-muted/50 rounded-md px-3 py-2 flex items-start gap-2">
          <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>
            Matches based on reason for seeking services, age group, modality, location, and accepted insurance.
          </span>
        </div>

        {/* Insurance rejection warning */}
        {showInsuranceRejection && (
          <Alert variant="destructive" className="flex-shrink-0">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {hasStatus400 ? (
                <>
                  This contact's insurance (<strong>{contact.insurancePayer || "Unknown"}</strong>) was previously determined to not be accepted by TFC.
                </>
              ) : (
                <>
                  <strong>{contact.insurancePayer}</strong> is not accepted by TFC. No provider matches available for this insurance.
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* Warnings */}
        {hasWarnings && !showInsuranceRejection && (
          <Alert variant="default" className="flex-shrink-0 bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800 dark:text-amber-200 text-sm">
              {warnings.length === 1 ? (
                warnings[0]
              ) : (
                <ul className="list-disc list-inside space-y-0.5">
                  {warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* Results - scrollable area with explicit max height */}
        <div className="flex-1 min-h-0">
          {hasMatches ? (
            <ScrollArea className="h-[calc(85vh-220px)] pr-4">
              <div className="space-y-3 pb-1">
                {matches.map((match, index) => (
                  <ProviderMatchCard
                    key={match.provider.name}
                    match={match}
                    rank={index + 1}
                  />
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Info className="h-10 w-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm font-medium text-foreground">
                No provider matches found
              </p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[300px]">
                Unable to find providers that match the contact's intake data.
                Please review the intake information or consult with a supervisor.
              </p>
            </div>
          )}
        </div>

        {/* v2 Comparison Panel (dev only — not user-facing) */}
        {v2Results && v2Results.matches.length > 0 && (
          <div className="flex-shrink-0 rounded-md border border-dashed border-violet-300 dark:border-violet-700 bg-violet-50/50 dark:bg-violet-950/20 px-3 py-2 text-[10px] font-mono text-violet-700 dark:text-violet-300 space-y-1">
            <div className="font-semibold text-[11px]">v2 Shadow Comparison</div>
            <div className="grid grid-cols-2 gap-x-4">
              <div>
                <span className="text-violet-500">v1 #1:</span>{" "}
                {matches[0]?.provider.name ?? "—"}{" "}
                <span className="text-violet-400">({matches[0]?.score ?? 0})</span>
              </div>
              <div>
                <span className="text-violet-500">v2 #1:</span>{" "}
                {v2Results.matches[0]?.provider.name ?? "—"}{" "}
                <span className="text-violet-400">({v2Results.matches[0]?.score ?? 0})</span>
              </div>
              <div>
                <span className="text-violet-500">v1 #2:</span>{" "}
                {matches[1]?.provider.name ?? "—"}{" "}
                <span className="text-violet-400">({matches[1]?.score ?? 0})</span>
              </div>
              <div>
                <span className="text-violet-500">v2 #2:</span>{" "}
                {v2Results.matches[1]?.provider.name ?? "—"}{" "}
                <span className="text-violet-400">({v2Results.matches[1]?.score ?? 0})</span>
              </div>
              <div>
                <span className="text-violet-500">v1 #3:</span>{" "}
                {matches[2]?.provider.name ?? "—"}{" "}
                <span className="text-violet-400">({matches[2]?.score ?? 0})</span>
              </div>
              <div>
                <span className="text-violet-500">v2 #3:</span>{" "}
                {v2Results.matches[2]?.provider.name ?? "—"}{" "}
                <span className="text-violet-400">({v2Results.matches[2]?.score ?? 0})</span>
              </div>
            </div>
            <div className="text-violet-400 pt-0.5">
              Context: {formatContextSummaryV2(v2Results.context)}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex-shrink-0 pt-4 border-t flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {hasMatches
              ? `${matches.length} provider${matches.length !== 1 ? "s" : ""} matched based on intake criteria`
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
