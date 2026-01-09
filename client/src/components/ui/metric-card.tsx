import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp, TrendingDown } from "lucide-react";

interface MetricCardProps {
  label: string;
  value: string | number;
  trend?: "up" | "down";
  trendLabel?: string;
  variant?: "default" | "warning" | "danger" | "success";
  className?: string;
}

const variantStyles = {
  default: "",
  warning: "border-l-4 border-l-amber-500",
  danger: "border-l-4 border-l-red-500",
  success: "border-l-4 border-l-green-500",
};

export function MetricCard({
  label,
  value,
  trend,
  trendLabel,
  variant = "default",
  className,
}: MetricCardProps) {
  return (
    <Card className={cn("overflow-visible", variantStyles[variant], className)}>
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground mb-1">{label}</p>
        <div className="flex items-end justify-between gap-2">
          <p className="text-3xl font-bold text-foreground" data-testid={`text-metric-${label.toLowerCase().replace(/\s+/g, '-')}`}>
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
