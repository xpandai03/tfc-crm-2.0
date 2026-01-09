import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface FallbackBannerProps {
  show: boolean;
}

export function FallbackBanner({ show }: FallbackBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (!show || dismissed) return null;

  return (
    <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 px-4 py-2 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <span className="text-sm text-amber-800 dark:text-amber-200" data-testid="text-fallback-warning">
          Live data temporarily unavailable - showing demo data
        </span>
      </div>
      <Button 
        variant="ghost" 
        size="icon" 
        className="h-6 w-6"
        onClick={() => setDismissed(true)}
        data-testid="button-dismiss-fallback"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
