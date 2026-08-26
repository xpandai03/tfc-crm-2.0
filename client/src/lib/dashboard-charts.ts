/**
 * Chart row builders for the dashboard cards.
 *
 * PURE FUNCTIONS, deliberately separated from the components.
 *
 * The page's core promise is that a chart agrees with the table beside it. That
 * is a property of these transforms, not of the rendering, so keeping them pure
 * lets the reconciliation check exercise the SAME code the page runs rather than
 * a reimplementation that could agree with itself while both are wrong.
 *
 * These consume the aggregate endpoint's payload and never re-derive a number:
 * every count here is copied from the response, never recomputed.
 */

import { abbreviateInsurance } from "@shared/insurance";
import type { DashboardSummary } from "./dashboard-api";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

/** One bar. `name` is the axis label, `full` the un-abbreviated tooltip title. */
export type StackRow = {
  name: string;
  full: string;
  __total: number;
} & Record<string, string | number>;

export interface ChartSpec {
  rows: StackRow[];
  series: ChartSeries[];
}

/**
 * Five themed tokens (light + dark), which covers the widest chart — Card 3,
 * one series per location.
 *
 * Residual buckets take a NEUTRAL colour rather than a sixth hue: they are not
 * a category on equal footing with the others, and colouring them like one
 * invites reading "Other / Unmapped" as though it were a payer.
 */
export const SERIES_COLORS = [1, 2, 3, 4, 5].map((i) => `hsl(var(--chart-${i}))`);
export const RESIDUAL_COLOR = "hsl(var(--muted-foreground))";

/** Card 2 — location on the category axis, service types stacked within. */
export function buildServiceTypeChart(summary: DashboardSummary): ChartSpec {
  const { columns, labels, rows, totals } = summary.byServiceType;

  const series: ChartSeries[] = [
    ...columns.map((c, i) => ({
      key: c, label: labels[c] ?? c, color: SERIES_COLORS[i % SERIES_COLORS.length],
    })),
    // Residuals only earn a segment when they occur, so clean data isn't
    // cluttered with permanently-empty legend entries.
    ...(totals.other > 0
      ? [{ key: "__other", label: "Other / Unmapped", color: RESIDUAL_COLOR }] : []),
    ...(totals.unknown > 0
      ? [{ key: "__unknown", label: "Not recorded", color: RESIDUAL_COLOR }] : []),
  ];

  const chartRows: StackRow[] = summary.locations.map((loc) => {
    const r = rows.find((x) => x.location === loc.id);
    const out: StackRow = { name: loc.label, full: loc.label, __total: r?.total ?? 0 };
    for (const c of columns) out[c] = r?.counts[c] ?? 0;
    out.__other = r?.other ?? 0;
    out.__unknown = r?.unknown ?? 0;
    return out;
  });

  return { rows: chartRows, series };
}

/**
 * Card 3 — THE AXIS IS INVERTED, deliberately.
 *
 * Cards 1, 2 and 4 put location on the category axis. This one cannot: 16
 * canonical payers plus Other against 4 locations would be four bars split
 * seventeen ways, and no palette survives seventeen series.
 *
 * Rotating it — one row per payer, split by location — is the same data and the
 * same horizontal bar type, and answers the more natural question: who our
 * payers are, with location as the breakdown inside. Five series, one per
 * location, fits the five themed colour tokens exactly.
 *
 * Rows are ordered by total descending with Other / Unmapped PINNED LAST
 * whatever its size, so it reads as a residual and not as a large payer. Payers
 * with zero records everywhere are dropped: an all-zero row is a label with no
 * bar, which is noise rather than information. Nothing holding a record is ever
 * hidden — this is the card built specifically not to drop records.
 *
 * Axis labels use the canonical abbreviations from @shared/insurance. No stored
 * field value is rendered: insurance_payer is free text and has held a patient
 * name and DOB in production.
 */
export function buildInsuranceChart(summary: DashboardSummary): ChartSpec {
  const { columns, rows, totals } = summary.byInsurance;

  const series: ChartSeries[] = summary.locations.map((loc, i) => ({
    key: loc.id, label: loc.label, color: SERIES_COLORS[i % SERIES_COLORS.length],
  }));

  const payerRows: StackRow[] = columns
    .filter((c) => (totals.counts[c] ?? 0) > 0)
    .map((c) => {
      const out: StackRow = {
        name: abbreviateInsurance(c), full: c, __total: totals.counts[c] ?? 0,
      };
      for (const loc of summary.locations) {
        out[loc.id] = rows.find((r) => r.location === loc.id)?.counts[c] ?? 0;
      }
      return out;
    })
    .sort((a, b) => b.__total - a.__total);

  const appendResidual = (
    label: string, total: number, pick: (locId: string) => number,
  ) => {
    if (total <= 0) return;
    const row: StackRow = { name: label, full: label, __total: total };
    for (const loc of summary.locations) row[loc.id] = pick(loc.id);
    payerRows.push(row); // after the sort, so it stays pinned last
  };

  appendResidual("Other / Unmapped", totals.other,
    (id) => rows.find((r) => r.location === id)?.other ?? 0);
  appendResidual("Not recorded", totals.unknown,
    (id) => rows.find((r) => r.location === id)?.unknown ?? 0);

  return { rows: payerRows, series };
}

/** Card 4 — location on the category axis, origin stacked within. */
export function buildOriginChart(summary: DashboardSummary): ChartSpec {
  const { columns, labels, rows } = summary.byOrigin;

  const series: ChartSeries[] = columns.map((c, i) => ({
    key: c, label: labels[c] ?? c, color: SERIES_COLORS[i % SERIES_COLORS.length],
  }));

  const chartRows: StackRow[] = summary.locations.map((loc) => {
    const r = rows.find((x) => x.location === loc.id);
    const out: StackRow = { name: loc.label, full: loc.label, __total: r?.total ?? 0 };
    for (const c of columns) {
      out[c] = (r as unknown as Record<string, number> | undefined)?.[c] ?? 0;
    }
    return out;
  });

  return { rows: chartRows, series };
}

/**
 * Row height for the tall inverted chart. 30px keeps every label on its own
 * line at any viewport width.
 */
export function insuranceChartHeight(rowCount: number): number {
  return Math.max(240, rowCount * 30 + 60);
}
