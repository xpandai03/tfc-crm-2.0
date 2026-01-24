import { useQuery } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { MetricCard } from "@/components/ui/metric-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageLoader } from "@/components/ui/page-loader";
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
 * Insurance normalization mapping (raw values → canonical categories)
 * Based on Dawn's insurance categorization document
 * Maps multiple raw variants to a single canonical category
 */
const INSURANCE_NORMALIZATION_MAP: Record<string, string> = {
  // 1. VACCN
  "vaccn": "VACCN",
  "va": "VACCN",
  
  // 2. Presbyterian Commercial
  "presbyterian": "Presbyterian Commercial",
  "magellan": "Presbyterian Commercial",
  "presbyterian aps": "Presbyterian Commercial",
  "pres commercial": "Presbyterian Commercial",
  "pres": "Presbyterian Commercial",
  "presbyterian health plan": "Presbyterian Commercial",
  
  // 3. BlueCross BlueShield Commercial
  "bcbs of nm": "BlueCross BlueShield Commercial",
  "bcbs": "BlueCross BlueShield Commercial",
  "blue cross blue shield": "BlueCross BlueShield Commercial",
  "bcbs comm": "BlueCross BlueShield Commercial",
  "highmark blue cross blue shield": "BlueCross BlueShield Commercial",
  "bluegrass blueshield": "BlueCross BlueShield Commercial",
  "bcbs of new mexico": "BlueCross BlueShield Commercial",
  "bluecross blueshield of new mexico": "BlueCross BlueShield Commercial",
  "blue cross blue sheild": "BlueCross BlueShield Commercial", // typo handling
  "blue cross": "BlueCross BlueShield Commercial",
  "blue cross blueshield": "BlueCross BlueShield Commercial",
  "blue cross blue shield of minnesota": "BlueCross BlueShield Commercial",
  "blue cross blue shield nm": "BlueCross BlueShield Commercial",
  "bcbs of texas": "BlueCross BlueShield Commercial",
  "blue cross blue shield fep": "BlueCross BlueShield Commercial",
  "bcbsnm": "BlueCross BlueShield Commercial",
  "bcbs nm": "BlueCross BlueShield Commercial",
  
  // 4. Tricare
  "tricare": "Tricare",
  "tricare west": "Tricare",
  "tricare select": "Tricare",
  "tricare west prime": "Tricare",
  "tri care": "Tricare",
  "triwest": "Tricare",
  "tricare prime or triwest": "Tricare",
  
  // 5. Presbyterian Turquoise Care
  "pres tc": "Presbyterian Turquoise Care",
  "presbyterian - turquoise care": "Presbyterian Turquoise Care",
  "pres turquoise": "Presbyterian Turquoise Care",
  "presbyterian turquoise care": "Presbyterian Turquoise Care",
  "presbyterian turquoise": "Presbyterian Turquoise Care",
  "magellan turquoise care": "Presbyterian Turquoise Care",
  "pres cent - turquoise": "Presbyterian Turquoise Care",
  "turquoise care presbyterian": "Presbyterian Turquoise Care",
  "truq care presbyterian health plan": "Presbyterian Turquoise Care",
  "presbyterian centennial": "Presbyterian Turquoise Care",
  
  // 6. BlueCross BlueShield Turquoise Care
  "bcbs cent": "BlueCross BlueShield Turquoise Care",
  "bcbs - turquoise care": "BlueCross BlueShield Turquoise Care",
  "bcbs turquoise care": "BlueCross BlueShield Turquoise Care",
  "blue cross blue shield - turquoise care": "BlueCross BlueShield Turquoise Care",
  "blue cross blue shield turquoise": "BlueCross BlueShield Turquoise Care",
  "bcbs tc": "BlueCross BlueShield Turquoise Care",
  "bcbs centenial": "BlueCross BlueShield Turquoise Care", // typo handling
  "bcbs turquioise": "BlueCross BlueShield Turquoise Care", // typo handling
  
  // 7. United Healthcare
  "united healthcare": "United Healthcare",
  "uhc": "United Healthcare",
  "united healrhcare": "United Healthcare", // typo handling
  
  // 8. Aetna
  "atena": "Aetna", // typo handling
  "aetna": "Aetna",
  
  // 9. Medicare
  "medicare": "Medicare",
  "blue cross blue shield medicare": "Medicare",
  "uhc medicare": "Medicare",
  "bcbs medicare advantage": "Medicare",
  
  // 10. UMR
  "umr": "UMR",
  "umr - secondy medicaid -": "UMR",
  
  // 11. Molina
  "molina": "Molina",
  
  // 12. Medicaid
  "turquoise care native american": "Medicaid",
  "medicaid": "Medicaid",
  
  // 13. Self-Pay
  "self-pay": "Self-Pay",
  
  // 14. ComPsych
  "compsych": "ComPsych",
  
  // 15. Need to remove as we do not accept insurance
  "healthscope benifits quantum health": "Need to remove as we do not accept insurance",
  "lisa hale": "Need to remove as we do not accept insurance",
  "humana medicare": "Need to remove as we do not accept insurance",
  "medicare amb": "Need to remove as we do not accept insurance",
};

/**
 * Modality normalization mapping (raw values → canonical categories)
 */
const MODALITY_NORMALIZATION_MAP: Record<string, string> = {
  "th": "Telehealth",
  "telehealth": "Telehealth",
};

/**
 * Normalize insurance payer name to canonical category
 * Pure function: no side effects, deterministic
 * Returns "Unknown" for unmapped values
 */
function normalizeInsurance(rawValue: string | null | undefined): string {
  if (!rawValue) return "Unknown";
  const trimmed = rawValue.trim();
  if (!trimmed) return "Unknown";
  const normalized = trimmed.toLowerCase();
  return INSURANCE_NORMALIZATION_MAP[normalized] || "Unknown";
}

/**
 * Normalize modality to canonical category
 * Pure function: no side effects, deterministic
 * Returns "Unknown" for unmapped values
 */
function normalizeModality(rawValue: string | null | undefined): string {
  if (!rawValue) return "Unknown";
  const trimmed = rawValue.trim();
  if (!trimmed) return "Unknown";
  const normalized = trimmed.toLowerCase();
  return MODALITY_NORMALIZATION_MAP[normalized] || "Unknown";
}

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
  const { updateSummarySource, updateContactsSource, updateSyncTime, lastSyncTime, dataMode, summarySource, contactsSource, isContactsLive, isFullyLive } = useDataSource();
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // Check data sources for honest indicators
  // Only show as live when user has explicitly enabled live mode AND data is actually live
  const isSummaryLive = dataMode === "live" && summarySource === "live";
  const isDataFullyLive = dataMode === "live" && isFullyLive;

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
        insuranceTypes: {} as Record<string, number>,
        modalityTypes: {} as Record<string, number>,
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

    // Insurance type distribution (active only)
    // Normalize raw insurance values to canonical categories before aggregation
    const insuranceTypes: Record<string, number> = {};
    for (const c of activeContacts) {
      const normalizedInsurance = normalizeInsurance(c.insurancePayer);
      insuranceTypes[normalizedInsurance] = (insuranceTypes[normalizedInsurance] || 0) + 1;
    }

    // Modality type distribution (active only)
    // Normalize raw modality values to canonical categories before aggregation
    const modalityTypes: Record<string, number> = {};
    for (const c of activeContacts) {
      const normalizedModality = normalizeModality(c.modality);
      modalityTypes[normalizedModality] = (modalityTypes[normalizedModality] || 0) + 1;
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
      insuranceTypes,
      modalityTypes,
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
        <PageLoader context="insights" />
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

  // Sort insurance types by count
  const sortedInsuranceTypes = Object.entries(computedMetrics.insuranceTypes).sort((a, b) => b[1] - a[1]);

  // Sort modality types by count
  const sortedModalityTypes = Object.entries(computedMetrics.modalityTypes).sort((a, b) => b[1] - a[1]);

  return (
    <PageLayout>
      <FallbackBanner 
        show={!isDataFullyLive} 
        message={
          dataMode === "mock"
            ? "Viewing demo data"
            : isSummaryLive && !isContactsLive 
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
                    <div className="h-2 bg-muted/50 backdrop-blur-sm rounded-full overflow-hidden border border-white/20 dark:border-gray-700/30">
                      <div
                        className="h-full bg-gradient-to-r from-primary via-primary/90 to-primary rounded-full transition-all duration-500 backdrop-blur-sm shadow-md hover:shadow-lg"
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
                      className="flex items-center justify-between p-3 rounded-lg bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border border-white/40 dark:border-gray-700/40 shadow-md transition-all duration-300 hover:scale-[1.02] hover:shadow-lg hover:bg-white/90 dark:hover:bg-gray-800/90"
                    >
                      <span className="text-sm font-medium text-foreground">
                        {service}
                      </span>
                      <Badge variant="secondary" className="backdrop-blur-sm border-white/40 dark:border-gray-700/40 shadow-md">{count}</Badge>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Insurance Types */}
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle className="text-base font-medium">By Insurance Type</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {sortedInsuranceTypes.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No insurance data available</p>
                ) : (
                  sortedInsuranceTypes.map(([insurance, count]) => (
                    <div
                      key={insurance}
                      className="flex items-center justify-between p-3 rounded-lg bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border border-white/40 dark:border-gray-700/40 shadow-md transition-all duration-300 hover:scale-[1.02] hover:shadow-lg hover:bg-white/90 dark:hover:bg-gray-800/90"
                    >
                      <span className="text-sm font-medium text-foreground">
                        {insurance}
                      </span>
                      <Badge variant="secondary" className="backdrop-blur-sm border-white/40 dark:border-gray-700/40 shadow-md">{count}</Badge>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Modality Types */}
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle className="text-base font-medium">By Modality / Location</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {sortedModalityTypes.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No modality data available</p>
                ) : (
                  sortedModalityTypes.map(([modality, count]) => (
                    <div
                      key={modality}
                      className="flex items-center justify-between p-3 rounded-lg bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border border-white/40 dark:border-gray-700/40 shadow-md transition-all duration-300 hover:scale-[1.02] hover:shadow-lg hover:bg-white/90 dark:hover:bg-gray-800/90"
                    >
                      <span className="text-sm font-medium text-foreground">
                        {modality}
                      </span>
                      <Badge variant="secondary" className="backdrop-blur-sm border-white/40 dark:border-gray-700/40 shadow-md">{count}</Badge>
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
                <div className="flex items-center justify-between p-3 rounded-lg border border-red-500/30 dark:border-red-500/20 bg-red-500/20 dark:bg-red-500/10 backdrop-blur-md shadow-lg shadow-red-500/10 bg-gradient-to-br from-red-500/10 to-transparent relative before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-red-500 before:via-red-400 before:to-red-600 before:rounded-l-lg">
                  <div>
                    <p className="text-sm font-medium text-foreground">Over 60 Days</p>
                    <p className="text-xs text-muted-foreground">Critical attention needed</p>
                  </div>
                  <span className="text-2xl font-bold text-red-600 dark:text-red-400 backdrop-blur-sm bg-white/40 dark:bg-gray-900/40 px-3 py-1 rounded-lg shadow-md" data-testid="text-over-60-days">
                    {safeNumber(metrics.over60Days)}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-amber-500/30 dark:border-amber-500/20 bg-amber-500/20 dark:bg-amber-500/10 backdrop-blur-md shadow-lg shadow-amber-500/10 bg-gradient-to-br from-amber-500/10 to-transparent relative before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-amber-500 before:via-amber-400 before:to-amber-600 before:rounded-l-lg">
                  <div>
                    <p className="text-sm font-medium text-foreground">Over 30 Days</p>
                    <p className="text-xs text-muted-foreground">Requires follow-up</p>
                  </div>
                  <span className="text-2xl font-bold text-amber-600 dark:text-amber-400 backdrop-blur-sm bg-white/40 dark:bg-gray-900/40 px-3 py-1 rounded-lg shadow-md" data-testid="text-over-30-days">
                    {safeNumber(metrics.over30Days)}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-green-500/30 dark:border-green-500/20 bg-green-500/20 dark:bg-green-500/10 backdrop-blur-md shadow-lg shadow-green-500/10 bg-gradient-to-br from-green-500/10 to-transparent relative before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-green-500 before:via-green-400 before:to-green-600 before:rounded-l-lg">
                  <div>
                    <p className="text-sm font-medium text-foreground">Under 30 Days</p>
                    <p className="text-xs text-muted-foreground">On track</p>
                  </div>
                  <span className="text-2xl font-bold text-green-600 dark:text-green-400 backdrop-blur-sm bg-white/40 dark:bg-gray-900/40 px-3 py-1 rounded-lg shadow-md" data-testid="text-under-30-days">
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
              <div className="p-4 rounded-lg relative bg-red-500/20 dark:bg-red-500/10 backdrop-blur-md border border-red-500/30 dark:border-red-500/20 shadow-lg shadow-red-500/10 bg-gradient-to-br from-red-500/10 to-transparent before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-red-500 before:via-red-400 before:to-red-600 before:rounded-l-lg">
                <p className="text-sm text-muted-foreground mb-1">Longest Waiting</p>
                <p className="text-lg font-semibold text-foreground mb-2" data-testid="text-longest-waiting">
                  {safeString(metrics.longestWaitingName)}
                </p>
                <div className="flex items-center gap-2">
                  {metrics.longestWaitDays > 0 ? (
                    <>
                      <Badge variant="destructive" className="backdrop-blur-sm border-white/40 dark:border-gray-700/40 shadow-md">{metrics.longestWaitDays} days</Badge>
                      <span className="text-xs text-muted-foreground">on waitlist</span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">No waiting contacts</span>
                  )}
                </div>
              </div>

              <div className="mt-4 p-4 rounded-lg bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border border-white/40 dark:border-gray-700/40 shadow-md">
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
