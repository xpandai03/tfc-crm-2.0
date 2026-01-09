import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ContactStatus } from "@shared/schema";

interface StatusBadgeProps {
  status: ContactStatus;
  className?: string;
}

const statusConfig: Record<
  ContactStatus,
  { label: string; className: string }
> = {
  intake: {
    label: "Intake",
    className: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  },
  waiting: {
    label: "Waiting",
    className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  },
  ready_to_schedule: {
    label: "Ready to Schedule",
    className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  },
  scheduled: {
    label: "Scheduled",
    className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  },
  on_hold: {
    label: "On Hold",
    className: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  },
  closed: {
    label: "Closed",
    className: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300",
  },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status];
  
  return (
    <Badge
      variant="secondary"
      className={cn("text-xs font-medium", config.className, className)}
      data-testid={`status-badge-${status}`}
    >
      {config.label}
    </Badge>
  );
}

export function getStatusLabel(status: ContactStatus): string {
  return statusConfig[status].label;
}
