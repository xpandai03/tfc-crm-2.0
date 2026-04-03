/**
 * Insights PDF Report Template
 *
 * Builds a pdfmake document definition from CRM metrics.
 * Uses Helvetica (PDF built-in).
 */

import { getAllSyncContacts, type SyncContact } from "../sync/db";
import { getStaffActivitySummary } from "../activity/db";

type Content = Record<string, unknown>;

// Status code → active (same logic as frontend isActiveStatus)
function isActive(code: number): boolean {
  return ![103, 104, 203, 204, 205].includes(code) && code < 400;
}

function getColumnLabel(code: number): string {
  if (code >= 100 && code < 200) return "Waitlist";
  if (code >= 200 && code < 203) return "Pending Scheduling";
  if (code >= 203 && code < 300) return "Scheduled";
  if (code >= 300 && code < 400) return "On Hold";
  return "Inactive";
}

function computeDays(dateAdded: string | null, daysOnWaitlist: number | null): number {
  if (dateAdded) {
    const d = new Date(dateAdded);
    if (!isNaN(d.getTime())) {
      return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
    }
  }
  return daysOnWaitlist ?? 0;
}

interface InsightsMetrics {
  generatedAt: string;
  totalActive: number;
  avgWaitDays: number;
  longestWaitDays: number;
  longestWaitingName: string;
  over60Days: number;
  readyToSchedule: number;
  statusDistribution: [string, number][];
  serviceTypes: [string, number][];
  insuranceTypes: [string, number][];
  modalityTypes: [string, number][];
  staffActivity: { user: string; count: number }[];
}

export function computeInsightsMetrics(): InsightsMetrics {
  const contacts = getAllSyncContacts();
  const active = contacts.filter(c => isActive(c.statusCode ?? 0));

  const totalActive = active.length;
  const avgWaitDays = totalActive > 0
    ? Math.round(active.reduce((s, c) => s + computeDays(c.dateAdded, c.daysOnWaitlist), 0) / totalActive)
    : 0;

  let longestWaitDays = 0;
  let longestWaitingName = "---";
  for (const c of active) {
    const d = computeDays(c.dateAdded, c.daysOnWaitlist);
    if (d > longestWaitDays) { longestWaitDays = d; longestWaitingName = c.name; }
  }

  const over60Days = active.filter(c => computeDays(c.dateAdded, c.daysOnWaitlist) >= 60).length;
  const readyToSchedule = contacts.filter(c => (c.statusCode ?? 0) === 200).length;

  // Distributions
  const statusMap: Record<string, number> = {};
  for (const c of contacts) {
    const label = getColumnLabel(c.statusCode ?? 0);
    statusMap[label] = (statusMap[label] || 0) + 1;
  }

  const serviceMap: Record<string, number> = {};
  for (const c of active) {
    const s = c.requestingFor?.trim() || "Unknown";
    serviceMap[s] = (serviceMap[s] || 0) + 1;
  }

  const insuranceMap: Record<string, number> = {};
  for (const c of active) {
    const i = c.insurancePayer?.trim() || "Unknown";
    insuranceMap[i] = (insuranceMap[i] || 0) + 1;
  }

  const modalityMap: Record<string, number> = {};
  for (const c of active) {
    const m = c.modality?.trim() || "Unknown";
    modalityMap[m] = (modalityMap[m] || 0) + 1;
  }

  const sort = (m: Record<string, number>) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]);

  return {
    generatedAt: new Date().toLocaleString("en-US", { timeZone: "America/Denver" }),
    totalActive,
    avgWaitDays,
    longestWaitDays,
    longestWaitingName,
    over60Days,
    readyToSchedule,
    statusDistribution: sort(statusMap),
    serviceTypes: sort(serviceMap),
    insuranceTypes: sort(insuranceMap).slice(0, 15),
    modalityTypes: sort(modalityMap),
    staffActivity: getStaffActivitySummary(7),
  };
}

export function buildInsightsDocument(metrics: InsightsMetrics): Record<string, unknown> {
  const blue = "#2563eb";
  const gray = "#6b7280";
  const dark = "#1f2937";

  function sectionTitle(text: string): Content {
    return {
      text,
      fontSize: 13,
      bold: true,
      color: dark,
      margin: [0, 18, 0, 8],
    };
  }

  function distributionTable(items: [string, number][]): Content {
    if (items.length === 0) return { text: "No data available", color: gray, fontSize: 9, margin: [0, 4, 0, 0] };
    const max = items[0][1] || 1;
    return {
      table: {
        widths: ["*", 40],
        body: items.map(([label, count]) => [
          {
            stack: [
              { text: label, fontSize: 9, color: dark },
              {
                canvas: [
                  { type: "rect", x: 0, y: 2, w: Math.max(4, (count / max) * 300), h: 6, r: 3, color: blue },
                ],
              },
            ],
          },
          { text: String(count), fontSize: 9, bold: true, color: dark, alignment: "right" },
        ]),
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingTop: () => 4,
        paddingBottom: () => 4,
      },
    };
  }

  const content: Content[] = [
    // Header
    {
      columns: [
        { text: "The Family Connection", fontSize: 18, bold: true, color: blue },
        { text: `Generated: ${metrics.generatedAt}`, fontSize: 9, color: gray, alignment: "right", margin: [0, 6, 0, 0] },
      ],
    },
    { text: "CRM Insights Report", fontSize: 22, bold: true, color: dark, margin: [0, 4, 0, 2] },
    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: "#e5e7eb" }], margin: [0, 4, 0, 16] },

    // Summary cards
    {
      columns: [
        {
          stack: [
            { text: "Active Waitlist", fontSize: 9, color: gray },
            { text: String(metrics.totalActive), fontSize: 28, bold: true, color: dark },
          ],
          width: "*",
        },
        {
          stack: [
            { text: "Avg Wait Time", fontSize: 9, color: gray },
            { text: `${metrics.avgWaitDays}d`, fontSize: 28, bold: true, color: dark },
          ],
          width: "*",
        },
        {
          stack: [
            { text: "Over 60 Days", fontSize: 9, color: gray },
            { text: String(metrics.over60Days), fontSize: 28, bold: true, color: "#dc2626" },
          ],
          width: "*",
        },
        {
          stack: [
            { text: "Ready to Schedule", fontSize: 9, color: gray },
            { text: String(metrics.readyToSchedule), fontSize: 28, bold: true, color: "#16a34a" },
          ],
          width: "*",
        },
      ],
      margin: [0, 0, 0, 8],
    },

    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#e5e7eb" }], margin: [0, 4, 0, 0] },

    // Longest waiting callout
    {
      text: [
        { text: "Longest Waiting: ", fontSize: 10, color: gray },
        { text: metrics.longestWaitingName, fontSize: 10, bold: true, color: dark },
        { text: ` — ${metrics.longestWaitDays} days`, fontSize: 10, color: "#dc2626" },
      ],
      margin: [0, 10, 0, 0],
    },

    // Distributions
    sectionTitle("Status Distribution"),
    distributionTable(metrics.statusDistribution),

    sectionTitle("By Service Type"),
    distributionTable(metrics.serviceTypes),

    sectionTitle("By Insurance"),
    distributionTable(metrics.insuranceTypes),

    sectionTitle("By Modality"),
    distributionTable(metrics.modalityTypes),
  ];

  // Staff activity (if data exists)
  if (metrics.staffActivity.length > 0) {
    content.push(sectionTitle("Staff Activity (Last 7 Days)"));
    content.push(distributionTable(metrics.staffActivity.map(s => {
      const name = s.user.split("@")[0];
      return [name.charAt(0).toUpperCase() + name.slice(1), s.count] as [string, number];
    })));
  }

  // Footer
  content.push({
    text: "The Family Connection · CRM Insights Report · Confidential",
    fontSize: 8,
    color: gray,
    alignment: "center",
    margin: [0, 30, 0, 0],
  });

  return {
    content,
    defaultStyle: { font: "Helvetica" },
    pageSize: "LETTER",
    pageMargins: [40, 40, 40, 40],
  };
}
