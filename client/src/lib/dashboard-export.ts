/**
 * Dashboard Excel export — the browser half.
 *
 * WHY THE IMAGES ARE MADE HERE AND NOT ON THE SERVER
 * --------------------------------------------------
 * The charts only exist in the browser: recharts renders live SVG into the DOM.
 * Reproducing them server-side would mean either a headless browser (explicitly
 * off the table, and a heavy dependency for a screenshot) or a second charting
 * implementation that would drift from the one on screen. Rasterising the SVG
 * that is already rendered is both cheaper and guaranteed to match what the
 * client is looking at, which is his whole mental model for this feature.
 *
 * NO LIBRARY IS USED. recharts emits SVG, and SVG -> canvas -> PNG is native
 * browser API. html2canvas happens to be installed transitively but is not
 * needed and is not imported.
 *
 * THE NUMBERS DO NOT TRAVEL. Only pictures and the current view settings go up;
 * the server re-reads every figure from the same pivot the cards render, so the
 * workbook cannot disagree with the screen.
 */

import type { CardScope, Population } from "./dashboard-api";

/** Cards that can contribute a chart image, in workbook order. */
export const EXPORT_CARD_KEYS = [
  "status", "serviceType", "insurance", "serviceTypeInsurance", "origin",
] as const;
export type ExportCardKey = (typeof EXPORT_CARD_KEYS)[number];

/** Properties that must be resolved before an SVG can stand alone. */
const INLINE_PROPS = [
  "fill", "stroke", "stroke-width", "stroke-dasharray", "opacity",
  "fill-opacity", "stroke-opacity", "font-family", "font-size", "font-weight",
] as const;

/**
 * Copy computed styles from the live tree onto the clone.
 *
 * Necessary because the chart's colours are CSS custom properties
 * (`hsl(var(--chart-1))`). Those resolve against the document; a serialised SVG
 * has no document, so every bar would come out black. Walking both trees in
 * step and writing the RESOLVED value as a presentation attribute is what makes
 * the exported picture look like the one on screen.
 */
function inlineComputedStyles(live: Element, clone: Element): void {
  const computed = window.getComputedStyle(live);
  for (const prop of INLINE_PROPS) {
    const value = computed.getPropertyValue(prop);
    if (value && value !== "none" && value !== "normal") {
      clone.setAttribute(prop, value.trim());
    }
  }
  const liveKids = live.children;
  const cloneKids = clone.children;
  for (let i = 0; i < liveKids.length && i < cloneKids.length; i++) {
    inlineComputedStyles(liveKids[i], cloneKids[i]);
  }
}

export interface RenderedChart {
  card: ExportCardKey;
  base64: string;
  widthPx: number;
  heightPx: number;
}

/**
 * Rasterise one card's chart to a PNG.
 * Resolves to null when the card has no chart on screen (the graph view is
 * toggled off, or the card is empty) — a missing picture must never fail the
 * export, because the tables are the part that matters.
 */
export async function renderCardChart(card: ExportCardKey): Promise<RenderedChart | null> {
  const host = document.querySelector<HTMLElement>(`[data-chart-card="${card}"]`);
  const svg = host?.querySelector("svg");
  if (!svg) return null;

  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (width < 2 || height < 2) return null;

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  inlineComputedStyles(svg, clone);

  // A white plate behind the chart: the page background is a CSS variable that
  // does not survive serialisation, and a transparent PNG on Excel's grid is
  // unreadable in dark mode.
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0"); bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width)); bg.setAttribute("height", String(height));
  bg.setAttribute("fill", "#ffffff");
  clone.insertBefore(bg, clone.firstChild);

  const svgText = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("SVG rasterisation failed"));
      el.src = url;
    });

    // 2x for a crisp picture in Excel without a large file.
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1];
    if (!base64) return null;
    return { card, base64, widthPx: width, heightPx: height };
  } catch {
    return null; // table-only for this card; the export still ships
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Build and download the workbook for the CURRENT view.
 * Returns how many charts made it in, so the UI can say so.
 */
export async function exportDashboardWorkbook(params: {
  population: Population;
  scopes: Partial<Record<ExportCardKey, CardScope>>;
}): Promise<{ imagesRequested: number; ok: boolean }> {
  const rendered: RenderedChart[] = [];
  for (const card of EXPORT_CARD_KEYS) {
    const shot = await renderCardChart(card);
    if (shot) rendered.push(shot);
  }

  const res = await fetch("/api/dashboard/export.xlsx", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      population: params.population,
      scopes: params.scopes,
      images: rendered,
    }),
  });
  if (!res.ok) return { imagesRequested: rendered.length, ok: false };

  // Same download mechanism the Insights export uses.
  const blob = await res.blob();
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `TFC-Dashboard-${ts}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { imagesRequested: rendered.length, ok: true };
}
