import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { PageLayout } from "@/components/layout/page-layout";
import { Loader2, FileText, ArrowRightLeft, MessageSquare, Activity, Inbox, UserPlus, Pencil, UserCog } from "lucide-react";

interface ActivityEvent {
  id: number;
  type: string;
  actorEmail: string;
  entityType: string;
  entityId: string;
  entityName: string;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function getEventIcon(type: string) {
  switch (type) {
    case "submission_received":
      return <FileText className="h-4 w-4 text-blue-500" />;
    case "status_changed":
      return <ArrowRightLeft className="h-4 w-4 text-amber-500" />;
    case "note_added":
      return <MessageSquare className="h-4 w-4 text-green-500" />;
    case "contact_updated":
      return <Pencil className="h-4 w-4 text-purple-500" />;
    case "contact_assigned":
      return <UserPlus className="h-4 w-4 text-cyan-500" />;
    case "provider_updated":
      return <UserCog className="h-4 w-4 text-indigo-500" />;
    default:
      return <Activity className="h-4 w-4 text-muted-foreground" />;
  }
}

function formatActor(email: string): string {
  if (email === "system") return "System";
  const name = email.split("@")[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function formatTime(iso: string): string {
  const d = new Date(iso + "Z");
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDayLabel(iso: string): string {
  const d = new Date(iso + "Z");
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const eventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (eventDay.getTime() === today.getTime()) return "Today";
  if (eventDay.getTime() === yesterday.getTime()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function getDayKey(iso: string): string {
  const d = new Date(iso + "Z");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function groupByDay(activities: ActivityEvent[]): Map<string, ActivityEvent[]> {
  const groups = new Map<string, ActivityEvent[]>();
  for (const a of activities) {
    const key = getDayKey(a.createdAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  return groups;
}

export default function ActivityPage() {
  const { data, isLoading } = useQuery<{ activities: ActivityEvent[] }>({
    queryKey: ["/api/activity"],
    queryFn: async () => {
      const res = await fetch("/api/activity?limit=200", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch activity");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const activities = data?.activities ?? [];
  const grouped = groupByDay(activities);

  return (
    <PageLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Recent actions across the CRM
          </p>
        </div>

        {isLoading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Loading activity...</p>
          </div>
        )}

        {!isLoading && activities.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Inbox className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <p className="text-sm font-medium text-foreground">No activity yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Activity will appear as actions are taken in the CRM.
            </p>
          </div>
        )}

        {!isLoading && activities.length > 0 && (
          <div className="space-y-6">
            {Array.from(grouped.entries()).map(([dayKey, events]: [string, ActivityEvent[]]) => (
              <div key={dayKey}>
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  {formatDayLabel(events[0].createdAt)}
                </h2>
                <div className="space-y-1">
                  {events.map((event) => (
                    <div
                      key={event.id}
                      className="flex items-start gap-3 px-3 py-2 rounded-md hover:bg-muted/50 transition-colors"
                    >
                      <div className="mt-0.5 flex-shrink-0">{getEventIcon(event.type)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground">
                          {event.entityType === "contact" && event.entityId ? (
                            <Link
                              href={`/contact/${event.entityId}`}
                              className="hover:underline"
                            >
                              {event.summary}
                            </Link>
                          ) : (
                            event.summary
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {formatActor(event.actorEmail)} · {formatTime(event.createdAt)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
