import { useQuery } from "@tanstack/react-query";
import { PageLayout } from "@/components/layout/page-layout";
import { KanbanColumn } from "@/components/kanban/kanban-column";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { LoadingState } from "@/components/ui/loading-spinner";
import { AlertCircle } from "lucide-react";
import { getWaitlistContacts } from "@/lib/api";
import type { ContactStatus, WaitlistContact } from "@shared/schema";

const columns: { status: ContactStatus; title: string }[] = [
  { status: "intake", title: "Intake" },
  { status: "waiting", title: "Waiting" },
  { status: "ready_to_schedule", title: "Ready to Schedule" },
  { status: "scheduled", title: "Scheduled" },
  { status: "on_hold", title: "On Hold" },
];

export default function Waitlist() {
  const { 
    data: contacts, 
    isLoading, 
    error 
  } = useQuery<WaitlistContact[]>({
    queryKey: ["/api/waitlist-contacts"],
    queryFn: getWaitlistContacts,
  });

  if (isLoading) {
    return (
      <PageLayout>
        <LoadingState message="Loading waitlist..." />
      </PageLayout>
    );
  }

  if (error || !contacts) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-muted-foreground">Failed to load waitlist data</p>
        </div>
      </PageLayout>
    );
  }

  const getContactsByStatus = (status: ContactStatus) =>
    contacts.filter((c) => c.status === status);

  return (
    <PageLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-foreground" data-testid="text-page-title">Waitlist Pipeline</h1>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-page-subtitle">
            Track contacts through the intake process
          </p>
        </div>

        <ScrollArea className="w-full">
          <div className="flex gap-4 pb-4 min-w-max">
            {columns.map((column) => (
              <KanbanColumn
                key={column.status}
                title={column.title}
                status={column.status}
                contacts={getContactsByStatus(column.status)}
                className="h-[calc(100vh-220px)] min-h-[400px]"
              />
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    </PageLayout>
  );
}
