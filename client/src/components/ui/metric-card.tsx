import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TrendingUp, TrendingDown, HelpCircle } from "lucide-react";

interface MetricCardProps {
  label: string;
  value: string | number;
  trend?: "up" | "down";
  trendLabel?: string;
  variant?: "default" | "warning" | "danger" | "success";
  tooltip?: string;
  className?: string;
}

const variantStyles = {
  default: "bg-white dark:bg-gray-900/80 border-gray-200/60 dark:border-gray-700/50",
  warning: "bg-amber-50 dark:bg-amber-500/10 border-amber-200/60 dark:border-amber-500/20",
  danger: "bg-red-50 dark:bg-red-500/10 border-red-200/60 dark:border-red-500/20",
  success: "bg-green-50 dark:bg-green-500/10 border-green-200/60 dark:border-green-500/20",
};

const variantTextStyles = {
  default: {
    label: "text-muted-foreground",
    value: "text-foreground",
    icon: "text-muted-foreground/50",
  },
  warning: {
    label: "text-amber-900 dark:text-amber-100",
    value: "text-amber-950 dark:text-white",
    icon: "text-amber-800/70 dark:text-amber-200/70",
  },
  danger: {
    label: "text-red-900 dark:text-red-100",
    value: "text-red-950 dark:text-white",
    icon: "text-red-800/70 dark:text-red-200/70",
  },
  success: {
    label: "text-green-900 dark:text-green-100",
    value: "text-green-950 dark:text-white",
    icon: "text-green-800/70 dark:text-green-200/70",
  },
};

export function MetricCard({
  label,
  value,
  trend,
  trendLabel,
  variant = "default",
  tooltip,
  className,
}: MetricCardProps) {
  const textStyles = variantTextStyles[variant];

  return (
    <Card className={cn("overflow-visible transition-all duration-300 hover:shadow-xl hover:shadow-black/10 dark:hover:shadow-black/30 hover:-translate-y-0.5", variantStyles[variant], className)}>
      <CardContent className="p-5">
        <div className="flex items-center gap-1.5 mb-1">
          <p className={cn("text-sm", textStyles.label)}>{label}</p>
          {tooltip && (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <HelpCircle className={cn("h-3.5 w-3.5 cursor-help", textStyles.icon)} />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[200px] text-xs">
                {tooltip}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex items-end justify-between gap-2">
          <p className={cn("text-3xl font-bold", textStyles.value)} data-testid={`text-metric-${label.toLowerCase().replace(/\s+/g, '-')}`}>
            {value}
          </p>
          {trend && (
            <div
              className={cn(
                "flex items-center gap-1 text-xs font-medium",
                trend === "up" ? "text-red-600" : "text-green-600"
              )}
            >
              {trend === "up" ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {trendLabel && <span>{trendLabel}</span>}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
