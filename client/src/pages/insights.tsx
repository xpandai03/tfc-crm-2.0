import { useQuery } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { MetricCard } from "@/components/ui/metric-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-spinner";
import { SyncStatus } from "@/components/ui/sync-status";
import { FallbackBanner } from "@/components/ui/fallback-banner";
import { Download, AlertCircle } from "lucide-react";
import { getWaitlistSummary, getWaitlistContacts, type WithSource } from "@/lib/api";
import { useDataSource } from "@/lib/data-source-context";
import { 
  isActiveStatus, 
  getColumnForStatus, 
  stringStatusToCode, 
  getStatusLabel,
  safeNumber,
  safeString,
  PIPELINE_COLUMNS,
} from "@/lib/status-config";
import type { WaitlistSummary, WaitlistContact } from "@shared/schema";

/**
 * Insights Page
 * 
 * Metrics are computed from live contact data:
 * - Active Waitlist: contacts NOT in declined (103, 204) or inactive (104, 400)
 * - Over 60 Days: daysOnWaitlist >= 60 AND active
 * - Ready to Schedule: statusCode in [200]
 * - Avg Wait Time: average of daysOnWaitlist across active waitlist only
 */
export default function Insights() {
  const { updateSummarySource, updateContactsSource, updateSyncTime, lastSyncTime, summarySource, contactsSource, isContactsLive } = useDataSource();
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // Check data sources for honest indicators
  const isSummaryLive = summarySource === "live";
  const isFullyLive = isSummaryLive && isContactsLive;

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
      updateSummarySource(summaryData._source as "mock" | "live" | "fallback");
      updateSyncTime();
    }
  }, [summaryData, updateSummarySource, updateSyncTime]);

  useEffect(() => {
    if (contactsData?._source) {
      updateContactsSource(contactsData._source as "mock" | "live" | "fallback");
    }
  }, [contactsData, updateContactsSource]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([refetchSummary(), refetchContacts()]);
    setIsRefreshing(false);
  };

  // Get the effective status code for a contact (handles both live and mock data)
  const getContactStatusCode = (contact: WaitlistContact): number => {
    return contact.statusCode ?? stringStatusToCode(contact.status);
  };

  // Compute metrics from contacts data (frontend-computed for live data safety)
  const computedMetrics = useMemo(() => {
    if (!contacts || contacts.length === 0) {
      return {
        totalActive: 0,
        avgWaitDays: 0,
        longestWaitDays: 0,
        longestWaitingName: "---",
        over30Days: 0,
        over60Days: 0,
        readyToSchedule: 0,
        needsFollowUp: 0,
        statusDistribution: {} as Record<string, number>,
        serviceTypes: {} as Record<string, number>,
      };
    }

    // Filter to active contacts only
    const activeContacts = contacts.filter(c => {
      const statusCode = getContactStatusCode(c);
      return isActiveStatus(statusCode);
    });

    // Calculate metrics from active contacts
    const totalActive = activeContacts.length;
    
    // Average wait time (only active contacts)
    const avgWaitDays = totalActive > 0
      ? Math.round(activeContacts.reduce((sum, c) => sum + (c.daysOnWaitlist || 0), 0) / totalActive)
      : 0;

    // Longest wait
    let longestWaitDays = 0;
    let longestWaitingName = "---";
    for (const c of activeContacts) {
      if ((c.daysOnWaitlist || 0) > longestWaitDays) {
        longestWaitDays = c.daysOnWaitlist || 0;
        longestWaitingName = c.name;
      }
    }

    // Over 30/60 days (active only)
    const over30Days = activeContacts.filter(c => (c.daysOnWaitlist || 0) >= 30).length;
    const over60Days = activeContacts.filter(c => (c.daysOnWaitlist || 0) >= 60).length;

    // Ready to schedule (statusCode 200)
    const readyToSchedule = contacts.filter(c => getContactStatusCode(c) === 200).length;

    // Needs follow-up (waiting status codes: 101, 102)
    const needsFollowUp = contacts.filter(c => {
      const code = getContactStatusCode(c);
      return code === 101 || code === 102;
    }).length;

    // Status distribution by column
    const statusDistribution: Record<string, number> = {};
    for (const column of PIPELINE_COLUMNS) {
      statusDistribution[column.id] = contacts.filter(c => {
        const statusCode = getContactStatusCode(c);
        return getColumnForStatus(statusCode) === column.id;
      }).length;
    }

    // Service type distribution (active only)
    const serviceTypes: Record<string, number> = {};
    for (const c of activeContacts) {
      const service = c.serviceRequested || "Unknown";
      serviceTypes[service] = (serviceTypes[service] || 0) + 1;
    }

    return {
      totalActive,
      avgWaitDays,
      longestWaitDays,
      longestWaitingName,
      over30Days,
      over60Days,
      readyToSchedule,
      needsFollowUp,
      statusDistribution,
      serviceTypes,
    };
  }, [contacts]);

  // Use frontend-computed metrics exclusively when we have contacts
  // Only fall back to summary for display when contacts are unavailable
  const metrics = useMemo(() => {
    // If we have contacts, use frontend-computed metrics (source of truth)
    if (contacts && contacts.length > 0) {
      return {
        totalActive: computedMetrics.totalActive,
        avgWaitDays: computedMetrics.avgWaitDays,
        longestWaitDays: computedMetrics.longestWaitDays,
        longestWaitingName: computedMetrics.longestWaitingName,
        over30Days: computedMetrics.over30Days,
        over60Days: computedMetrics.over60Days,
        readyToSchedule: computedMetrics.readyToSchedule,
        needsFollowUp: computedMetrics.needsFollowUp,
      };
    }
    // No contacts loaded yet - use summary if available
    const summary = summaryData;
    return {
      totalActive: summary?.totalActive ?? 0,
      avgWaitDays: summary?.avgWaitDays ?? 0,
      longestWaitDays: summary?.longestWaitDays ?? 0,
      longestWaitingName: summary?.longestWaitingName ?? "---",
      over30Days: summary?.over30Days ?? 0,
      over60Days: summary?.over60Days ?? 0,
      readyToSchedule: summary?.readyToSchedule ?? 0,
      needsFollowUp: summary?.needsFollowUp ?? 0,
    };
  }, [computedMetrics, summaryData, contacts]);

  if (isLoading) {
    return (
      <PageLayout>
        <LoadingState message="Loading insights..." />
      </PageLayout>
    );
  }

  // Safe early return for no data
  if (error || (!summaryData && contacts.length === 0)) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-muted-foreground">Failed to load insights data</p>
        </div>
      </PageLayout>
    );
  }

  // Empty state
  if (metrics.totalActive === 0 && contacts.length === 0) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <p className="text-lg font-medium text-foreground">No Waitlist Data</p>
          <p className="text-sm text-muted-foreground">There are no contacts on the waitlist yet.</p>
        </div>
      </PageLayout>
    );
  }

  // Column labels for display
  const columnLabels: Record<string, string> = {};
  for (const col of PIPELINE_COLUMNS) {
    columnLabels[col.id] = col.label;
  }

  // Get max for status distribution bar chart
  const statusValues = Object.values(computedMetrics.statusDistribution);
  const maxStatusCount = statusValues.length > 0 ? Math.max(...statusValues) : 1;

  // Sort service types by count
  const sortedServiceTypes = Object.entries(computedMetrics.serviceTypes).sort((a, b) => b[1] - a[1]);

  return (
    <PageLayout>
      <FallbackBanner 
        show={!isFullyLive} 
        message={
          isSummaryLive && !isContactsLive 
            ? "Aggregate metrics are live — contact-level data is demo"
            : summarySource === "fallback" 
              ? "Live data temporarily unavailable — showing cached data"
              : "Viewing demo data"
        }
        variant="info"
      />
      <div className="space-y-8">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground" data-testid="text-page-title">Insights</h1>
            <p className="text-sm text-muted-foreground mt-1" data-testid="text-page-subtitle">
              Waitlist analytics and trends
            </p>
          </div>
          <div className="flex gap-2">
            <SyncStatus 
              lastSyncTime={lastSyncTime} 
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
            />
            <Button variant="outline" size="sm" data-testid="button-export">
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          </div>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard
            label="Total Active"
            value={safeNumber(metrics.totalActive)}
          />
          <MetricCard
            label="Average Wait"
            value={metrics.avgWaitDays > 0 ? `${metrics.avgWaitDays} days` : "---"}
            variant="warning"
          />
          <MetricCard
            label="Longest Wait"
            value={metrics.longestWaitDays > 0 ? `${metrics.longestWaitDays} days` : "---"}
            variant="danger"
          />
          <MetricCard
            label="Ready to Schedule"
            value={safeNumber(metrics.readyToSchedule)}
            variant="success"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Status Distribution */}
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle className="text-base font-medium">Status Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {Object.entries(computedMetrics.statusDistribution).map(([columnId, count]) => (
                  <div key={columnId} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        {columnLabels[columnId] || columnId}
                      </span>
                      <span className="font-medium text-foreground">{count}</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-500"
                        style={{ width: `${maxStatusCount > 0 ? (count / maxStatusCount) * 100 : 0}%` }}
                        data-testid={`bar-${columnId}`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Service Types */}
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle className="text-base font-medium">By Service Type</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {sortedServiceTypes.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No service data available</p>
                ) : (
                  sortedServiceTypes.map(([service, count]) => (
                    <div
                      key={service}
                      className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                    >
                      <span className="text-sm font-medium text-foreground">
                        {service}
                      </span>
                      <Badge variant="secondary">{count}</Badge>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Wait Time Analysis */}
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle className="text-base font-medium">Wait Time Analysis</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 rounded-lg border border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/30">
                  <div>
                    <p className="text-sm font-medium text-foreground">Over 60 Days</p>
                    <p className="text-xs text-muted-foreground">Critical attention needed</p>
                  </div>
                  <span className="text-2xl font-bold text-red-600 dark:text-red-400" data-testid="text-over-60-days">
                    {safeNumber(metrics.over60Days)}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/30">
                  <div>
                    <p className="text-sm font-medium text-foreground">Over 30 Days</p>
                    <p className="text-xs text-muted-foreground">Requires follow-up</p>
                  </div>
                  <span className="text-2xl font-bold text-amber-600 dark:text-amber-400" data-testid="text-over-30-days">
                    {safeNumber(metrics.over30Days)}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/30">
                  <div>
                    <p className="text-sm font-medium text-foreground">Under 30 Days</p>
                    <p className="text-xs text-muted-foreground">On track</p>
                  </div>
                  <span className="text-2xl font-bold text-green-600 dark:text-green-400" data-testid="text-under-30-days">
                    {safeNumber(Math.max(0, metrics.totalActive - metrics.over30Days))}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Longest Waiting */}
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle className="text-base font-medium">Attention Required</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="p-4 rounded-lg border-l-4 border-l-red-500 bg-red-50/50 dark:bg-red-950/20">
                <p className="text-sm text-muted-foreground mb-1">Longest Waiting</p>
                <p className="text-lg font-semibold text-foreground mb-2" data-testid="text-longest-waiting">
                  {safeString(metrics.longestWaitingName)}
                </p>
                <div className="flex items-center gap-2">
                  {metrics.longestWaitDays > 0 ? (
                    <>
                      <Badge variant="destructive">{metrics.longestWaitDays} days</Badge>
                      <span className="text-xs text-muted-foreground">on waitlist</span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">No waiting contacts</span>
                  )}
                </div>
              </div>

              <div className="mt-4 p-4 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground mb-1">Needs Follow-up</p>
                <p className="text-3xl font-bold text-foreground" data-testid="metric-needs-followup">
                  {safeNumber(metrics.needsFollowUp)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  contacts waiting for response
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageLayout>
  );
}
