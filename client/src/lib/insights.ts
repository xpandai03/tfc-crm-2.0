/**
 * Insight Generation Module
 *
 * Generates data-driven, explainable insights from waitlist contacts.
 * All insights are computed client-side from available data.
 * No LLM/AI API calls - pure deterministic computation.
 */

import type { WaitlistContact } from "@shared/schema";
import { isActiveStatus, stringStatusToCode, STATUS_GROUPS } from "./status-config";
import { computeDaysWaiting } from "./days-waiting";

export interface Insight {
  id: string;
  type: "urgency" | "pattern" | "context" | "comparison";
  priority: number; // 1 = highest priority
  message: string;
  dataPoints: string[]; // Fields this insight is based on
  contactName?: string; // Primary contact name (for display)
  contactId?: number; // Primary contact ID (for navigation/actions) - CANONICAL
}

interface ComputedMetrics {
  totalActive: number;
  avgWaitDays: number;
  over60Days: number;
  readyToSchedule: number;
}

// Helper to get status code from contact
function getStatusCode(contact: WaitlistContact): number {
  return contact.statusCode ?? stringStatusToCode(contact.status);
}

// Helper to format a list of names
function formatNameList(names: string[], max: number = 3): string {
  if (names.length <= max) {
    return names.join(", ");
  }
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/**
 * Generate outlier insight - contacts significantly above average
 */
function generateOutlierInsight(
  contacts: WaitlistContact[],
  avgWaitDays: number
): Insight | null {
  if (avgWaitDays === 0) return null;

  const activeContacts = contacts.filter(c => isActiveStatus(getStatusCode(c)));
  const outliers = activeContacts
    .filter(c => computeDaysWaiting(c.dateAdded, c.daysOnWaitlist) >= avgWaitDays * 2)
    .sort((a, b) => computeDaysWaiting(b.dateAdded, b.daysOnWaitlist) - computeDaysWaiting(a.dateAdded, a.daysOnWaitlist));

  if (outliers.length === 0) return null;

  const longest = outliers[0];
  const longestDays = computeDaysWaiting(longest.dateAdded, longest.daysOnWaitlist);
  const longestName = longest.name || "Unknown";
  const longestService = longest.serviceRequested || "Unknown";

  // Guard against division issues
  if (longestDays === 0 || avgWaitDays === 0) return null;

  const multiplier = (longestDays / avgWaitDays).toFixed(1);

  return {
    id: "outlier-longest",
    type: "comparison",
    priority: 2,
    message: `${longestName} has been waiting ${longestDays} days — ${multiplier}x longer than the ${avgWaitDays}-day average. Service: ${longestService}.`,
    dataPoints: ["daysOnWaitlist", "avgWaitDays", "serviceRequested"],
    contactName: longestName !== "Unknown" ? longestName : undefined,
    contactId: longest.contactId, // CANONICAL: include contactId for navigation
  };
}

/**
 * Generate threshold breach insight - contacts over 60 days
 */
function generateThresholdInsight(contacts: WaitlistContact[]): Insight | null {
  const activeContacts = contacts.filter(c => isActiveStatus(getStatusCode(c)));
  const over60 = activeContacts
    .filter(c => computeDaysWaiting(c.dateAdded, c.daysOnWaitlist) >= 60)
    .sort((a, b) => computeDaysWaiting(b.dateAdded, b.daysOnWaitlist) - computeDaysWaiting(a.dateAdded, a.daysOnWaitlist));

  if (over60.length === 0) return null;

  const topNames = over60.slice(0, 3).map(c => `${c.name || "Unknown"} (${computeDaysWaiting(c.dateAdded, c.daysOnWaitlist)}d)`);
  const primaryContact = over60[0];

  return {
    id: "threshold-60-days",
    type: "urgency",
    priority: 1,
    message: `${over60.length} contact${over60.length === 1 ? " has" : "s have"} crossed the 60-day threshold. Longest waiting: ${formatNameList(topNames)}.`,
    dataPoints: ["daysOnWaitlist", "over60Days"],
    contactName: primaryContact?.name && primaryContact.name !== "Unknown" ? primaryContact.name : undefined,
    contactId: primaryContact?.contactId, // CANONICAL: include contactId for navigation
  };
}

/**
 * Generate service bottleneck insight - which services have most waiting
 */
function generateServiceBottleneckInsight(contacts: WaitlistContact[]): Insight | null {
  const activeContacts = contacts.filter(c => isActiveStatus(getStatusCode(c)));
  if (activeContacts.length < 5) return null;

  // Group by service
  const serviceGroups: Record<string, { count: number; totalDays: number }> = {};
  for (const contact of activeContacts) {
    const service = contact.serviceRequested || "Unknown";
    if (!serviceGroups[service]) {
      serviceGroups[service] = { count: 0, totalDays: 0 };
    }
    serviceGroups[service].count++;
    serviceGroups[service].totalDays += computeDaysWaiting(contact.dateAdded, contact.daysOnWaitlist);
  }

  // Find service with highest average wait
  let highestService = "";
  let highestAvg = 0;
  let highestCount = 0;

  for (const [service, data] of Object.entries(serviceGroups)) {
    if (data.count >= 3) { // Only consider services with 3+ contacts
      const avg = data.totalDays / data.count;
      if (avg > highestAvg) {
        highestAvg = avg;
        highestService = service;
        highestCount = data.count;
      }
    }
  }

  if (!highestService || highestAvg < 30) return null;

  return {
    id: "service-bottleneck",
    type: "pattern",
    priority: 4,
    message: `"${highestService}" services have the longest average wait (${Math.round(highestAvg)} days) across ${highestCount} contacts.`,
    dataPoints: ["serviceRequested", "daysOnWaitlist"],
  };
}

/**
 * Generate ready to schedule insight - batch opportunity
 */
function generateReadyBatchInsight(contacts: WaitlistContact[]): Insight | null {
  const readyContacts = contacts.filter(c => {
    const statusCode = getStatusCode(c);
    return (STATUS_GROUPS.ready_to_schedule as readonly number[]).includes(statusCode);
  });

  if (readyContacts.length === 0) return null;

  const primaryContact = readyContacts[0];

  if (readyContacts.length >= 3) {
    const names = readyContacts.slice(0, 3).map(c => c.name || "Unknown");
    return {
      id: "ready-batch",
      type: "context",
      priority: 3,
      message: `${readyContacts.length} contacts are ready to schedule: ${formatNameList(names)}.`,
      dataPoints: ["statusCode", "readyToSchedule"],
      contactName: primaryContact?.name && primaryContact.name !== "Unknown" ? primaryContact.name : undefined,
      contactId: primaryContact?.contactId, // CANONICAL: include contactId for navigation
    };
  }

  // Single or two contacts ready
  const names = readyContacts.map(c => c.name || "Unknown").join(" and ");
  return {
    id: "ready-single",
    type: "context",
    priority: 3,
    message: `${names} ${readyContacts.length === 1 ? "is" : "are"} ready to schedule.`,
    dataPoints: ["statusCode", "readyToSchedule"],
    contactName: primaryContact?.name && primaryContact.name !== "Unknown" ? primaryContact.name : undefined,
    contactId: primaryContact?.contactId, // CANONICAL: include contactId for navigation
  };
}

/**
 * Generate status distribution insight
 */
function generateStatusDistributionInsight(contacts: WaitlistContact[]): Insight | null {
  const activeContacts = contacts.filter(c => isActiveStatus(getStatusCode(c)));
  if (activeContacts.length < 10) return null;

  // Count by status group
  let intakeCount = 0;
  let waitingCount = 0;
  let pendingCount = 0;

  for (const contact of activeContacts) {
    const statusCode = getStatusCode(contact);
    if ((STATUS_GROUPS.intake as readonly number[]).includes(statusCode)) {
      intakeCount++;
    } else if ((STATUS_GROUPS.waiting as readonly number[]).includes(statusCode)) {
      waitingCount++;
    } else if ((STATUS_GROUPS.pending as readonly number[]).includes(statusCode)) {
      pendingCount++;
    }
  }

  // Find dominant group
  const total = activeContacts.length;
  const waitingPct = Math.round((waitingCount / total) * 100);
  const intakePct = Math.round((intakeCount / total) * 100);

  if (waitingPct >= 50) {
    return {
      id: "status-distribution",
      type: "pattern",
      priority: 5,
      message: `${waitingPct}% of active contacts (${waitingCount} of ${total}) are in "Waiting" status — potential outreach bottleneck.`,
      dataPoints: ["statusCode", "byStatus"],
    };
  }

  if (intakePct >= 40) {
    return {
      id: "status-distribution-intake",
      type: "pattern",
      priority: 5,
      message: `${intakePct}% of contacts (${intakeCount} of ${total}) are still in "Intake" — may need initial outreach.`,
      dataPoints: ["statusCode", "byStatus"],
    };
  }

  return null;
}

/**
 * Generate positive insight when things are going well
 */
function generatePositiveInsight(
  contacts: WaitlistContact[],
  metrics: ComputedMetrics
): Insight | null {
  if (metrics.over60Days === 0 && metrics.totalActive > 0) {
    return {
      id: "no-urgent",
      type: "context",
      priority: 6,
      message: `All ${metrics.totalActive} active contacts are within the 60-day target. Pipeline is healthy.`,
      dataPoints: ["over60Days", "totalActive"],
    };
  }

  if (metrics.avgWaitDays < 30 && metrics.totalActive >= 10) {
    return {
      id: "healthy-avg",
      type: "context",
      priority: 6,
      message: `Average wait time is ${metrics.avgWaitDays} days across ${metrics.totalActive} contacts — well under the 60-day threshold.`,
      dataPoints: ["avgWaitDays", "totalActive"],
    };
  }

  return null;
}

/**
 * Main insight generation function
 * Returns prioritized list of insights based on current data
 * FAIL-SOFT: Always returns an array, never throws
 */
export function generateInsights(
  contacts: WaitlistContact[] | null | undefined,
  metrics: ComputedMetrics | null | undefined
): Insight[] {
  // Defensive: handle missing or invalid inputs
  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return [{
      id: "no-data",
      type: "context",
      priority: 10,
      message: "No contact data available. Refresh to load the latest information.",
      dataPoints: [],
    }];
  }

  // Defensive: ensure metrics object exists with safe defaults
  const safeMetrics: ComputedMetrics = {
    totalActive: metrics?.totalActive ?? 0,
    avgWaitDays: metrics?.avgWaitDays ?? 0,
    over60Days: metrics?.over60Days ?? 0,
    readyToSchedule: metrics?.readyToSchedule ?? 0,
  };

  const insights: Insight[] = [];

  // Wrap each insight generator in try-catch to prevent cascading failures
  try {
    const thresholdInsight = generateThresholdInsight(contacts);
    if (thresholdInsight) insights.push(thresholdInsight);
  } catch (e) {
    console.warn("[insights] Failed to generate threshold insight:", e);
  }

  try {
    const outlierInsight = generateOutlierInsight(contacts, safeMetrics.avgWaitDays);
    if (outlierInsight) insights.push(outlierInsight);
  } catch (e) {
    console.warn("[insights] Failed to generate outlier insight:", e);
  }

  try {
    const readyInsight = generateReadyBatchInsight(contacts);
    if (readyInsight) insights.push(readyInsight);
  } catch (e) {
    console.warn("[insights] Failed to generate ready insight:", e);
  }

  try {
    const serviceInsight = generateServiceBottleneckInsight(contacts);
    if (serviceInsight) insights.push(serviceInsight);
  } catch (e) {
    console.warn("[insights] Failed to generate service insight:", e);
  }

  try {
    const distributionInsight = generateStatusDistributionInsight(contacts);
    if (distributionInsight) insights.push(distributionInsight);
  } catch (e) {
    console.warn("[insights] Failed to generate distribution insight:", e);
  }

  // Add positive insight if no urgent ones
  try {
    if (insights.length === 0 || (!insights.some(i => i.type === "urgency"))) {
      const positiveInsight = generatePositiveInsight(contacts, safeMetrics);
      if (positiveInsight) insights.push(positiveInsight);
    }
  } catch (e) {
    console.warn("[insights] Failed to generate positive insight:", e);
  }

  // Sort by priority (lowest number = highest priority)
  insights.sort((a, b) => a.priority - b.priority);

  return insights;
}
