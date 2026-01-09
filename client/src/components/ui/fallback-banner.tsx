import { AlertTriangle, Info, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface FallbackBannerProps {
  show: boolean;
  message?: string;
  variant?: "warning" | "info";
}

export function FallbackBanner({ 
  show, 
  message = "Live data temporarily unavailable - showing demo data",
  variant = "warning"
}: FallbackBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (!show || dismissed) return null;

  const isInfo = variant === "info";
  const Icon = isInfo ? Info : AlertTriangle;

  return (
    <div className={`${
      isInfo 
        ? "bg-blue-50 dark:bg-blue-950/30 border-b border-blue-200 dark:border-blue-800" 
        : "bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800"
    } px-4 py-2 flex items-center justify-between gap-4`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 flex-shrink-0 ${
          isInfo 
            ? "text-blue-600 dark:text-blue-400" 
            : "text-amber-600 dark:text-amber-400"
        }`} />
        <span className={`text-sm ${
          isInfo 
            ? "text-blue-800 dark:text-blue-200" 
            : "text-amber-800 dark:text-amber-200"
        }`} data-testid="text-fallback-warning">
          {message}
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
