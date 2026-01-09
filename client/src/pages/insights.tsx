import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
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
import type { WaitlistSummary, WaitlistContact } from "@shared/schema";

export default function Insights() {
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

  const summary = summaryData;
  const contacts = contactsData?.contacts;

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

  if (isLoading) {
    return (
      <PageLayout>
        <LoadingState message="Loading insights..." />
      </PageLayout>
    );
  }

  if (error || !summary || !contacts) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-muted-foreground">Failed to load insights data</p>
        </div>
      </PageLayout>
    );
  }

  // Calculate service type distribution
  const serviceTypes = contacts.reduce((acc, c) => {
    if (c.status !== "closed") {
      acc[c.serviceRequested] = (acc[c.serviceRequested] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  const sortedServiceTypes = Object.entries(serviceTypes).sort((a, b) => b[1] - a[1]);

  // Status distribution for bar chart
  const statusLabels: Record<string, string> = {
    intake: "Intake",
    waiting: "Waiting",
    ready_to_schedule: "Ready",
    scheduled: "Scheduled",
    on_hold: "On Hold",
    closed: "Closed",
  };

  const maxStatusCount = Math.max(...Object.values(summary.byStatus));

  return (
    <PageLayout>
      <FallbackBanner show={isFallback} />
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
            value={summary.totalActive}
          />
          <MetricCard
            label="Average Wait"
            value={`${summary.avgWaitDays} days`}
            variant="warning"
          />
          <MetricCard
            label="Longest Wait"
            value={`${summary.longestWaitDays} days`}
            variant="danger"
          />
          <MetricCard
            label="Ready to Schedule"
            value={summary.readyToSchedule}
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
                {Object.entries(summary.byStatus).map(([status, count]) => (
                  <div key={status} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        {statusLabels[status] || status}
                      </span>
                      <span className="font-medium text-foreground">{count}</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-500"
                        style={{ width: `${(count / maxStatusCount) * 100}%` }}
                        data-testid={`bar-${status}`}
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
                {sortedServiceTypes.map(([service, count]) => (
                  <div
                    key={service}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                  >
                    <span className="text-sm font-medium text-foreground">
                      {service}
                    </span>
                    <Badge variant="secondary">{count}</Badge>
                  </div>
                ))}
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
                    {summary.over60Days}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/30">
                  <div>
                    <p className="text-sm font-medium text-foreground">Over 30 Days</p>
                    <p className="text-xs text-muted-foreground">Requires follow-up</p>
                  </div>
                  <span className="text-2xl font-bold text-amber-600 dark:text-amber-400" data-testid="text-over-30-days">
                    {summary.over30Days}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/30">
                  <div>
                    <p className="text-sm font-medium text-foreground">Under 30 Days</p>
                    <p className="text-xs text-muted-foreground">On track</p>
                  </div>
                  <span className="text-2xl font-bold text-green-600 dark:text-green-400" data-testid="text-under-30-days">
                    {summary.totalActive - summary.over30Days}
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
                  {summary.longestWaitingName}
                </p>
                <div className="flex items-center gap-2">
                  <Badge variant="destructive">{summary.longestWaitDays} days</Badge>
                  <span className="text-xs text-muted-foreground">on waitlist</span>
                </div>
              </div>

              <div className="mt-4 p-4 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground mb-1">Needs Follow-up</p>
                <p className="text-3xl font-bold text-foreground" data-testid="metric-needs-followup">
                  {summary.needsFollowUp}
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
