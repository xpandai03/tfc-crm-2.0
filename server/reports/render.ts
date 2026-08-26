/**
 * Monthly report renderers: HTML email body and XLSX attachment.
 *
 * NO PHI. Both renderers take a MonthlyReport, which is aggregate counts only —
 * there is no code path from here to a contact row, because the data layer never
 * loaded one. That is the structural guarantee, not a review promise.
 *
 * The email lands in a CEO's inbox unaccompanied, so it has to explain itself:
 * plain language, stated counting rule, and every total shown next to the parts
 * that make it up.
 */

import * as XLSX from "xlsx";
import type { MonthlyReport, CohortBreakdown } from "./monthly";
import { COHORT_LABELS } from "./monthly";
import { DASHBOARD_LOCATIONS } from "@shared/dashboard-locations";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Ordered [label, count] pairs for a breakdown, with other/unknown appended. */
function breakdownRows(
  b: CohortBreakdown, labels: Record<string, string>, otherLabel = "Other / Unmapped",
): [string, number][] {
  const rows: [string, number][] = Object.entries(b.counts)
    .map(([k, v]) => [labels[k] ?? k, v] as [string, number]);
  if (b.other > 0) rows.push([otherLabel, b.other]);
  if (b.unknown > 0) rows.push(["Not recorded", b.unknown]);
  return rows;
}

const pct = (n: number, total: number) =>
  total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`;

// ============================================================================
// HTML email
// ============================================================================

const CSS_TABLE =
  'style="border-collapse:collapse;width:100%;max-width:560px;margin:8px 0 20px;font-size:14px"';
const CSS_TH =
  'style="text-align:left;padding:6px 10px;border-bottom:2px solid #d4d4d8;font-weight:600"';
const CSS_TD = 'style="padding:6px 10px;border-bottom:1px solid #ececf0"';
const CSS_TDN =
  'style="padding:6px 10px;border-bottom:1px solid #ececf0;text-align:right;font-variant-numeric:tabular-nums"';

function htmlTable(head: [string, string], rows: [string, number][], total?: number): string {
  const body = rows.map(
    ([k, v]) => `<tr><td ${CSS_TD}>${esc(k)}</td><td ${CSS_TDN}>${v}</td></tr>`,
  ).join("");
  const foot = total === undefined ? "" :
    `<tr><td style="padding:6px 10px;font-weight:600;border-top:2px solid #d4d4d8">Total</td>` +
    `<td style="padding:6px 10px;text-align:right;font-weight:600;border-top:2px solid #d4d4d8;font-variant-numeric:tabular-nums">${total}</td></tr>`;
  return `<table ${CSS_TABLE}><thead><tr><th ${CSS_TH}>${esc(head[0])}</th>` +
    `<th ${CSS_TH} style="text-align:right;padding:6px 10px;border-bottom:2px solid #d4d4d8;font-weight:600">${esc(head[1])}</th></tr></thead>` +
    `<tbody>${body}${foot}</tbody></table>`;
}

export function renderMonthlyReportHtml(r: MonthlyReport): string {
  const s = r.snapshot;
  const c = r.cohort;
  const empty = c.size === 0;

  const locRows: [string, number][] = DASHBOARD_LOCATIONS
    .map((l) => {
      const row = s.byStatus.rows.find((x) => x.location === l.id);
      return [l.label, row?.active ?? 0] as [string, number];
    })
    .filter(([, v], i) => v > 0 || !DASHBOARD_LOCATIONS[i].residual);

  const originRows = breakdownRows(c.byOrigin, COHORT_LABELS.origin);

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b;line-height:1.5">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;padding:28px 26px">

  <h1 style="margin:0 0 4px;font-size:20px">TFC Monthly Report</h1>
  <p style="margin:0 0 24px;color:#6b7280;font-size:14px">
    Reporting period: <strong style="color:#18181b">${esc(r.periodLabel)}</strong>
    (${esc(r.periodStart)} to ${esc(r.periodEndExclusive)}, exclusive)
  </p>

  <!-- ==================== CURRENT SNAPSHOT ==================== -->
  <h2 style="font-size:16px;margin:0 0 2px;padding-top:14px;border-top:1px solid #ececf0">Where things stand today</h2>
  <p style="margin:0 0 6px;color:#6b7280;font-size:13px">
    Everyone currently open, as of the moment this report was generated.
  </p>
  <p style="margin:0 0 14px;font-size:15px">
    <strong>${s.totals.pipeline}</strong> in pipeline
    <span style="color:#6b7280">(waitlist + pending + scheduled)</span>
    + <strong>${s.totals.otherActive}</strong> other active
    = <strong>${s.totals.active}</strong> active clients.
  </p>
  ${htmlTable(["Stage", "Clients"], [
    ["Waitlist", s.byStatus.totals.waitlist],
    ["Pending scheduling", s.byStatus.totals.pending],
    ["Scheduled", s.byStatus.totals.scheduled],
    ["Other active", s.byStatus.totals.otherActive],
  ], s.totals.active)}
  <h3 style="font-size:14px;margin:0 0 2px">Active clients by location</h3>
  ${htmlTable(["Location", "Active"], locRows, s.totals.active)}

  <!-- ==================== PERIOD RETROSPECTIVE ==================== -->
  <h2 style="font-size:16px;margin:0 0 2px;padding-top:14px;border-top:1px solid #ececf0">What happened in ${esc(r.periodLabel)}</h2>
  <p style="margin:0 0 6px;color:#6b7280;font-size:13px">
    Every referral <em>received</em> in ${esc(r.periodLabel)}, and where each one stands now —
    including those since closed. This is a different group from the section above.
  </p>
  ${empty ? `
  <p style="margin:0 0 20px;padding:14px;background:#f6f6f8;border-radius:6px;font-size:14px">
    No referrals were received in ${esc(r.periodLabel)}.
  </p>` : `
  <p style="margin:0 0 14px;font-size:15px">
    <strong>${c.size}</strong> referrals received.
    <strong>${c.reachedScheduling}</strong> (${pct(c.reachedScheduling, c.size)}) reached a scheduled appointment.
    <strong>${c.nowActive}</strong> are still open; <strong>${c.nowInactive}</strong> have since closed.
  </p>
  ${htmlTable(["Current status", "Referrals"],
    breakdownRows(c.byStatusBucket, COHORT_LABELS.statusBucket), c.size)}
  ${htmlTable(["Location", "Referrals"],
    breakdownRows(c.byLocation, COHORT_LABELS.location), c.size)}
  ${htmlTable(["Requested for", "Referrals"],
    breakdownRows(c.byServiceType, COHORT_LABELS.serviceType), c.size)}
  `}

  <!-- ==================== REFERRAL ORIGIN ==================== -->
  <h2 style="font-size:16px;margin:0 0 2px;padding-top:14px;border-top:1px solid #ececf0">How those referrals reached us</h2>
  <p style="margin:0 0 6px;color:#6b7280;font-size:13px">
    Every referral falls into exactly one channel. Referrals entered by staff are
    not separately identifiable and appear under Online RFS Form.
  </p>
  ${empty
    ? `<p style="margin:0 0 20px;font-size:14px;color:#6b7280">No referrals to break down this period.</p>`
    : htmlTable(["Channel", "Referrals"], originRows, c.size)}

  <!-- ==================== FOOTER ==================== -->
  <p style="margin:18px 0 0;padding-top:14px;border-top:1px solid #ececf0;color:#6b7280;font-size:12px">
    Counts are per client, by first-choice location preference only, so nobody is
    counted twice. ${esc(r.dataQuality.note)}
    ${r.dataQuality.undatedContacts > 0
      ? `${r.dataQuality.undatedContacts} historical record${r.dataQuality.undatedContacts === 1 ? " has" : "s have"} no recorded date and ${r.dataQuality.undatedContacts === 1 ? "is" : "are"} not counted in any monthly period.`
      : ""}
    <br><br>
    Generated automatically by the TFC CRM on
    ${esc(new Date(r.generatedAt).toLocaleString("en-US", { timeZone: "America/Denver", dateStyle: "long", timeStyle: "short" }))} Mountain Time.
    The attached spreadsheet contains the same figures as tables.
  </p>

</div></body></html>`;
}

export function renderMonthlyReportSubject(r: MonthlyReport): string {
  return `TFC Monthly Report — ${r.periodLabel}`;
}

// ============================================================================
// XLSX attachment — aggregate tables only, one sheet per breakdown
// ============================================================================

type AOA = (string | number)[][];

export function renderMonthlyReportXlsx(r: MonthlyReport): Buffer {
  const s = r.snapshot;
  const c = r.cohort;
  const wb = XLSX.utils.book_new();

  const addSheet = (name: string, aoa: AOA) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 34 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  addSheet("Summary", [
    ["TFC Monthly Report"],
    ["Reporting period", r.periodLabel],
    ["Period start (inclusive)", r.periodStart],
    ["Period end (exclusive)", r.periodEndExclusive],
    ["Generated (UTC)", r.generatedAt],
    [],
    ["CURRENT SNAPSHOT — open clients today"],
    ["Waitlist", s.byStatus.totals.waitlist],
    ["Pending scheduling", s.byStatus.totals.pending],
    ["Scheduled", s.byStatus.totals.scheduled],
    ["Other active", s.byStatus.totals.otherActive],
    ["Pipeline (waitlist + pending + scheduled)", s.totals.pipeline],
    ["Total active", s.totals.active],
    ["All contacts on record", s.totals.all],
    [],
    [`PERIOD RETROSPECTIVE — referrals received in ${r.periodLabel}`],
    ["Referrals received", c.size],
    ["Still open", c.nowActive],
    ["Since closed", c.nowInactive],
    ["Currently scheduled", c.currentlyScheduled],
    ["Initial appointment completed", c.initialApptCompleted],
    ["Reached a scheduled appointment", c.reachedScheduling],
    [],
    ["Counting rule", "Per client, by first-choice location preference (P1) only."],
    ["Date basis", r.dataQuality.note],
    ["Undated historical records (excluded from all periods)", r.dataQuality.undatedContacts],
  ]);

  addSheet("Snapshot by Location", [
    ["Location", "Waitlist", "Pending", "Scheduled", "Other active", "Pipeline", "Active"],
    ...DASHBOARD_LOCATIONS.map((l) => {
      const row = s.byStatus.rows.find((x) => x.location === l.id);
      return [l.label, row?.waitlist ?? 0, row?.pending ?? 0, row?.scheduled ?? 0,
        row?.otherActive ?? 0, row?.pipeline ?? 0, row?.active ?? 0];
    }),
    ["Total", s.byStatus.totals.waitlist, s.byStatus.totals.pending,
      s.byStatus.totals.scheduled, s.byStatus.totals.otherActive,
      s.totals.pipeline, s.totals.active],
  ]);

  const breakdownSheet = (
    name: string, header: string, b: CohortBreakdown, labels: Record<string, string>,
  ) => addSheet(name, [
    [header, "Referrals"],
    ...breakdownRows(b, labels),
    ["Total", b.total],
  ]);

  breakdownSheet("Period by Status", "Current status", c.byStatusBucket, COHORT_LABELS.statusBucket);
  breakdownSheet("Period by Origin", "Referral channel", c.byOrigin, COHORT_LABELS.origin);
  breakdownSheet("Period by Service Type", "Requested for", c.byServiceType, COHORT_LABELS.serviceType);
  breakdownSheet("Period by Location", "Location", c.byLocation, COHORT_LABELS.location);

  addSheet("Period Status Detail", [
    ["Status", "Referrals"],
    ...c.byStatusCode.map((x) => [x.label, x.n] as (string | number)[]),
    ["Total", c.size],
  ]);

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function monthlyReportFilename(r: MonthlyReport): string {
  return `TFC-Monthly-Report-${r.period}.xlsx`;
}
