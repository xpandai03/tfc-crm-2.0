/**
 * Provider Matching Modal
 *
 * Displays provider match results for a contact.
 * Advisory only - no actions, no persistence.
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
import { Users, AlertTriangle, Info } from "lucide-react";
import { ProviderMatchCard } from "./provider-match-card";
import {
  computeProviderMatches,
  formatContextSummary,
} from "@/lib/provider-matching";
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
  // Compute matches when contact changes
  const matchResults = useMemo(() => {
    if (!contact) return null;
    return computeProviderMatches(contact);
  }, [contact]);

  if (!contact || !matchResults) {
    return null;
  }

  const { matches, context, warnings } = matchResults;
  const contextSummary = formatContextSummary(context);
  const hasWarnings = warnings.length > 0;
  const hasMatches = matches.length > 0;

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

        {/* Warnings */}
        {hasWarnings && (
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

        {/* Results - flex-1 min-h-0 overflow-hidden ensures proper scroll context */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {hasMatches ? (
            <ScrollArea className="h-full pr-4">
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

        {/* Footer */}
        <div className="flex-shrink-0 pt-4 border-t flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {hasMatches
              ? `${matches.length} provider${matches.length !== 1 ? "s" : ""} found`
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
