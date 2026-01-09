import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { MetricCard } from "@/components/ui/metric-card";
import { PriorityCard } from "@/components/ui/priority-card";
import { AIInsightPanel } from "@/components/ui/ai-insight-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from "@/components/ui/loading-spinner";
import { SyncStatus } from "@/components/ui/sync-status";
import { FallbackBanner } from "@/components/ui/fallback-banner";
import { AlertTriangle, Clock, CalendarCheck, AlertCircle } from "lucide-react";
import { getWaitlistSummary, getWaitlistContacts, type WithSource } from "@/lib/api";
import { useDataSource } from "@/lib/data-source-context";
import { 
  isActiveStatus, 
  stringStatusToCode, 
  safeNumber,
  STATUS_GROUPS,
} from "@/lib/status-config";
import type { WaitlistSummary, WaitlistContact } from "@shared/schema";

/**
 * Home/Today View
 * 
 * Priority queues are computed from contacts:
 * - Over 60 Days: daysOnWaitlist >= 60 AND active
 * - Ready to Schedule: statusCode in [200]
 * - Needs Follow-up: statusCode in waiting group (101, 102) AND 14 < days <= 60
 */
export default function Home() {
  const queryClient = useQueryClient();
  const { updateSource, updateSyncTime, lastSyncTime, isFallback } = useDataSource();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { 
    data: summaryData, 
    isLoading: summaryLoading, 
    error: summaryError,
    refetch: refetchSummary,
  } = useQuery<WithSource<WaitlistSummary>>({
    queryKey: ["/api/waitlist-summary"],
    queryFn: getWaitlistSummary,
  });

  const { 
    data: contactsData, 
    isLoading: contactsLoading, 
    error: contactsError,
    refetch: refetchContacts,
  } = useQuery<{ contacts: WaitlistContact[]; _source?: string }>({
    queryKey: ["/api/waitlist-contacts"],
    queryFn: getWaitlistContacts,
  });

  const isLoading = summaryLoading || contactsLoading;
  const error = summaryError || contactsError;

  const contacts = contactsData?.contacts || [];

  useEffect(() => {
    if (summaryData?._source) {
      updateSource(summaryData._source as "mock" | "live" | "fallback");
      updateSyncTime();
    }
  }, [summaryData, updateSource, updateSyncTime]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([refetchSummary(), refetchContacts()]);
    setIsRefreshing(false);
  };

  // Get the effective status code for a contact (handles both live and mock data)
  const getContactStatusCode = (contact: WaitlistContact): number => {
    return contact.statusCode ?? stringStatusToCode(contact.status);
  };

  // Compute metrics from contacts
  const computedMetrics = useMemo(() => {
    if (!contacts || contacts.length === 0) {
      return {
        totalActive: 0,
        avgWaitDays: 0,
        over60Days: 0,
        readyToSchedule: 0,
      };
    }

    const activeContacts = contacts.filter(c => {
      const statusCode = getContactStatusCode(c);
      return isActiveStatus(statusCode);
    });

    const totalActive = activeContacts.length;
    const avgWaitDays = totalActive > 0
      ? Math.round(activeContacts.reduce((sum, c) => sum + (c.daysOnWaitlist || 0), 0) / totalActive)
      : 0;
    const over60Days = activeContacts.filter(c => (c.daysOnWaitlist || 0) >= 60).length;
    const readyToSchedule = contacts.filter(c => getContactStatusCode(c) === 200).length;

    return { totalActive, avgWaitDays, over60Days, readyToSchedule };
  }, [contacts]);

  // Use frontend-computed metrics exclusively when we have contacts
  // Only fall back to summary for display when contacts are unavailable
  const metrics = useMemo(() => {
    // If we have contacts, use frontend-computed metrics (source of truth)
    if (contacts && contacts.length > 0) {
      return computedMetrics;
    }
    // No contacts loaded yet - use summary if available
    const summary = summaryData;
    return {
      totalActive: summary?.totalActive ?? 0,
      avgWaitDays: summary?.avgWaitDays ?? 0,
      over60Days: summary?.over60Days ?? 0,
      readyToSchedule: summary?.readyToSchedule ?? 0,
    };
  }, [computedMetrics, summaryData, contacts]);

  // Priority queues based on status codes
  const priorityQueues = useMemo(() => {
    if (!contacts || contacts.length === 0) {
      return { over60Days: [], readyToSchedule: [], needsFollowUp: [] };
    }

    const over60Days = contacts.filter(c => {
      const statusCode = getContactStatusCode(c);
      return (c.daysOnWaitlist || 0) >= 60 && isActiveStatus(statusCode);
    });

    const readyToSchedule = contacts.filter(c => {
      const statusCode = getContactStatusCode(c);
      return STATUS_GROUPS.ready_to_schedule.includes(statusCode as 200);
    });

    const needsFollowUp = contacts.filter(c => {
      const statusCode = getContactStatusCode(c);
      const days = c.daysOnWaitlist || 0;
      const isWaiting = (STATUS_GROUPS.waiting as readonly number[]).includes(statusCode);
      return isWaiting && days > 14 && days <= 60;
    });

    return { over60Days, readyToSchedule, needsFollowUp };
  }, [contacts]);

  // Find longest waiting for AI insight
  const longestWaiting = useMemo(() => {
    if (!contacts || contacts.length === 0) return null;
    const activeContacts = contacts.filter(c => isActiveStatus(getContactStatusCode(c)));
    if (activeContacts.length === 0) return null;
    return activeContacts.reduce((longest, current) => 
      (current.daysOnWaitlist || 0) > (longest?.daysOnWaitlist || 0) ? current : longest
    , activeContacts[0]);
  }, [contacts]);

  if (isLoading) {
    return (
      <PageLayout>
        <LoadingState message="Loading dashboard..." />
      </PageLayout>
    );
  }

  if (error || (!summaryData && contacts.length === 0)) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-muted-foreground">Failed to load dashboard data</p>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <FallbackBanner show={isFallback} />
      <div className="space-y-8">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground" data-testid="text-page-title">Today</h1>
            <p className="text-sm text-muted-foreground mt-1" data-testid="text-page-subtitle">
              What needs your attention right now
            </p>
          </div>
          <SyncStatus 
            lastSyncTime={lastSyncTime} 
            onRefresh={handleRefresh}
            isRefreshing={isRefreshing}
          />
        </div>

        {/* Metrics Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard
            label="Active Waitlist"
            value={safeNumber(metrics.totalActive)}
          />
          <MetricCard
            label="Avg Wait Time"
            value={metrics.avgWaitDays > 0 ? `${metrics.avgWaitDays}d` : "---"}
            variant="warning"
          />
          <MetricCard
            label="Over 60 Days"
            value={safeNumber(metrics.over60Days)}
            variant="danger"
          />
          <MetricCard
            label="Ready to Schedule"
            value={safeNumber(metrics.readyToSchedule)}
            variant="success"
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
          {/* Priority Queues */}
          <div className="xl:col-span-3 grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Over 60 Days */}
            <Card className="overflow-visible">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                  Over 60 Days
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ScrollArea className="h-[320px] pr-2">
                  <div className="space-y-2">
                    {priorityQueues.over60Days.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No urgent contacts
                      </p>
                    ) : (
                      priorityQueues.over60Days.map((contact) => (
                        <PriorityCard
                          key={contact.name}
                          contact={contact}
                          priority="high"
                        />
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Ready to Schedule */}
            <Card className="overflow-visible">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <CalendarCheck className="h-4 w-4 text-amber-500" />
                  Ready to Schedule
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ScrollArea className="h-[320px] pr-2">
                  <div className="space-y-2">
                    {priorityQueues.readyToSchedule.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No contacts ready
                      </p>
                    ) : (
                      priorityQueues.readyToSchedule.map((contact) => (
                        <PriorityCard
                          key={contact.name}
                          contact={contact}
                          priority="medium"
                        />
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Needs Follow-up */}
            <Card className="overflow-visible">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-medium">
                  <Clock className="h-4 w-4 text-blue-500" />
                  Needs Follow-up
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ScrollArea className="h-[320px] pr-2">
                  <div className="space-y-2">
                    {priorityQueues.needsFollowUp.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        All caught up
                      </p>
                    ) : (
                      priorityQueues.needsFollowUp.map((contact) => (
                        <PriorityCard
                          key={contact.name}
                          contact={contact}
                          priority="standard"
                        />
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* AI Suggestions Panel */}
          <div className="xl:col-span-1 space-y-4">
            <AIInsightPanel
              insight={longestWaiting 
                ? `${longestWaiting.name} has been waiting ${longestWaiting.daysOnWaitlist || 0} days for ${longestWaiting.serviceRequested || "services"}. This may indicate a provider availability issue or specific service requirements.`
                : "No contacts currently waiting."}
              suggestedAction="Review provider availability or consider telehealth options."
              actionLabel="View Profile"
            />
            <AIInsightPanel
              insight={`${priorityQueues.over60Days.length} contacts have been waiting over 60 days. Consider reaching out to offer alternative service options.`}
              suggestedAction="Send batch follow-up emails to long-waiting contacts."
              actionLabel="Draft Emails"
            />
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
