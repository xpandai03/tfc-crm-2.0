/**
 * Dashboard Excel export.
 *
 * READS THE VERIFIED NUMBERS, NEVER RECOMPUTES THEM. Every figure here comes
 * from getDashboardSummary() — the same pivot the on-screen cards render and the
 * same one the reconciliation harness checks. There is deliberately no second
 * aggregation in this file: two code paths computing the same number eventually
 * disagree, and the one nobody is looking at is the one that ends up in a file
 * the CEO keeps.
 *
 * AGGREGATE COUNTS ONLY. No contact rows, no names, no dates of birth, and no
 * raw insurance values. The unmapped-insurance list stays in the gated in-app
 * modal; it does not travel in a file that leaves the system.
 *
 * The honesty rule that governs the cards governs the workbook: Other /
 * Unmapped and Unknown are written out, so every column set reconciles to its
 * row total. Nothing is dropped to make a total look tidy.
 */

import * as XLSX from "xlsx";
import {
  getDashboardSummary, type Population, type CardScope, type CrossTabSet,
} from "./db";
import { embedImages, type SheetImage } from "./xlsx-images";
import { PIPELINE_BUCKETS } from "@shared/status-buckets";

type AOA = (string | number)[][];

/** One chart image supplied by the browser, already rasterised. */
export interface ExportChartImage {
  /** Card key: which sheet it belongs on. */
  card: string;
  /** Base64 PNG (no data: prefix). */
  base64: string;
  widthPx: number;
  heightPx: number;
}

export interface DashboardExportRequest {
  population: Population;
  /** Per-card scope, exactly as the screen has them set. */
  scopes: Partial<Record<string, CardScope>>;
  images?: ExportChartImage[];
}

const SCOPE_LABEL: Record<CardScope, string> = {
  pipeline: "Pipeline (Waitlist + Pending + Scheduled)",
  waitlist: "Waitlist only",
};

/** Sheet order. The card key is what the browser tags its images with. */
const CARDS = [
  { key: "status", sheet: "1 Location x Status" },
  { key: "serviceType", sheet: "2 Location x Service Type" },
  { key: "insurance", sheet: "3 Location x Insurance" },
  { key: "serviceTypeInsurance", sheet: "4 Service Type x Insurance" },
  { key: "origin", sheet: "5 Location x Origin" },
] as const;

export interface WorkbookResult {
  buffer: Buffer; filename: string; imagesEmbedded: number; warnings: string[];
}

/** Fetch the verified numbers, then build. The only I/O in this module. */
export async function buildDashboardWorkbook(
  req: DashboardExportRequest,
): Promise<WorkbookResult> {
  return buildWorkbookFromSummary(await getDashboardSummary(req.population), req);
}

/**
 * PURE: a summary in, a workbook out. Split from the fetch so the self-checks
 * can build a real workbook from a real production snapshot without a database,
 * and exercise this exact code rather than a reimplementation.
 */
export function buildWorkbookFromSummary(
  summary: Awaited<ReturnType<typeof getDashboardSummary>>,
  req: DashboardExportRequest,
): WorkbookResult {
  const warnings: string[] = [];
  const scopeOf = (card: string): CardScope => req.scopes[card] === "waitlist" ? "waitlist" : "pipeline";
  const setOf = (card: string): CrossTabSet => summary.scopes[scopeOf(card)];

  const wb = XLSX.utils.book_new();
  const sheetRows: number[] = []; // rows used per sheet, to anchor images below

  // ---- Sheet 0: header / provenance ---------------------------------------
  // Someone opening this a month later has to be able to tell what it counts
  // without asking anyone.
  const generated = new Date();
  const overview: AOA = [
    ["TFC Management Dashboard — exported snapshot"],
    [],
    ["Exported (UTC)", generated.toISOString()],
    ["Exported (Mountain)", generated.toLocaleString("en-US", {
      timeZone: "America/Denver", dateStyle: "long", timeStyle: "short",
    })],
    [],
    ["POPULATION AND COUNTING RULES IN FORCE"],
    ["Population", req.population === "active"
      ? "Active — every contact in an open status"
      : "All — every contact on record, including closed"],
    ["Pipeline definition", `Pipeline = ${PIPELINE_BUCKETS.join(" + ")}`],
    ["Counting rule", "Per contact, by first-choice modality (P1) only — nobody is counted twice."],
    ["Other / Unmapped", "Records whose insurance value is not one of the 16 approved payers. Shown, never dropped, so columns reconcile."],
    [],
    ["HEADLINE FIGURES"],
    ["All contacts on record", summary.totals.all],
    ["Active", summary.totals.active],
    ["Pipeline", summary.totals.pipeline],
    ["Other active (Resources to Send, PM Review)", summary.totals.otherActive],
    [],
    ["PER-CARD SCOPE AS EXPORTED"],
    ...CARDS.filter((c) => c.key !== "status").map((c) =>
      [c.sheet, SCOPE_LABEL[scopeOf(c.key)]] as (string | number)[]),
    ["1 Location x Status", "Not scoped — this card always breaks out by status"],
    [],
    ["This workbook is a static snapshot. The charts are pictures, not live",
      "Excel charts: they cannot recalculate or change when the file is opened."],
  ];
  const ws0 = XLSX.utils.aoa_to_sheet(overview);
  ws0["!cols"] = [{ wch: 46 }, { wch: 62 }];
  XLSX.utils.book_append_sheet(wb, ws0, "Overview");
  sheetRows.push(overview.length);

  // ---- Card 1: Location x Status ------------------------------------------
  const st = summary.byStatus;
  const statusAoa: AOA = [
    ["Location × Status — active population"],
    [],
    ["Location", ...st.buckets.map((b) => st.labels[b] ?? b), "Pipeline", "Active", "Inactive", "Total"],
    ...summary.locations.map((loc) => {
      const r = st.rows.find((x) => x.location === loc.id);
      return [
        loc.label,
        ...st.buckets.map((b) => (r as unknown as Record<string, number>)?.[b] ?? 0),
        r?.pipeline ?? 0, r?.active ?? 0, r?.inactive ?? 0, r?.total ?? 0,
      ] as (string | number)[];
    }),
    ["All locations",
      ...st.buckets.map((b) => (st.totals as unknown as Record<string, number>)[b] ?? 0),
      st.totals.pipeline, st.totals.active, st.totals.inactive, st.totals.total],
  ];
  addSheet(wb, CARDS[0].sheet, statusAoa, sheetRows);

  // ---- Cards 2, 3: location-keyed cross-tabs -------------------------------
  const locationCrossTab = (
    title: string, columns: readonly string[], labels: Record<string, string> | undefined,
    rows: { location: string; counts: Record<string, number>; other: number; unknown: number; total: number }[],
    totals: { counts: Record<string, number>; other: number; unknown: number; total: number },
    scope: CardScope,
  ): AOA => {
    const showUnknown = totals.unknown > 0;
    const header = ["Location", ...columns.map((c) => labels?.[c] ?? c), "Other / Unmapped",
      ...(showUnknown ? ["Unknown"] : []), "Total"];
    return [
      [title],
      [`Scope: ${SCOPE_LABEL[scope]}`],
      [],
      header,
      ...summary.locations.map((loc) => {
        const r = rows.find((x) => x.location === loc.id);
        return [
          loc.label,
          ...columns.map((c) => r?.counts[c] ?? 0),
          r?.other ?? 0, ...(showUnknown ? [r?.unknown ?? 0] : []), r?.total ?? 0,
        ] as (string | number)[];
      }),
      ["All locations", ...columns.map((c) => totals.counts[c] ?? 0),
        totals.other, ...(showUnknown ? [totals.unknown] : []), totals.total],
    ];
  };

  const svcSet = setOf("serviceType");
  addSheet(wb, CARDS[1].sheet, locationCrossTab(
    "Location × Service Type", svcSet.byServiceType.columns, svcSet.byServiceType.labels,
    svcSet.byServiceType.rows, svcSet.byServiceType.totals, scopeOf("serviceType"),
  ), sheetRows);

  const insSet = setOf("insurance");
  addSheet(wb, CARDS[2].sheet, locationCrossTab(
    "Location × Insurance", insSet.byInsurance.columns, undefined,
    insSet.byInsurance.rows, insSet.byInsurance.totals, scopeOf("insurance"),
  ), sheetRows);

  // ---- Card 4: Service Type x Insurance (no location axis) -----------------
  const stiSet = setOf("serviceTypeInsurance");
  const sti = stiSet.byServiceTypeInsurance;
  const stiShowUnknown = sti.totals.unknown > 0;
  const stiAoa: AOA = [
    ["Service Type × Insurance"],
    [`Scope: ${SCOPE_LABEL[scopeOf("serviceTypeInsurance")]}`],
    [],
    ["Service type", ...sti.columns, "Other / Unmapped",
      ...(stiShowUnknown ? ["Unknown"] : []), "Total"],
    ...sti.rows.map((r) => [
      r.label, ...sti.columns.map((c) => r.counts[c] ?? 0),
      r.other, ...(stiShowUnknown ? [r.unknown] : []), r.total,
    ] as (string | number)[]),
    ["All service types", ...sti.columns.map((c) => sti.totals.counts[c] ?? 0),
      sti.totals.other, ...(stiShowUnknown ? [sti.totals.unknown] : []), sti.totals.total],
  ];
  addSheet(wb, CARDS[3].sheet, stiAoa, sheetRows);

  // ---- Card 5: Location x Origin ------------------------------------------
  const oSet = setOf("origin");
  const og = oSet.byOrigin;
  const originAoa: AOA = [
    ["Location × Referral Origin"],
    [`Scope: ${SCOPE_LABEL[scopeOf("origin")]}`],
    [],
    ["Location", ...og.columns.map((c) => og.labels[c] ?? c), "Total"],
    ...summary.locations.map((loc) => {
      const r = og.rows.find((x) => x.location === loc.id);
      return [loc.label,
        ...og.columns.map((c) => (r as unknown as Record<string, number>)?.[c] ?? 0),
        r?.total ?? 0] as (string | number)[];
    }),
    ["All locations", ...og.columns.map((c) => (og.totals as unknown as Record<string, number>)[c] ?? 0),
      og.totals.total],
  ];
  addSheet(wb, CARDS[4].sheet, originAoa, sheetRows);

  // ---- Write, then inject the chart pictures -------------------------------
  let buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  let imagesEmbedded = 0;

  const images: SheetImage[] = [];
  for (const img of req.images ?? []) {
    const cardIndex = CARDS.findIndex((c) => c.key === img.card);
    if (cardIndex < 0) { warnings.push(`Unknown card "${img.card}" — image skipped`); continue; }
    try {
      const png = Buffer.from(img.base64, "base64");
      // PNG magic number. Buffer.from(..., "base64") silently yields garbage for
      // invalid input rather than throwing, and embedding garbage makes Excel
      // declare the whole workbook corrupt — worse than having no picture.
      const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 &&
        png[2] === 0x4e && png[3] === 0x47;
      if (!isPng) {
        warnings.push(`Chart image for "${img.card}" was not a valid PNG — table exported without it`);
        continue;
      }
      images.push({
        // +2: SheetJS sheet parts are 1-based and the Overview sheet is first.
        sheetIndex: cardIndex + 2,
        png: new Uint8Array(png),
        fromCol: 0,
        fromRow: sheetRows[cardIndex + 1] + 2,
        widthPx: Math.min(img.widthPx || 720, 1400),
        heightPx: Math.min(img.heightPx || 300, 1400),
      });
    } catch {
      warnings.push(`Chart image for "${img.card}" could not be decoded — table exported without it`);
    }
  }

  if (images.length > 0) {
    try {
      buffer = Buffer.from(embedImages(new Uint8Array(buffer), images));
      imagesEmbedded = images.length;
    } catch (error) {
      // A picture failing must never cost the client the numbers. Ship the
      // workbook without images and say so.
      const message = error instanceof Error ? error.message : "unknown error";
      warnings.push(`Chart images could not be embedded (${message}) — tables exported without them`);
      buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    }
  }

  const ts = generated.toISOString().slice(0, 10);
  return {
    buffer,
    filename: `TFC-Dashboard-${ts}.xlsx`,
    imagesEmbedded,
    warnings,
  };
}

function addSheet(wb: XLSX.WorkBook, name: string, aoa: AOA, sheetRows: number[]): void {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 24 }, ...Array.from({ length: 24 }, () => ({ wch: 14 }))];
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31)); // Excel caps at 31 chars
  sheetRows.push(aoa.length);
}
