import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, ArrowRight } from "lucide-react";

interface AIInsightPanelProps {
  insight: string;
  suggestedAction?: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export function AIInsightPanel({
  insight,
  suggestedAction,
  actionLabel = "Take Action",
  onAction,
  className,
}: AIInsightPanelProps) {
  return (
    <Card className={`bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800 overflow-visible ${className}`}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-300">
          <Sparkles className="h-4 w-4" />
          <span className="uppercase tracking-wide text-xs">AI Insight</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-blue-900 dark:text-blue-100" data-testid="text-ai-insight">
          {insight}
        </p>
        {suggestedAction && (
          <div className="pt-2 border-t border-blue-200 dark:border-blue-800">
            <p className="text-xs text-blue-600 dark:text-blue-400 mb-2">
              Suggested Action
            </p>
            <p className="text-sm text-blue-800 dark:text-blue-200 mb-3" data-testid="text-ai-suggested-action">
              {suggestedAction}
            </p>
            {onAction && (
              <Button
                size="sm"
                variant="outline"
                onClick={onAction}
                className="text-blue-700 border-blue-300 hover:bg-blue-100 dark:text-blue-300 dark:border-blue-700 dark:hover:bg-blue-900/50"
                data-testid="button-ai-action"
              >
                {actionLabel}
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
