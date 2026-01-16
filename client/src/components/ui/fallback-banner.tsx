import { AlertTriangle, Info, X, RefreshCw } from "lucide-react";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FallbackBannerProps {
  show: boolean;
  message?: string;
  variant?: "warning" | "info";
  lastSyncTime?: Date | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function FallbackBanner({
  show,
  message = "Live data temporarily unavailable - showing demo data",
  variant = "warning",
  lastSyncTime,
  onRefresh,
  isRefreshing = false
}: FallbackBannerProps) {
  // DISABLED: App now always shows live Excel data
  // To re-enable, remove this early return
  return null;

  const [dismissed, setDismissed] = useState(false);
  const [timeAgo, setTimeAgo] = useState<string>("");

  useEffect(() => {
    if (!lastSyncTime) {
      setTimeAgo("");
      return;
    }
    const update = () => setTimeAgo(formatTimeAgo(lastSyncTime));
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [lastSyncTime]);

  if (!show || dismissed) return null;

  const isInfo = variant === "info";
  const Icon = isInfo ? Info : AlertTriangle;

  return (
    <div className={cn(
      "px-4 py-2.5 flex items-center justify-between gap-4",
      isInfo
        ? "bg-blue-50 dark:bg-blue-950/30 border-b border-blue-200 dark:border-blue-800"
        : "bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800"
    )}>
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Icon className={cn(
          "h-4 w-4 flex-shrink-0",
          isInfo ? "text-blue-600 dark:text-blue-400" : "text-amber-600 dark:text-amber-400"
        )} />
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className={cn(
            "text-sm font-medium",
            isInfo ? "text-blue-800 dark:text-blue-200" : "text-amber-800 dark:text-amber-200"
          )} data-testid="text-fallback-warning">
            {message}
          </span>
          {lastSyncTime && timeAgo && (
            <span className={cn(
              "text-xs",
              isInfo ? "text-blue-600 dark:text-blue-400" : "text-amber-600 dark:text-amber-400"
            )}>
              · Updated {timeAgo}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {onRefresh && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 text-xs",
              isInfo
                ? "text-blue-700 hover:text-blue-800 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/50"
                : "text-amber-700 hover:text-amber-800 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/50"
            )}
            onClick={onRefresh}
            disabled={isRefreshing}
            data-testid="button-banner-refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", isRefreshing && "animate-spin")} />
            Refresh
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-6 w-6",
            isInfo
              ? "text-blue-600 hover:text-blue-800 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-900/50"
              : "text-amber-600 hover:text-amber-800 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/50"
          )}
          onClick={() => setDismissed(true)}
          data-testid="button-dismiss-fallback"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
