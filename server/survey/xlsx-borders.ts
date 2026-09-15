/**
 * Thin borders and bold headers, written into a SheetJS workbook by hand.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The client, on the workbook: "is there any way to have it throw formatting
 * lines on there, like grid lines? Because it makes it a lot easier to see.
 * Even just that without colors looks put together."
 *
 * He is not asking for Excel's worksheet grid, which is already on — neither the
 * generated file nor his own template sets showGridLines, so both inherit
 * Excel's default. What his template has and ours did not is 39 real thin CELL
 * borders drawn round its tables. That is what reads as "put together", and it
 * is a different feature with the same name.
 *
 * SheetJS (community) writes neither. Verified against raw XML rather than its
 * own reader, which is not to be trusted here — it drops formula cells that
 * carry no cached value, so it under-reports what was actually written. Given a
 * cell with `s: { font: { bold: true }, border: {...} }` the emitted file
 * contains `<fonts count="1">`, `<borders count="1">` and `<cellXfs count="1">`:
 * the style object is dropped whole, and the cell gets no `s` attribute at all.
 *
 * So the same technique the dashboard export already uses for chart images
 * (server/dashboard/xlsx-images.ts) applies here: an .xlsx is a ZIP of XML, and
 * this reopens the one SheetJS produced and amends a single part.
 *
 * WHY THIS NEEDS NO CELL-LEVEL EDITS FOR BORDERS
 * ----------------------------------------------
 * Every cell points at a cellXfs entry, explicitly or by defaulting to 0. Give
 * EVERY existing entry a border and every cell that exists gains one — and only
 * cells that exist, since a blank cell is absent from sheetData entirely. "Every
 * populated cell" falls out of the file's own structure rather than from walking
 * it. See extendStyles() for why the entries are amended rather than rewritten.
 *
 * Bold is the exception and does need the header cells named, because a header
 * has to differ from the cell under it. The builder already knows which those
 * are — SheetWriter.header() is a distinct method — so they are collected there
 * and passed in rather than guessed at from position.
 *
 * NOTHING ABOUT CONTENT CHANGES. No formula, value, range, width or merge is
 * touched. The only edit to a worksheet part is adding an `s` attribute to the
 * header cells; scripts/test-survey-borders.ts asserts the sheets are otherwise
 * byte-identical with those attributes stripped.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

/** Which cells on which sheet get the bold header style. */
export interface HeaderRefs {
  /** 1-based sheet index, matching SheetJS's `xl/worksheets/sheetN.xml`. */
  sheetIndex: number;
  /** A1 references. */
  refs: string[];
}

/**
 * Extend the style table SheetJS wrote, rather than replacing it.
 *
 * REPLACING IT WAS A BUG, and a silent one. The first version of this assumed
 * two existing cell formats — general and 0.00 — and wrote a fresh table of
 * three. There are actually THREE already (general, 0.00 for the ratings, 0%
 * for the completion percentage), so index 2 meant "percentage" to every cell
 * that already pointed at it and "bold" to the new table. Every rating cell
 * came out bold and the percentages would have lost their format. The test
 * caught it; nothing shipped.
 *
 * So nothing is assumed about what is there. Each existing `<xf>` keeps its own
 * numFmtId and gains a border; the bold format is APPENDED, so its index is
 * whatever comes next and no existing cell's meaning moves.
 */
function extendStyles(xml: string): { styles: string; headerXf: number } | null {
  const borders = /<borders[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/borders>/.exec(xml);
  const fonts = /<fonts[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/fonts>/.exec(xml);
  const xfs = /<cellXfs[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!borders || !fonts || !xfs) return null;

  // --- a thin border, appended -------------------------------------------
  const borderCount = Number(borders[1]);
  const thin =
    `<border><left style="thin"><color indexed="64"/></left>` +
    `<right style="thin"><color indexed="64"/></right>` +
    `<top style="thin"><color indexed="64"/></top>` +
    `<bottom style="thin"><color indexed="64"/></bottom><diagonal/></border>`;
  const borderId = borderCount;
  const newBorders = `<borders count="${borderCount + 1}">${borders[2]}${thin}</borders>`;

  // --- a bold font, appended ---------------------------------------------
  const fontCount = Number(fonts[1]);
  const fontId = fontCount;
  const boldFont =
    `<font><b/><sz val="12"/><color theme="1"/><name val="Calibri"/>` +
    `<family val="2"/><scheme val="minor"/></font>`;
  const newFonts = `<fonts count="${fontCount + 1}">${fonts[2]}${boldFont}</fonts>`;

  // --- every existing xf gains the border, keeping its own number format ---
  const existing = xfs[2].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) ?? [];
  const bordered = existing.map((xf) => {
    let out = xf.replace(/\sborderId="\d+"/, ` borderId="${borderId}"`);
    if (!/\sborderId="/.test(out)) {
      out = out.replace(/^<xf\b/, `<xf borderId="${borderId}"`);
    }
    if (!/\sapplyBorder="1"/.test(out)) {
      out = out.replace(/(\/>|>)$/, ` applyBorder="1"$1`);
    }
    return out;
  });

  // --- the bold format, appended, so no existing index shifts -------------
  const headerXf = bordered.length;
  bordered.push(
    `<xf numFmtId="0" fontId="${fontId}" fillId="0" borderId="${borderId}" xfId="0" ` +
    `applyFont="1" applyBorder="1"/>`,
  );
  const newXfs = `<cellXfs count="${bordered.length}">${bordered.join("")}</cellXfs>`;

  const styles = xml
    .replace(borders[0], newBorders)
    .replace(fonts[0], newFonts)
    .replace(xfs[0], newXfs);
  return { styles, headerXf };
}

/**
 * Point one cell at the header style.
 *
 * Rewrites only the `s` attribute on that one `<c>` element, leaving its type,
 * formula and value exactly as written. A cell that is not present — a header
 * whose text was empty — is skipped rather than invented.
 */
function applyHeaderStyle(xml: string, refs: string[], headerXf: number): string {
  let out = xml;
  for (const ref of refs) {
    const re = new RegExp(`<c r="${ref}"([^>]*?)(/?)>`);
    out = out.replace(re, (whole, attrs: string, selfClose: string) => {
      const cleaned = attrs.replace(/\s+s="\d+"/, "");
      return `<c r="${ref}"${cleaned} s="${headerXf}"${selfClose}>`;
    });
  }
  return out;
}

/**
 * Add thin borders to every populated cell, and bold to the named headers.
 *
 * Returns the workbook unchanged if it does not look like one, rather than
 * producing something Excel will call corrupt.
 */
export function addBordersAndBoldHeaders(buf: Uint8Array, headers: HeaderRefs[]): Uint8Array {
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(buf);
  } catch {
    return buf;
  }
  if (!zip["xl/workbook.xml"]) return buf;

  const stylesPart = zip["xl/styles.xml"];
  if (!stylesPart) return buf;
  const extended = extendStyles(strFromU8(stylesPart));
  // A styles part this cannot parse is left alone rather than replaced with a
  // guess — a workbook with no borders is a cosmetic shortfall, one Excel calls
  // corrupt is not.
  if (!extended) return buf;

  const out: Record<string, Uint8Array> = { ...zip };
  out["xl/styles.xml"] = strToU8(extended.styles);

  for (const h of headers) {
    const path = `xl/worksheets/sheet${h.sheetIndex}.xml`;
    if (!out[path] || h.refs.length === 0) continue;
    out[path] = strToU8(applyHeaderStyle(strFromU8(out[path]), h.refs, extended.headerXf));
  }

  return zipSync(out);
}
