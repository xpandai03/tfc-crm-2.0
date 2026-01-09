import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface SyncStatusProps {
  lastSyncTime: Date | null;
  onRefresh: () => void;
  isRefreshing?: boolean;
  className?: string;
}

export function SyncStatus({ 
  lastSyncTime, 
  onRefresh, 
  isRefreshing = false,
  className 
}: SyncStatusProps) {
  const [timeAgo, setTimeAgo] = useState<string>("");

  useEffect(() => {
    if (!lastSyncTime) {
      setTimeAgo("");
      return;
    }

    const updateTimeAgo = () => {
      const seconds = Math.floor((Date.now() - lastSyncTime.getTime()) / 1000);
      if (seconds < 5) {
        setTimeAgo("just now");
      } else if (seconds < 60) {
        setTimeAgo(`${seconds}s ago`);
      } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        setTimeAgo(`${minutes}m ago`);
      } else {
        const hours = Math.floor(seconds / 3600);
        setTimeAgo(`${hours}h ago`);
      }
    };

    updateTimeAgo();
    const interval = setInterval(updateTimeAgo, 5000);
    return () => clearInterval(interval);
  }, [lastSyncTime]);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {lastSyncTime && (
        <span className="text-xs text-muted-foreground" data-testid="text-last-synced">
          Last synced: {timeAgo}
        </span>
      )}
      <Button 
        variant="outline" 
        size="sm" 
        onClick={onRefresh}
        disabled={isRefreshing}
        data-testid="button-refresh"
      >
        <RefreshCw className={cn("h-4 w-4 mr-2", isRefreshing && "animate-spin")} />
        Refresh
      </Button>
    </div>
  );
}
