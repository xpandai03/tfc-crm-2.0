import { useQuery } from "@tanstack/react-query";
import { useState, useEffect, useMemo, useCallback } from "react";
import { PageLayout } from "@/components/layout/page-layout";
import { MetricCard } from "@/components/ui/metric-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageLoader } from "@/components/ui/page-loader";
import { FallbackBanner } from "@/components/ui/fallback-banner";
import { Download, AlertCircle, ChevronRight, Users, Hourglass } from "lucide-react";
import { useLocation } from "wouter";
import { getWaitlistSummary, getWaitlistContacts, type WithSource } from "@/lib/api";
import { computeDaysWaiting } from "@/lib/days-waiting";
import { useDataSource, type DataSource } from "@/lib/data-source-context";
import { normalizeInsurance } from "@/lib/insurance-utils";
import { useAuth } from "@/lib/auth-context";
import { isRestrictedUser } from "@shared/access-control";
import { Redirect } from "wouter";
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
import { bucketReason } from "@shared/reason-canonicals";

/**
 * Modality normalization mapping (raw values → canonical categories)
 * Maps form options and historical values to display categories
 *
 * TODO: consolidate this map with waitlist-list-view.tsx — the two copies
 * have drifted independently in the past. See follow-up PR (D-C2 from
 * insights cleanup audit).
 */
const MODALITY_NORMALIZATION_MAP: Record<string, string> = {
  // Hybrid
  "hybrid": "Hybrid",
  "hybrid - ll": "Hybrid",

  // In Person - Albuquerque (ABQ)
  "in person - albuquerque": "In Person ABQ",
  "in person-abq": "In Person ABQ",
  "in person abq": "In Person ABQ",
  "in person- albuquerque": "In Person ABQ",
  "in person - abq": "In Person ABQ",
  "abq": "In Person ABQ",
  "albuquerque": "In Person ABQ",

  // In Person - Rio Rancho (RR)
  "in person - rio rancho": "In Person RR",
  "in person-rio rancho": "In Person RR",
  "in person- rio rancho": "In Person RR",
  "in person - rr": "In Person RR",
  "in person rr": "In Person RR",
  "rio rancho": "In Person RR",

  // In Person - Los Lunas (LL) — split out from generic "In Person" per
  // Insights cleanup Bucket C. Previously rolled into the generic bucket
  // which hid ~118 LL contacts from Amanda's modality breakdown.
  "in person - los lunas": "In Person LL",
  "in person- los lunas": "In Person LL",
  "in person los lunas": "In Person LL",
  "in-person los lunas": "In Person LL",
  "in person ll": "In Person LL",
  "los lunas": "In Person LL",
  "ll": "In Person LL",

  // In Person (generic - combined options, and old values without location)
  "in person": "In Person",
  "in person - albuquerque or rio rancho": "In Person",
  "in person- albuquerque or rio rancho": "In Person",
  "in-person": "In Person",

  // Telehealth
  "telehealth": "Telehealth",
  "th": "Telehealth",
  "tele-health": "Telehealth",
  "tele health": "Telehealth",

  // Flexible/Flex
  "flexible (open to any option)": "Flex",
  "flexible (open to any option).": "Flex",
  "flexible": "Flex",
  "flex": "Flex",
  "open to any option": "Flex",
};

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
  const { user } = useAuth();
  if (isRestrictedUser(user?.email)) return <Redirect to="/" />;

  const { updateSummarySource, updateContactsSource, updateSyncTime, summarySource, isFullyLive } = useDataSource();
  // Drill-down navigation handler - navigates to Waitlist List View with filter applied
  const handleDrillDown = useCallback(
    (filterType: "insurance" | "modality" | "umbrella" | "reason" | "serviceType", value: string) => {
      const encoded = encodeURIComponent(value);
      const targetUrl = `/waitlist?${filterType}=${encoded}`;
      console.log("[Insights] Drill-down clicked:", { filterType, value, targetUrl });
      // Use window.location for reliable navigation with query params
      window.location.href = targetUrl;
    },
    []
  );
  
  const isDataFullyLive = isFullyLive;

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

  const { data: staffData } = useQuery<{ staff: { user: string; count: number }[]; days: number }>({
    queryKey: ["/api/activity/staff-summary"],
    queryFn: async () => {
      const res = await fetch("/api/activity/staff-summary", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch staff activity");
      return res.json();
    },
  });

  // Time-in-status: aggregates across active codes + per-contact tenure list.
  // Endpoint returns durations in seconds; we round to days for display.
  // Inactive codes (103/104/203/204/205/400) are filtered out client-side
  // since the endpoint returns all codes for the contact-detail use case.
  type StatusDurationsResponse = {
    byContact: Array<{
      contactId: number;
      statusCode: number | null;
      timeInCurrentStatusSeconds: number | null;
    }>;
    byStatusCode: Array<{
      statusCode: number;
      countTotal: number;
      countWithData: number;
      avgSeconds: number | null;
      medianSeconds: number | null;
      p90Seconds: number | null;
    }>;
    generatedAt: string;
  };
  const { data: statusDurationsData } = useQuery<StatusDurationsResponse>({
    queryKey: ["/api/insights/status-durations"],
    queryFn: async () => {
      const res = await fetch("/api/insights/status-durations", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch status durations");
      return res.json();
    },
  });

  const [, setLocation] = useLocation();

  const isLoading = summaryLoading || contactsLoading;
  const error = summaryError || contactsError;

  const contacts = contactsData?.contacts || [];

  useEffect(() => {
    if (summaryData?._source) {
      updateSummarySource(summaryData._source as DataSource);
      updateSyncTime();
    }
  }, [summaryData, updateSummarySource, updateSyncTime]);

  useEffect(() => {
    if (contactsData?._source) {
      updateContactsSource(contactsData._source as DataSource);
    }
  }, [contactsData, updateContactsSource]);

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
        reasonTypes: {} as Record<string, number>,
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
      ? Math.round(activeContacts.reduce((sum, c) => sum + computeDaysWaiting(c.dateAdded, c.daysOnWaitlist), 0) / totalActive)
      : 0;

    // Longest wait
    let longestWaitDays = 0;
    let longestWaitingName = "---";
    for (const c of activeContacts) {
      const days = computeDaysWaiting(c.dateAdded, c.daysOnWaitlist);
      if (days > longestWaitDays) {
        longestWaitDays = days;
        longestWaitingName = c.name;
      }
    }

    // Over 30/60 days (active only)
    const over30Days = activeContacts.filter(c => computeDaysWaiting(c.dateAdded, c.daysOnWaitlist) >= 30).length;
    const over60Days = activeContacts.filter(c => computeDaysWaiting(c.dateAdded, c.daysOnWaitlist) >= 60).length;

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

    // Service type distribution (active only) — grouped by requestingFor (WHO), not reason (WHAT)
    const serviceTypes: Record<string, number> = {};
    for (const c of activeContacts) {
      const service = (c as any).requestingFor?.trim() || "Unknown";
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

    // Reason for therapy distribution (active only)
    // Each contact may have multiple reasons - count each individually.
    // Each token is bucketed via bucketReason() so post-migration "Other
    // (legacy free-text)" plus any future staff-form "Other: <free-text>"
    // entries roll into a single "Other" bucket on the chart.
    // Contacts without reasons go to "Not Collected (Older Intake)".
    const reasonTypes: Record<string, number> = {};
    const LEGACY_REASON_LABEL = "Not Collected (Older Intake)";
    for (const c of activeContacts) {
      const raw = c.reasonForTherapy;
      // reasonForTherapy may be a comma-separated string (from DB) or an array
      const reasons: string[] = Array.isArray(raw)
        ? raw
        : typeof raw === "string" && raw.trim()
          ? raw.split(",").map(r => r.trim()).filter(Boolean)
          : [];

      if (reasons.length > 0) {
        // Count each reason individually (a contact can have multiple).
        // Bucket through bucketReason() before dedupe so "Other: ..." and
        // "Other (legacy free-text)" merge into one count per contact.
        const seen = new Set<string>();
        for (const reason of reasons) {
          const bucketed = bucketReason(reason);
          if (!seen.has(bucketed)) {
            seen.add(bucketed);
            reasonTypes[bucketed] = (reasonTypes[bucketed] || 0) + 1;
          }
        }
      } else {
        // No reasons = legacy/older intake
        reasonTypes[LEGACY_REASON_LABEL] = (reasonTypes[LEGACY_REASON_LABEL] || 0) + 1;
      }
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
      reasonTypes,
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
  // Note: normalizeInsurance now returns "Unknown" for unrecognized/rejected values
  const sortedInsuranceTypes = Object.entries(computedMetrics.insuranceTypes)
    .sort((a, b) => b[1] - a[1]);

  // Sort modality types by count
  const sortedModalityTypes = Object.entries(computedMetrics.modalityTypes).sort((a, b) => b[1] - a[1]);

  // Sort reason types by count, but keep "Not Collected" at the end
  const sortedReasonTypes = Object.entries(computedMetrics.reasonTypes).sort((a, b) => {
    // Always put legacy bucket last
    if (a[0] === "Not Collected (Older Intake)") return 1;
    if (b[0] === "Not Collected (Older Intake)") return -1;
    return b[1] - a[1];
  });

  // Treat null OR zero seconds as "no measurable tenure". The endpoint contract
  // says null = "no logged event places this contact on its current status",
  // but in practice we also see a flood of 0-second readings (sub-86400-second
  // floors from very recent transitions, plus a suspected backend zero-vs-null
  // ambiguity). Both render identically as "no data" — better than letting
  // 0-day entries pull averages down or dominate "longest" rankings.
  const hasMeasurableDuration = (s: number | null | undefined): s is number =>
    s !== null && s !== undefined && s > 0;

  // Recompute per-code averages client-side from byContact so we can apply the
  // zero-exclusion rule. The server's byStatusCode.avgSeconds excludes nulls
  // but not zeros, so it can't be trusted here.
  const samplesByCode = new Map<number, number[]>();
  const totalsByCode = new Map<number, number>();
  for (const row of statusDurationsData?.byContact ?? []) {
    if (row.statusCode === null) continue;
    totalsByCode.set(row.statusCode, (totalsByCode.get(row.statusCode) ?? 0) + 1);
    if (!hasMeasurableDuration(row.timeInCurrentStatusSeconds)) continue;
    const arr = samplesByCode.get(row.statusCode) ?? [];
    arr.push(row.timeInCurrentStatusSeconds);
    samplesByCode.set(row.statusCode, arr);
  }
  const avgTimeByStatus: Array<{
    statusCode: number;
    label: string;
    avgDays: number;
    countWithData: number;
    countTotal: number;
  }> = [];
  samplesByCode.forEach((samples, statusCode) => {
    if (!isActiveStatus(statusCode)) return;
    const avgSeconds = samples.reduce((s, v) => s + v, 0) / samples.length;
    avgTimeByStatus.push({
      statusCode,
      label: getStatusLabel(statusCode),
      avgDays: Math.floor(avgSeconds / 86400),
      countWithData: samples.length,
      countTotal: totalsByCode.get(statusCode) ?? samples.length,
    });
  });
  avgTimeByStatus.sort((a, b) => b.avgDays - a.avgDays);
  const maxAvgDays = avgTimeByStatus.length > 0 ? Math.max(...avgTimeByStatus.map((a) => a.avgDays), 1) : 1;

  // Build a contactId → name lookup once so the "Longest in current status"
  // list can show names without an extra fetch.
  const contactNameById = new Map<number, string>();
  for (const c of contacts) {
    if (c.contactId !== undefined && c.contactId !== null) {
      contactNameById.set(c.contactId, c.name || "Unknown");
    }
  }
  const longestInCurrentStatus = (statusDurationsData?.byContact ?? [])
    .filter(
      (b) =>
        hasMeasurableDuration(b.timeInCurrentStatusSeconds) &&
        b.statusCode !== null &&
        isActiveStatus(b.statusCode),
    )
    .sort(
      (a, b) =>
        (b.timeInCurrentStatusSeconds as number) - (a.timeInCurrentStatusSeconds as number),
    )
    .slice(0, 10)
    .map((b) => ({
      contactId: b.contactId,
      name: contactNameById.get(b.contactId) || `#${b.contactId}`,
      statusLabel: getStatusLabel(b.statusCode),
      days: Math.floor((b.timeInCurrentStatusSeconds as number) / 86400),
    }));

  return (
    <PageLayout>
      {/* Only banner real fallback/error states. Mirrors the home.tsx
          fix in commit 960e1a6 — "Viewing demo data" was stale because
          the underlying data has been live production for a while. */}
      <FallbackBanner
        show={summarySource === "fallback"}
        message="Live data temporarily unavailable — please refresh in a moment"
        variant="warning"
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
            <Button
              variant="outline"
              size="sm"
              data-testid="button-export"
              onClick={async () => {
                try {
                  const res = await fetch("/api/export/insights.pdf", { credentials: "include" });
                  if (!res.ok) throw new Error("Export failed");
                  const blob = await res.blob();
                  const now = new Date();
                  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `insights-${ts}.pdf`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                } catch { /* silent fail — button click feedback is sufficient */ }
              }}
            >
              <Download className="h-4 w-4 mr-2" />
              Export PDF
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
                  <div 
                    key={columnId} 
                    className="group space-y-1.5 cursor-pointer rounded-lg p-2 -mx-2 transition-all duration-200 hover:bg-muted/30"
                    onClick={() => handleDrillDown("umbrella", columnId)}
                  >
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground group-hover:text-primary transition-colors">
                        {columnLabels[columnId] || columnId}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{count}</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
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

          {/* Avg Time per Status (active codes only) */}
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle className="text-base font-medium flex items-center gap-2">
                <Hourglass className="h-4 w-4" />
                Avg Time per Status
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Active statuses only · NULL contacts (no logged event) excluded
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {avgTimeByStatus.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No status duration data yet
                  </p>
                ) : (
                  avgTimeByStatus.map((row) => (
                    <div key={row.statusCode} className="space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{row.label}</span>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{row.avgDays} days</span>
                          <span className="text-xs text-muted-foreground">
                            ({row.countWithData}/{row.countTotal})
                          </span>
                        </div>
                      </div>
                      <div className="h-2 bg-muted/50 backdrop-blur-sm rounded-full overflow-hidden border border-white/20 dark:border-gray-700/30">
                        <div
                          className="h-full bg-gradient-to-r from-primary via-primary/90 to-primary rounded-full transition-all duration-500"
                          style={{ width: `${(row.avgDays / maxAvgDays) * 100}%` }}
                          data-testid={`bar-avg-status-${row.statusCode}`}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Longest in Current Status (active only, top 10, click to drill) */}
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle className="text-base font-medium">Longest in Current Status</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Top 10 active contacts by time-in-status · Click to view detail
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {longestInCurrentStatus.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No status duration data yet
                  </p>
                ) : (
                  longestInCurrentStatus.map((row) => (
                    <div
                      key={row.contactId}
                      onClick={() => setLocation(`/contact/${row.contactId}`)}
                      className="group flex items-center justify-between p-3 rounded-lg bg-white dark:bg-gray-800/90 border border-gray-200/60 dark:border-gray-700/40 shadow-sm transition-all duration-300 hover:scale-[1.02] hover:shadow-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer hover:border-primary/30"
                      data-testid={`row-longest-status-${row.contactId}`}
                    >
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors truncate">
                          {row.name}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          {row.statusLabel}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="secondary" className="shadow-sm">
                          {row.days} {row.days === 1 ? "day" : "days"}
                        </Badge>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>
                  ))
                )}
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
                      onClick={() => handleDrillDown("serviceType", service)}
                      className="group flex items-center justify-between p-3 rounded-lg bg-white dark:bg-gray-800/90 border border-gray-200/60 dark:border-gray-700/40 shadow-sm transition-all duration-300 hover:scale-[1.02] hover:shadow-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer hover:border-primary/30"
                    >
                      <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                        {service}
                      </span>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="shadow-sm">{count}</Badge>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
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
                      onClick={() => handleDrillDown("insurance", insurance)}
                      className="group flex items-center justify-between p-3 rounded-lg bg-white dark:bg-gray-800/90 border border-gray-200/60 dark:border-gray-700/40 shadow-sm transition-all duration-300 hover:scale-[1.02] hover:shadow-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer hover:border-primary/30"
                    >
                      <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                        {insurance}
                      </span>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="shadow-sm">{count}</Badge>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
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
                      onClick={() => handleDrillDown("modality", modality)}
                      className="group flex items-center justify-between p-3 rounded-lg bg-white dark:bg-gray-800/90 border border-gray-200/60 dark:border-gray-700/40 shadow-sm transition-all duration-300 hover:scale-[1.02] hover:shadow-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer hover:border-primary/30"
                    >
                      <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                        {modality}
                      </span>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="shadow-sm">{count}</Badge>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Reason for Therapy (was "Seeking Services" — renamed per Bucket A; field is reasonForTherapy MCQ) */}
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle className="text-base font-medium">By Reason for Therapy</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Contacts may have multiple reasons · Older intakes may not have this data
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {sortedReasonTypes.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No reason data available</p>
                ) : (
                  sortedReasonTypes.map(([reason, count]) => {
                    const isLegacy = reason === "Not Collected (Older Intake)";
                    return (
                      <div
                        key={reason}
                        onClick={isLegacy ? undefined : () => handleDrillDown("reason", reason)}
                        className={`flex items-center justify-between p-3 rounded-lg backdrop-blur-sm border shadow-md transition-all duration-300 ${
                          isLegacy
                            ? "bg-gray-100/80 dark:bg-gray-900/80 border-gray-300/40 dark:border-gray-600/40"
                            : "group bg-white/80 dark:bg-gray-800/80 border-white/40 dark:border-gray-700/40 hover:scale-[1.02] hover:shadow-lg hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-primary/30 cursor-pointer"
                        }`}
                      >
                        <span
                          className={`text-sm font-medium ${
                            isLegacy
                              ? "text-muted-foreground italic"
                              : "text-foreground group-hover:text-primary transition-colors"
                          }`}
                        >
                          {reason}
                        </span>
                        <div className="flex items-center gap-2">
                          <Badge variant={isLegacy ? "outline" : "secondary"} className="shadow-sm">
                            {count}
                          </Badge>
                          {!isLegacy && (
                            <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                          )}
                        </div>
                      </div>
                    );
                  })
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
                <div className="flex items-center justify-between p-3 rounded-lg border border-red-500/30 dark:border-red-500/20 bg-red-500/20 dark:bg-red-500/10 shadow-sm shadow-red-500/10 bg-gradient-to-br from-red-500/10 to-transparent relative before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-red-500 before:via-red-400 before:to-red-600 before:rounded-l-lg">
                  <div>
                    <p className="text-sm font-medium text-foreground">Over 60 Days</p>
                    <p className="text-xs text-muted-foreground">Critical attention needed</p>
                  </div>
                  <span className="text-2xl font-bold text-red-600 dark:text-red-400 bg-white/80 dark:bg-gray-900/60 px-3 py-1 rounded-lg shadow-sm" data-testid="text-over-60-days">
                    {safeNumber(metrics.over60Days)}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-amber-500/30 dark:border-amber-500/20 bg-amber-500/20 dark:bg-amber-500/10 shadow-sm shadow-amber-500/10 bg-gradient-to-br from-amber-500/10 to-transparent relative before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-amber-500 before:via-amber-400 before:to-amber-600 before:rounded-l-lg">
                  <div>
                    <p className="text-sm font-medium text-foreground">Over 30 Days</p>
                    <p className="text-xs text-muted-foreground">Requires follow-up</p>
                  </div>
                  <span className="text-2xl font-bold text-amber-600 dark:text-amber-400 bg-white/80 dark:bg-gray-900/60 px-3 py-1 rounded-lg shadow-sm" data-testid="text-over-30-days">
                    {safeNumber(metrics.over30Days)}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-green-500/30 dark:border-green-500/20 bg-green-500/20 dark:bg-green-500/10 shadow-sm shadow-green-500/10 bg-gradient-to-br from-green-500/10 to-transparent relative before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:bg-gradient-to-b before:from-green-500 before:via-green-400 before:to-green-600 before:rounded-l-lg">
                  <div>
                    <p className="text-sm font-medium text-foreground">Under 30 Days</p>
                    <p className="text-xs text-muted-foreground">On track</p>
                  </div>
                  <span className="text-2xl font-bold text-green-600 dark:text-green-400 bg-white/80 dark:bg-gray-900/60 px-3 py-1 rounded-lg shadow-sm" data-testid="text-under-30-days">
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
                      <Badge variant="destructive" className="shadow-sm">{metrics.longestWaitDays} days</Badge>
                      <span className="text-xs text-muted-foreground">on waitlist</span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">No waiting contacts</span>
                  )}
                </div>
              </div>

              <div className="mt-4 p-4 rounded-lg bg-white dark:bg-gray-800/90 border border-gray-200/60 dark:border-gray-700/40 shadow-sm">
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

          {/* Admin Staff Activity */}
          <Card className="overflow-visible">
            <CardHeader>
              <CardTitle className="text-base font-medium flex items-center gap-2">
                <Users className="h-4 w-4" />
                Staff Activity
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Last {staffData?.days ?? 7} days · Excludes system events
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {!staffData?.staff?.length ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No staff activity recorded yet</p>
                ) : (
                  (() => {
                    const maxCount = staffData.staff[0]?.count ?? 1;
                    return staffData.staff.map((s: { user: string; count: number }) => {
                      const name = s.user.split("@")[0];
                      const displayName = name.charAt(0).toUpperCase() + name.slice(1);
                      return (
                        <div key={s.user} className="space-y-1.5">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground" title={s.user}>
                              {displayName}
                            </span>
                            <span className="font-medium text-foreground">{s.count}</span>
                          </div>
                          <div className="h-2 bg-muted/50 backdrop-blur-sm rounded-full overflow-hidden border border-white/20 dark:border-gray-700/30">
                            <div
                              className="h-full bg-gradient-to-r from-primary via-primary/90 to-primary rounded-full transition-all duration-500"
                              style={{ width: `${(s.count / maxCount) * 100}%` }}
                            />
                          </div>
                        </div>
                      );
                    });
                  })()
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageLayout>
  );
}
