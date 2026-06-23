/**
 * Insights PDF Report Template
 *
 * Builds a pdfmake document definition from CRM metrics.
 * Uses Helvetica (PDF built-in).
 */

import { getAllSyncContacts, type SyncContact } from "../sync/db";
import { getStaffActivitySummary } from "../activity/db";
import path from "path";
import fs from "fs";

type Content = Record<string, unknown>;

// Status code → active (same logic as frontend isActiveStatus).
// Active: sub-400 (minus explicit inactives) PLUS the 500-block (REF, active).
// Inactive: 103/104/203/204/205 and the 400-block (incl. 402 Referred Out).
function isActive(code: number): boolean {
  return ![103, 104, 203, 204, 205].includes(code) && (code < 400 || (code >= 500 && code < 600));
}

function getColumnLabel(code: number): string {
  if (code >= 100 && code < 200) return "Waitlist";
  if (code === 206) return "Pending Scheduling"; // Rescheduling Initial Appointment (active PS)
  if (code >= 200 && code < 203) return "Pending Scheduling";
  if (code >= 203 && code < 300) return "Scheduled";
  if (code >= 300 && code < 400) return "On Hold";
  if (code >= 500 && code < 600) return "Referred To Other Services";
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

export async function computeInsightsMetrics(): Promise<InsightsMetrics> {
  const contacts = await getAllSyncContacts();
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
    staffActivity: await getStaffActivitySummary(7),
  };
}

function generateInsightsSummary(metrics: InsightsMetrics): string {
  const sentences: string[] = [];

  // Wait time assessment
  if (metrics.avgWaitDays >= 40) {
    sentences.push(
      `The current waitlist shows elevated wait times, with an average of ${metrics.avgWaitDays} days across ${metrics.totalActive} active clients.`
    );
  } else {
    sentences.push(
      `The current waitlist has ${metrics.totalActive} active clients with an average wait time of ${metrics.avgWaitDays} days.`
    );
  }

  // Backlog risk
  if (metrics.over60Days > 0) {
    const pct = Math.round((metrics.over60Days / metrics.totalActive) * 100);
    sentences.push(
      `${metrics.over60Days} client${metrics.over60Days === 1 ? "" : "s"} (${pct}%) ${metrics.over60Days === 1 ? "has" : "have"} been waiting over 60 days, indicating potential backlog risk.`
    );
  }

  // Top service type
  if (metrics.serviceTypes.length > 0) {
    const [topService, topCount] = metrics.serviceTypes[0];
    sentences.push(
      `The highest demand is for ${topService.toLowerCase()} services, suggesting a potential need for increased provider availability in this area.`
    );
  }

  // Ready to schedule
  if (metrics.readyToSchedule > 0) {
    sentences.push(
      `Immediate scheduling opportunities exist for ${metrics.readyToSchedule} client${metrics.readyToSchedule === 1 ? "" : "s"}.`
    );
  }

  return sentences.slice(0, 4).join(" ");
}

function loadLogoBase64(): string | null {
  try {
    const logoPath = path.resolve(__dirname, "../../client/public/tfc-logo.jpg");
    const buf = fs.readFileSync(logoPath);
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export function buildInsightsDocument(metrics: InsightsMetrics): Record<string, unknown> {
  const blue = "#2563eb";
  const lightBlue = "#eff6ff";
  const gray = "#6b7280";
  const lightGray = "#f9fafb";
  const dark = "#1f2937";
  const border = "#e5e7eb";
  const red = "#dc2626";
  const green = "#16a34a";

  const logoData = loadLogoBase64();

  function sectionTitle(text: string): Content {
    return {
      text,
      fontSize: 13,
      bold: true,
      color: dark,
      margin: [0, 24, 0, 10],
    };
  }

  function divider(): Content {
    return {
      canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: border }],
      margin: [0, 6, 0, 6],
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
        paddingTop: () => 5,
        paddingBottom: () => 5,
      },
    };
  }

  // Build header row: logo + title on left, timestamp on right
  const headerLeft: Content[] = [];
  if (logoData) {
    headerLeft.push({ image: logoData, width: 140, margin: [0, 0, 0, 6] });
  } else {
    headerLeft.push({ text: "The Family Connection", fontSize: 18, bold: true, color: blue, margin: [0, 0, 0, 6] });
  }
  headerLeft.push({ text: "CRM Insights Report", fontSize: 20, bold: true, color: dark });

  const content: Content[] = [
    // Header
    {
      columns: [
        { stack: headerLeft, width: "*" },
        {
          stack: [
            { text: `Generated`, fontSize: 8, color: gray, alignment: "right" },
            { text: metrics.generatedAt, fontSize: 9, color: dark, alignment: "right", margin: [0, 2, 0, 0] },
          ],
          width: 150,
          margin: [0, 8, 0, 0],
        },
      ],
      margin: [0, 0, 0, 4],
    },

    // Header divider
    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.5, lineColor: blue }], margin: [0, 4, 0, 16] },

    // Summary metric cards
    {
      table: {
        widths: ["*", "*", "*", "*"],
        body: [[
          {
            stack: [
              { text: "Active Waitlist", fontSize: 8, color: gray, margin: [0, 0, 0, 4] },
              { text: String(metrics.totalActive), fontSize: 26, bold: true, color: dark },
            ],
            fillColor: lightGray,
            margin: [10, 10, 10, 10],
          },
          {
            stack: [
              { text: "Avg Wait Time", fontSize: 8, color: gray, margin: [0, 0, 0, 4] },
              { text: `${metrics.avgWaitDays} days`, fontSize: 26, bold: true, color: dark },
            ],
            fillColor: lightGray,
            margin: [10, 10, 10, 10],
          },
          {
            stack: [
              { text: "Over 60 Days", fontSize: 8, color: gray, margin: [0, 0, 0, 4] },
              { text: String(metrics.over60Days), fontSize: 26, bold: true, color: red },
            ],
            fillColor: lightGray,
            margin: [10, 10, 10, 10],
          },
          {
            stack: [
              { text: "Ready to Schedule", fontSize: 8, color: gray, margin: [0, 0, 0, 4] },
              { text: String(metrics.readyToSchedule), fontSize: 26, bold: true, color: green },
            ],
            fillColor: lightGray,
            margin: [10, 10, 10, 10],
          },
        ]],
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 4,
        paddingRight: () => 4,
        paddingTop: () => 0,
        paddingBottom: () => 0,
      },
      margin: [0, 0, 0, 6],
    },

    // Longest waiting callout
    {
      table: {
        widths: ["*"],
        body: [[
          {
            text: [
              { text: "Longest Waiting:  ", fontSize: 10, color: gray },
              { text: metrics.longestWaitingName, fontSize: 10, bold: true, color: dark },
              { text: ` — ${metrics.longestWaitDays} days`, fontSize: 10, color: red, bold: true },
            ],
            fillColor: lightBlue,
            margin: [12, 8, 12, 8],
          },
        ]],
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 0,
        paddingBottom: () => 0,
      },
      margin: [0, 4, 0, 4],
    },

    divider(),

    // Executive Summary
    {
      text: "Executive Summary",
      fontSize: 13,
      bold: true,
      color: dark,
      margin: [0, 12, 0, 8],
    },
    {
      text: generateInsightsSummary(metrics),
      fontSize: 10,
      color: "#374151",
      lineHeight: 1.5,
      margin: [0, 0, 0, 8],
    },

    divider(),

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

  return {
    content,
    defaultStyle: { font: "Helvetica" },
    pageSize: "LETTER",
    pageMargins: [40, 40, 40, 50],
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        {
          text: "The Family Connection — CRM Insights Report — Confidential",
          fontSize: 7,
          color: gray,
          alignment: "left",
          margin: [40, 0, 0, 0],
        },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          fontSize: 7,
          color: gray,
          alignment: "right",
          margin: [0, 0, 40, 0],
        },
      ],
      margin: [0, 15, 0, 0],
    }),
  };
}
