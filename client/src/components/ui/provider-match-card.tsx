/**
 * Provider Match Card
 *
 * Displays a single provider match result with score and reasons.
 */

import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Check, AlertTriangle, Minus, Info } from "lucide-react";
import type { ProviderMatch } from "@/lib/provider-matching";
import { LOCATION_LABELS, AGE_GROUP_LABELS } from "@/lib/providers";

interface ProviderMatchCardProps {
  match: ProviderMatch;
  rank: number;
}

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

export function ProviderMatchCard({ match, rank }: ProviderMatchCardProps) {
  const { provider, score, tier, reasons } = match;
  const tierStyle = tierStyles[tier];

  // Build subtitle from provider info
  const subtitleParts: string[] = [];
  subtitleParts.push(LOCATION_LABELS[provider.location]);

  // Add age groups served
  const ageGroupsServed = provider.ageGroups
    .map((ag) => AGE_GROUP_LABELS[ag.ageGroup])
    .slice(0, 2); // Limit to first 2 for display
  if (ageGroupsServed.length > 0) {
    subtitleParts.push(ageGroupsServed.join(", "));
  }

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

            {/* Name and credentials */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="font-medium text-foreground truncate">
                  {provider.name}
                </h4>
                {provider.credentials && (
                  <span className="text-sm text-muted-foreground">
                    {provider.credentials}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {subtitleParts.join(" · ")}
              </p>
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
                    Based on specialty fit, age group, location, and availability.
                  </p>
                  <p className="text-xs">
                    <span className="text-green-600">90+ Excellent</span>
                    {" · "}
                    <span className="text-blue-600">70-89 Good</span>
                    <br />
                    <span className="text-amber-600">50-69 Fair</span>
                    {" · "}
                    <span className="text-muted-foreground">30-49 Poor</span>
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Badge className={cn("text-xs font-medium", tierStyle.badge)}>
              {tierStyle.label}
            </Badge>
          </div>
        </div>

        {/* Reasons list */}
        {reasons.length > 0 && (
          <div className="mt-3 pl-9 space-y-1">
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

        {/* Additional specialties preview */}
        {provider.additionalSpecialties.length > 0 && (
          <div className="mt-2 pl-9">
            <div className="flex flex-wrap gap-1">
              {provider.additionalSpecialties.slice(0, 4).map((specialty, index) => (
                <Badge
                  key={index}
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-5 font-normal"
                >
                  {specialty}
                </Badge>
              ))}
              {provider.additionalSpecialties.length > 4 && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-5 font-normal text-muted-foreground"
                >
                  +{provider.additionalSpecialties.length - 4} more
                </Badge>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
