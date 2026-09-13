/**
 * Survey export — the workbook builder.
 * ============================================================================
 *
 * LAYOUT ONLY. Every number here was computed by ./aggregate.ts; this file
 * places values in cells and writes the client's own formulas over them. It
 * recomputes nothing.
 *
 * WHAT IS A FORMULA AND WHAT IS A VALUE
 * -------------------------------------
 * The client was explicit that the workbook's formulas are correct and should
 * be used, so the office rollups, the Total row and the completion percentage
 * are written as Excel formulas — he can open the file and see his own
 * arithmetic. Everything else was already computed and is written as a value.
 *
 * RANGES ARE GENERATED, NEVER TRANSCRIBED
 * ---------------------------------------
 * This is the one thing in the workbook that fails silently. The template
 * hardcodes `=AVERAGE(F4:F11)` for ABQ's eight rows; add a provider and that
 * range is wrong but the file still opens and still shows a number, with the
 * new provider's row folded into another office's average. So no range is ever
 * copied from the template: rows are laid out first, each office's first and
 * last row is recorded as it is written (see OfficeBlock), and every formula is
 * built from those recorded bounds. scripts/test-survey-workbook.ts inserts a
 * synthetic 27th provider and asserts every rollup still covers its own block
 * and no other — that test is the safeguard.
 *
 * THREE OFFICES, NOT FOUR. The template shows a Corp row holding two providers
 * who are both stored as ABQ, and Corp cannot be entered in the CRM at all.
 * Offices come from the aggregate, so this builds whatever the data carries.
 *
 * NO FILL COLOURS. SheetJS (community) writes formulas and merges but silently
 * drops every fill — verified. On a provider tab the office was conveyed ONLY
 * by the fill on the name cell, so it becomes a labelled text cell instead
 * (B1/C1). The template's yellow developer notes are not reproduced at all;
 * they are notes to us and the client said they must not appear.
 *
 * TOTAL ACTIVE CLIENTS SHIPS BLANK, and the percentage that divides by it is
 * OMITTED rather than written. That is what the client's own template does on
 * 25 of its 26 provider tabs, and writing `=D2/C2` against a blank denominator
 * would put #DIV/0! on every row of the analysis sheet.
 */

import * as XLSX from "xlsx";
import {
  MAX_SHEET_NAME_LENGTH,
  FORBIDDEN_SHEET_NAME_CHARS,
} from "@shared/provider-short-name";
import {
  SCALE_KEYS,
  TELEHEALTH_BUCKET,
  UNKNOWN_OFFICE,
  scaleQuestionsFor,
  type NegativeListing,
  type ProviderAggregate,
  type QuestionBreakdown,
  type SurveyAggregate,
} from "./aggregate";

// ============================================================================
// The one decision point for each open client question
// ============================================================================

/**
 * Which questions may put a row on a provider tab.
 *
 * OPEN WITH THE CLIENT. His note says only responses "with comments" belong,
 * but clients can now comment on eleven questions while the column headed
 * "Number Score" only makes sense for the four rated 0-10. His example rows
 * show only those four.
 *
 * Default is "all", the superset: a comment on "Were you greeted upon arrival?"
 * is exactly the feedback a provider tab should surface, and a non-rated row
 * simply leaves Number Score blank. Switching to the narrow reading is this one
 * constant — no other line moves.
 */
export type ListingMode = "all" | "rated-only";
export const LISTING_MODE: ListingMode = "all";

/**
 * Whether the Yes/No count tables carry an N/A column.
 *
 * OPEN WITH THE CLIENT. The instrument offers Yes/No/N-A on four questions per
 * modality and the aggregate counts all three, but every Yes/No table in the
 * template has two columns. Default matches the template.
 *
 * Turning this on needs no re-layout: table widths are measured from the option
 * list at write time and the right-hand table's column offset is computed from
 * the left-hand table's actual width, so an extra column shifts what follows
 * instead of colliding with it.
 */
export const INCLUDE_NA_COLUMN = false;

/**
 * A count table this wide or narrower may share a band with the next one. The
 * Yes/No tables are 3 columns (Office + Yes + No); the satisfaction tables are
 * 6 and stand alone, exactly as the client's template arranges them.
 */
const NARROW_TABLE_MAX = 4;

/** Office row order. Anything the data carries beyond these sorts after. */
const OFFICE_ORDER = ["ABQ", "LL", "RR"];

/** Label for the bucket holding rows whose office could not be determined. */
const UNKNOWN_OFFICE_LABEL = "No office";

// ============================================================================
// Cell plumbing
// ============================================================================

/**
 * The client's template formats every rating column with the built-in `0.00`
 * (numFmtId 2). Raw means print as 7.857142857142857 otherwise, which is the
 * single ugliest thing in the generated file.
 */
const RATING_FORMAT = "0.00";

/** The template formats the completion percentage with the built-in `0%`. */
const PERCENT_FORMAT = "0%";

/** Beyond this many days between the reading and the period end, say so loudly. */
const STALE_AFTER_DAYS = 35;

/**
 * Widest a column a HEADER alone may force. The template wraps its headers and
 * keeps these columns 12-18 wide; without wrap-text, measuring the full string
 * would widen a column far past its data.
 */
const HEADER_MAX_WIDTH = 22;

/** Narrowest a column may be, so a one-character header still reads. */
const MIN_WIDTH = 9;

/**
 * Widest a column may be. The comment columns hold free text up to 1000
 * characters and the library cannot write wrap-text, so a comment runs on one
 * line however wide the column is; 60 is enough to read the opening of one
 * without pushing every other column off the screen. The template's widest is
 * 30, on the same columns.
 */
const MAX_WIDTH = 60;

type Cell = XLSX.CellObject;
type SheetData = Record<string, Cell | unknown>;

function a1(col: number, row: number): string {
  let s = "";
  let c = col;
  do { s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26) - 1; } while (c >= 0);
  return `${s}${row + 1}`;
}

class SheetWriter {
  private data: SheetData = {};
  private merges: XLSX.Range[] = [];
  private widths: Record<number, number> = {};
  private maxCol = 0;
  private maxRow = 0;

  private touch(col: number, row: number): void {
    if (col > this.maxCol) this.maxCol = col;
    if (row > this.maxRow) this.maxRow = row;
  }

  /** A string cell. Empty strings are skipped so a blank stays truly blank. */
  text(col: number, row: number, value: string | null | undefined): void {
    const v = (value ?? "").toString();
    this.touch(col, row);
    if (v === "") return;
    this.data[a1(col, row)] = { t: "s", v };
    // Only the first line of a multi-line comment drives the width; the library
    // cannot write wrap-text, so the rest would never be visible anyway.
    this.widen(col, v.split("\n")[0].length);
  }

  /**
   * A column header. Measured like any text, but capped: the client's template
   * WRAPS its headers, so "% of Clients who Completed Survey " sits happily
   * over a 15-wide column there. The library cannot write wrap-text, so an
   * unmodified measurement gives a 37-wide column — over a column that is
   * deliberately empty, at that.
   */
  header(col: number, row: number, value: string): void {
    const v = (value ?? "").toString();
    this.touch(col, row);
    if (v === "") return;
    this.data[a1(col, row)] = { t: "s", v };
    this.widen(col, Math.min(v.length, HEADER_MAX_WIDTH));
  }

  /**
   * A heading or label that spans a table: written, merged across `span`
   * columns, and DELIBERATELY NOT MEASURED.
   *
   * Measuring it is the bug this exists to prevent. A question prompt like "Was
   * the facility clean and inviting?" sits in the same column as the Location
   * values beneath it, so letting it set the width gives a 60-character column
   * holding the word "ABQ". The template merges these for the same reason.
   */
  banner(col: number, row: number, value: string, span: number): void {
    const v = (value ?? "").toString();
    this.touch(col, row);
    if (v === "") return;
    this.data[a1(col, row)] = { t: "s", v };
    if (span > 1) this.merge(col, row, col + span - 1, row);
  }

  /**
   * A numeric cell. NULL is skipped — an absent average must stay absent.
   *
   * `fmt` is an Excel number-format code. SheetJS writes these from the cell's
   * `z` property even though it drops every other style: verified, `z: "0.00"`
   * emits numFmtId="2", the same built-in the client's template applies to the
   * rating columns.
   */
  num(col: number, row: number, value: number | null | undefined, fmt?: string): void {
    this.touch(col, row);
    if (value === null || value === undefined || !isFinite(value)) return;
    const cell: Cell = { t: "n", v: value };
    if (fmt) cell.z = fmt;
    this.data[a1(col, row)] = cell;
    this.widen(col, fmt === RATING_FORMAT ? 6 : String(value).length);
  }

  /** A formula cell. Written without a cached value; Excel computes on open. */
  formula(col: number, row: number, f: string, fmt?: string): void {
    this.touch(col, row);
    const cell: Cell = { t: "n", f };
    if (fmt) cell.z = fmt;
    this.data[a1(col, row)] = cell;
  }

  /**
   * Widths are MEASURED, not declared, for the same reason formula ranges are:
   * a hardcoded width goes wrong the moment the content changes, and a comment
   * column is the one place where that is guaranteed. Each column grows to its
   * widest cell, then MAX_WIDTH caps it — a 1000-character comment must not
   * produce a 1000-character column.
   */
  private widen(col: number, chars: number): void {
    const want = Math.min(Math.max(chars + 2, MIN_WIDTH), MAX_WIDTH);
    if (!this.widths[col] || this.widths[col] < want) this.widths[col] = want;
  }

  merge(col: number, row: number, colEnd: number, rowEnd: number): void {
    this.touch(colEnd, rowEnd);
    this.merges.push({ s: { c: col, r: row }, e: { c: colEnd, r: rowEnd } });
  }

  /** Force a column at least this wide, for one the content under-measures. */
  atLeast(col: number, chars: number): void { this.widen(col, chars); }

  finish(): XLSX.WorkSheet {
    const ws = this.data as XLSX.WorkSheet;
    ws["!ref"] = `A1:${a1(this.maxCol, this.maxRow)}`;
    if (this.merges.length > 0) ws["!merges"] = this.merges;
    const cols: XLSX.ColInfo[] = [];
    for (let c = 0; c <= this.maxCol; c++) cols.push({ wch: this.widths[c] ?? MIN_WIDTH });
    ws["!cols"] = cols;
    return ws;
  }
}

// ============================================================================
// Sheet names
// ============================================================================

/**
 * A legal, unique worksheet name.
 *
 * A DUPLICATE CANNOT BE PREVENTED UPSTREAM. crm_providers carries a unique
 * index on short_name, but a provider with no stored name falls back to their
 * first name and that fallback is computed, never written — so two providers
 * both called "Amber" collide with nothing for the index to see. The builder
 * therefore has to de-duplicate regardless.
 *
 * The rule: strip forbidden characters, trim, drop leading/trailing
 * apostrophes, avoid the reserved name "History", cap at 31, and on a
 * case-insensitive collision append " 2", " 3" … shortening the base as needed
 * so the suffix always fits. A user sees "Amber" and "Amber 2" — the first
 * provider in roster order keeps the plain name.
 */
export function sheetNameFor(desired: string, taken: string[]): string {
  let base = (desired ?? "").toString();
  FORBIDDEN_SHEET_NAME_CHARS.forEach((c) => { base = base.split(c).join(""); });
  base = base.replace(/^'+/, "").replace(/'+$/, "").trim();
  if (base === "") base = "Provider";
  if (base.toLowerCase() === "history") base = "History (provider)";
  base = base.slice(0, MAX_SHEET_NAME_LENGTH).trim();

  const lower = taken.map((t) => t.toLowerCase());
  if (lower.indexOf(base.toLowerCase()) === -1) return base;

  for (let i = 2; i < 1000; i++) {
    const suffix = ` ${i}`;
    const trimmed = base.slice(0, MAX_SHEET_NAME_LENGTH - suffix.length).trim();
    const candidate = `${trimmed}${suffix}`;
    if (lower.indexOf(candidate.toLowerCase()) === -1) return candidate;
  }
  return base.slice(0, MAX_SHEET_NAME_LENGTH - 6) + ` ${Date.now() % 10000}`;
}

// ============================================================================
// Survey Analysis
// ============================================================================

/**
 * What the workbook says about its own denominator.
 *
 * SHOWN WITH ITS AGE, ALWAYS. A count is read overnight and a report may be run
 * weeks later; showing the number with no indication of when it was taken is the
 * one option that is not defensible. So the reading date is printed whether it
 * is a day old or a month, and a gap past STALE_AFTER_DAYS says so in words
 * rather than leaving the reader to do the subtraction.
 */
function activeCountsNote(
  counts: ActiveClientCounts, periodEnd: string, rowsWithCount: number, providerRows: number,
): string {
  if (rowsWithCount === 0 || !counts.newestCapturedOn) {
    return "Not available for this period. Active client counts are read from TherapyNotes " +
      "overnight; none had been taken on or before this period ended, so this column and the " +
      "% of Clients who Completed Survey column are both left blank.";
  }
  const days = Math.round(
    (Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${counts.newestCapturedOn}T00:00:00Z`))
    / 86_400_000,
  );
  const base =
    `Read from TherapyNotes on ${counts.newestCapturedOn}, ${days} day${days === 1 ? "" : "s"} ` +
    `before this period ended. Counts for ${rowsWithCount} of ${providerRows} provider(s); any ` +
    `provider without one is left blank rather than shown as zero, and an office or practice ` +
    `total is shown only when every provider in it has a count — a partial total would divide ` +
    `all the surveys by only some of the clients.`;
  return days > STALE_AFTER_DAYS
    ? `${base} NOTE: that reading is more than ${STALE_AFTER_DAYS} days older than the period end, ` +
      `so the percentages should be treated as approximate.`
    : base;
}

/** Where one office's provider rows actually landed. 0-based, inclusive. */
interface OfficeBlock {
  office: string; first: number; last: number; count: number;
  /** How many of this office's providers carry an active-client count. */
  withCount: number;
}

const ANALYSIS_HEADERS = [
  "Providers", "Office", "Total Active Clients", "Total Surveys Completed",
  "% of Clients who Completed Survey ", "Relationship", "Goals & Topics",
  "Approach or Method", "Overall",
];
const ROLLUP_HEADERS = ["Office", ...ANALYSIS_HEADERS.slice(2)];

/** Column indexes on the per-provider table. */
const C_ACTIVE = 2, C_SURVEYS = 3, C_PCT = 4, C_FIRST_RATING = 5;

function officeLabel(office: string): string {
  return office === UNKNOWN_OFFICE ? UNKNOWN_OFFICE_LABEL : office;
}

function orderedOffices(agg: SurveyAggregate): string[] {
  const present: string[] = [];
  agg.providers.forEach((p) => { if (present.indexOf(p.office) === -1) present.push(p.office); });
  agg.offices.forEach((o) => { if (present.indexOf(o) === -1) present.push(o); });
  return present.sort((a, b) => {
    const ia = OFFICE_ORDER.indexOf(a), ib = OFFICE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    if (a === UNKNOWN_OFFICE) return 1;
    if (b === UNKNOWN_OFFICE) return -1;
    return a.localeCompare(b);
  });
}

function buildSurveyAnalysis(agg: SurveyAggregate, counts: ActiveClientCounts): XLSX.WorkSheet {
  const s = new SheetWriter();
  ANALYSIS_HEADERS.forEach((h, i) => s.header(i, 0, h));
  ROLLUP_HEADERS.forEach((h, i) => s.header(11 + i, 0, h));

  const offices = orderedOffices(agg);
  const blocks: OfficeBlock[] = [];
  let row = 1;
  // How many provider rows carry a denominator. Zero means the C column is
  // empty, and every percentage formula above it must stay unwritten.
  let rowsWithCount = 0;

  offices.forEach((office) => {
    const inOffice = agg.providers.filter((p) => p.office === office);
    const first = row;
    inOffice.forEach((p) => {
      s.text(0, row, p.shortName);
      s.text(1, row, officeLabel(p.office));
      s.num(C_SURVEYS, row, p.surveyCount);
      // Total Active Clients, and the percentage that divides by it. BOTH or
      // NEITHER: a formula written against a blank denominator is #DIV/0! on
      // every row, which is worse than an empty cell and is exactly what the
      // client's own template leaves blank on 25 of its 26 tabs.
      const known = p.providerId === null ? undefined : counts.byProviderId[p.providerId];
      if (known) {
        s.num(C_ACTIVE, row, known.count);
        s.formula(C_PCT, row, `${a1(C_SURVEYS, row)}/${a1(C_ACTIVE, row)}`, PERCENT_FORMAT);
        rowsWithCount++;
      }
      SCALE_KEYS.forEach((k, i) => s.num(C_FIRST_RATING + i, row, p.averages[k], RATING_FORMAT));
      row++;
    });
    blocks.push({
      office, first, last: row - 1, count: inOffice.length,
      withCount: inOffice.filter((p) =>
        p.providerId !== null && counts.byProviderId[p.providerId] !== undefined).length,
    });
  });

  const firstProviderRow = 1;
  const lastProviderRow = row - 1;
  const providerRows = agg.providers.length;
  const totalRow = row;
  const hasProviders = lastProviderRow >= firstProviderRow;

  s.text(0, totalRow, "Total");
  if (hasProviders) {
    const span = (col: number) => `${a1(col, firstProviderRow)}:${a1(col, lastProviderRow)}`;
    s.formula(C_SURVEYS, totalRow, `SUM(${span(C_SURVEYS)})`);
    // A TOTAL NEEDS EVERY DENOMINATOR, not some of them. Summing the counts we
    // happen to have and dividing all the surveys by it silently INFLATES the
    // headline percentage — every survey counts, only some clients do. One
    // provider missing a count therefore leaves the practice total blank, which
    // is visible, rather than wrong, which is not.
    if (rowsWithCount === providerRows) {
      s.formula(C_ACTIVE, totalRow, `SUM(${span(C_ACTIVE)})`);
      s.formula(C_PCT, totalRow, `${a1(C_SURVEYS, totalRow)}/${a1(C_ACTIVE, totalRow)}`, PERCENT_FORMAT);
    }
    SCALE_KEYS.forEach((_, i) =>
      s.formula(C_FIRST_RATING + i, totalRow, `AVERAGE(${span(C_FIRST_RATING + i)})`, RATING_FORMAT));
  }

  // ---- office rollup, every range from a recorded block ----------------
  let rr = 1;
  blocks.forEach((b) => {
    s.text(11, rr, officeLabel(b.office));
    // An office with no providers gets its row and NO formula. A range built
    // over an empty block would wrap onto the next office's rows.
    if (b.count > 0) {
      const span = (col: number) => `${a1(col, b.first)}:${a1(col, b.last)}`;
      s.formula(13, rr, `SUM(${span(C_SURVEYS)})`);
      // Same rule per office: complete, or blank.
      if (b.withCount === b.count) {
        s.formula(12, rr, `SUM(${span(C_ACTIVE)})`);
        s.formula(14, rr, `${a1(13, rr)}/${a1(12, rr)}`, PERCENT_FORMAT);
      }
      SCALE_KEYS.forEach((_, i) =>
        s.formula(15 + i, rr, `AVERAGE(${span(C_FIRST_RATING + i)})`, RATING_FORMAT));
    }
    rr++;
  });
  s.text(11, rr, "Total");
  if (hasProviders) {
    s.formula(13, rr, a1(C_SURVEYS, totalRow));
    if (rowsWithCount === providerRows) {
      s.formula(12, rr, a1(C_ACTIVE, totalRow));
      s.formula(14, rr, `${a1(13, rr)}/${a1(12, rr)}`, PERCENT_FORMAT);
    }
    SCALE_KEYS.forEach((_, i) => s.formula(15 + i, rr, a1(C_FIRST_RATING + i, totalRow), RATING_FORMAT));
  }

  // ---- what this file covers, and why one column is empty ---------------
  // A saved workbook has to say what period it reports on, and the blank
  // Total Active Clients column is the first thing anyone will ask about. Both
  // sit clear of the rollup, which grows with the office count.
  let note = rr + 3;
  s.atLeast(12, 40);
  s.text(11, note, "Reporting period");
  s.text(12, note, `${agg.period.from} to ${agg.period.to}`);
  note++;
  s.text(11, note, "Generated");
  s.text(12, note, new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC");
  note += 2;
  s.text(11, note, "Total Active Clients");
  s.banner(12, note, activeCountsNote(counts, agg.period.to, rowsWithCount, providerRows), 6);

  return s.finish();
}

// ============================================================================
// In Person and TH Ratings
// ============================================================================

/** The options a count table shows. Narrows only when N/A is switched off. */
function visibleOptions(q: QuestionBreakdown): string[] {
  if (INCLUDE_NA_COLUMN) return q.options;
  return q.options.filter((o) => o !== "N/A");
}

/**
 * One count table. Returns its width and height so the caller can place the
 * next one relative to it — which is what lets an N/A column be added without
 * re-laying the sheet.
 */
function writeCountTable(
  s: SheetWriter, atCol: number, atRow: number,
  q: QuestionBreakdown, rowLabels: string[], bucketFor: (label: string) => string,
  withTotal: boolean,
): { width: number; height: number } {
  const options = visibleOptions(q);
  s.banner(atCol, atRow, q.prompt, options.length + 1);

  const headRow = atRow + 1;
  s.header(atCol, headRow, "Office");
  options.forEach((o, i) => s.header(atCol + 1 + i, headRow, o));

  const first = headRow + 1;
  rowLabels.forEach((label, i) => {
    const r = first + i;
    s.text(atCol, r, label);
    const counts = q.byBucket[bucketFor(label)] ?? {};
    options.forEach((o, j) => s.num(atCol + 1 + j, r, counts[o] ?? 0));
  });
  const last = first + rowLabels.length - 1;

  let height = last - atRow + 1;
  if (withTotal && rowLabels.length > 0) {
    const totalRow = last + 1;
    s.text(atCol, totalRow, "Total");
    options.forEach((_, j) => {
      const col = atCol + 1 + j;
      s.formula(col, totalRow, `SUM(${a1(col, first)}:${a1(col, last)})`);
    });
    height = totalRow - atRow + 1;
  }
  return { width: options.length + 1, height };
}

function buildRatingsSheet(agg: SurveyAggregate): XLSX.WorkSheet {
  const s = new SheetWriter();
  const offices = orderedOffices(agg);
  const officeRows = offices.map(officeLabel);
  const officeBucket: Record<string, string> = {};
  offices.forEach((o) => { officeBucket[officeLabel(o)] = o; });

  const inPerson = agg.ratings.filter((q) => q.modality === "In Person");
  const telehealth = agg.ratings.filter((q) => q.modality === "Telehealth");

  /**
   * Lay a modality's five tables the way the template does: the wide
   * satisfaction table gets a band to itself, and the narrow Yes/No tables pair
   * up two to a band. Purely to stop the sheet running to forty rows when the
   * client's own is under thirty.
   *
   * The pairing is decided from MEASURED width, not from a table's position, so
   * switching INCLUDE_NA_COLUMN on widens the Yes/No tables and they stop
   * pairing on their own rather than colliding.
   */
  function layout(
    tables: QuestionBreakdown[], atCol: number, rowLabels: string[],
    bucketFor: (label: string) => string, withTotal: boolean,
  ): number {
    let row = 2;
    let widest = 0;
    let i = 0;
    while (i < tables.length) {
      const left = writeCountTable(s, atCol, row, tables[i], rowLabels, bucketFor, withTotal);
      let bandWidth = left.width;
      let bandHeight = left.height;
      const nextIsNarrow =
        i + 1 < tables.length && left.width <= NARROW_TABLE_MAX &&
        visibleOptions(tables[i + 1]).length + 1 <= NARROW_TABLE_MAX;
      if (nextIsNarrow) {
        const rightCol = atCol + left.width + 1;
        const right = writeCountTable(s, rightCol, row, tables[i + 1], rowLabels, bucketFor, withTotal);
        bandWidth = left.width + 1 + right.width;
        bandHeight = Math.max(left.height, right.height);
        i += 2;
      } else {
        i += 1;
      }
      widest = Math.max(widest, bandWidth);
      row += bandHeight + 2;
    }
    return widest;
  }

  s.banner(0, 0, "IN PERSON", 1);
  const inPersonWidth = layout(inPerson, 0, officeRows, (l) => officeBucket[l], true);

  // The telehealth block starts one clear column after the widest in-person
  // band, so a widened table shifts this instead of colliding with it.
  const thCol = inPersonWidth + 2;
  s.banner(thCol, 0, "TELEHEALTH", 1);
  // Telehealth is location-agnostic: one bucket, and no Total row — matching
  // the template, where the TH tables carry neither.
  layout(telehealth, thCol, [TELEHEALTH_BUCKET], () => TELEHEALTH_BUCKET, false);

  return s.finish();
}

// ============================================================================
// Neutrals and Below
// ============================================================================

function writeNegativeBlock(
  s: SheetWriter, atCol: number, atRow: number, listing: NegativeListing,
  withLocation: boolean,
): { width: number; height: number } {
  let r = atRow;

  const headers = withLocation
    ? ["Location", "Provider", "Client Name", "Response", "Comments"]
    : ["Provider", "Client Name", "Response", "Comments"];

  s.banner(atCol, r, listing.prompt, headers.length + 1);
  r++;

  // Count rows, one per negative option, labelled as the template labels them.
  // The value sits one column PAST the listing headers, where the template puts
  // it — mid-table it reads as part of a row rather than as a total.
  Object.keys(listing.counts).forEach((option) => {
    s.banner(atCol, r, `Total "${option}" responses`, headers.length);
    s.num(atCol + headers.length, r, listing.counts[option]);
    r++;
  });

  headers.forEach((h, i) => s.header(atCol + i, r, h));
  r++;

  // Every row belongs here whether or not it carries a comment — the client's
  // note on this sheet is explicit, and it is the OPPOSITE of the provider-tab
  // rule. The two are deliberately not unified.
  listing.rows.forEach((row) => {
    const vals = withLocation
      ? [officeLabel(row.office), row.providerShortName, row.clientName, row.response, row.comment]
      : [row.providerShortName, row.clientName, row.response, row.comment];
    vals.forEach((v, i) => s.text(atCol + i, r, v));
    r++;
  });

  // +1: the count value sits one column past the headers.
  return { width: headers.length + 1, height: r - atRow };
}

function buildNeutralsSheet(agg: SurveyAggregate): XLSX.WorkSheet {
  const s = new SheetWriter();
  const inPerson = agg.negatives.filter((l) => l.modality === "In Person");
  const telehealth = agg.negatives.filter((l) => l.modality === "Telehealth");

  s.banner(0, 0, "IN-PERSON NEUTRALS OR BELOW", 1);
  let row = 1;
  let leftWidth = 0;
  inPerson.forEach((l) => {
    const { width, height } = writeNegativeBlock(s, 0, row, l, true);
    leftWidth = Math.max(leftWidth, width);
    row += height + 2;
  });

  const thCol = leftWidth + 2;
  s.banner(thCol, 0, "TELEHEALTH NEUTRALS OR BELOW", 1);
  row = 1;
  telehealth.forEach((l) => {
    // No Location column on the telehealth side — telehealth is one bucket, and
    // the template drops the column for the same reason.
    const { height } = writeNegativeBlock(s, thCol, row, l, false);
    row += height + 2;
  });

  return s.finish();
}

// ============================================================================
// Provider tabs
// ============================================================================

const RATED_KEYS: string[] = SCALE_KEYS;

function listingRowsFor(p: ProviderAggregate) {
  if (LISTING_MODE === "rated-only") {
    return p.listingRows.filter((r) => RATED_KEYS.indexOf(r.questionKey) !== -1);
  }
  return p.listingRows;
}

function buildProviderSheet(p: ProviderAggregate, known: number | undefined): XLSX.WorkSheet {
  const s = new SheetWriter();
  const ratingHeaders = scaleQuestionsFor("in-person").map((q) => {
    switch (q.key) {
      case "connectionRating": return "Relationship";
      case "goalsRating": return "Goals & Topics";
      case "approachRating": return "Approach or Method";
      default: return "Overall";
    }
  });

  // The office was conveyed only by a fill colour the library cannot write, so
  // it becomes a labelled cell on the otherwise-unused first row.
  s.text(1, 0, "Office");
  s.text(2, 0, p.office === UNKNOWN_OFFICE ? UNKNOWN_OFFICE_LABEL : p.office);

  s.text(1, 1, p.shortName);
  s.merge(1, 1, 4, 1);

  s.header(1, 2, "Total Surveys Completed");
  s.header(1, 3, "Total Active Clients");
  // Same both-or-neither rule as the analysis sheet: D3 (=C3/C4) is written only
  // when C4 carries a denominator. A provider with nothing gets the furniture
  // and no numbers, which is what 25 of the template's 26 tabs show.
  if (p.surveyCount > 0) s.num(2, 2, p.surveyCount);
  if (known !== undefined) {
    s.num(2, 3, known);
    if (p.surveyCount > 0) s.formula(3, 2, "C3/C4", PERCENT_FORMAT);
  }

  ratingHeaders.forEach((h, i) => s.header(1 + i, 4, h));
  if (p.surveyCount > 0) {
    SCALE_KEYS.forEach((k, i) => s.num(1 + i, 5, p.averages[k], RATING_FORMAT));
  }

  s.header(0, 7, "Name");
  s.header(1, 7, "Question");
  s.header(2, 7, "Number Score");
  s.header(3, 7, "Comments");
  s.merge(3, 7, 10, 7);

  // ONLY responses carrying a comment. The aggregate already holds exactly
  // those, so this is a pass-through plus the LISTING_MODE filter.
  listingRowsFor(p).forEach((r, i) => {
    const row = 8 + i;
    s.text(0, row, r.clientName);
    s.text(1, row, r.questionPrompt);
    if (r.score !== null) s.num(2, row, r.score);
    else s.text(2, row, r.answer ?? "");
    s.text(3, row, r.comment);
    s.merge(3, row, 10, row);
  });

  return s.finish();
}

// ============================================================================
// Assembly
// ============================================================================

/**
 * Provider id → the active client count to use, and the day it was read.
 *
 * Passed IN rather than looked up here: this file does no I/O, and the count is
 * selected as of the reporting period's end so a past report keeps returning the
 * same denominator.
 */
export interface ActiveClientCounts {
  byProviderId: Record<number, { count: number; capturedOn: string }>;
  /** Newest reading used anywhere in this workbook, for the staleness note. */
  newestCapturedOn: string | null;
}

export interface WorkbookResult {
  buffer: Buffer;
  sheetNames: string[];
  /** short name -> sheet name, where de-duplication changed it. */
  renamed: Record<string, string>;
}

const NO_COUNTS: ActiveClientCounts = { byProviderId: {}, newestCapturedOn: null };

export function buildSurveyWorkbook(
  agg: SurveyAggregate,
  counts: ActiveClientCounts = NO_COUNTS,
): WorkbookResult {
  const wb = XLSX.utils.book_new();
  const names: string[] = [];
  const renamed: Record<string, string> = {};

  function add(ws: XLSX.WorkSheet, name: string): void {
    XLSX.utils.book_append_sheet(wb, ws, name);
    names.push(name);
  }

  // The client left this sheet empty with only a note about what belongs on it,
  // and specified no columns. It carries ONE sentence saying so and no headers:
  // anyone opening a sheet called "Data" and finding it blank will assume the
  // export broke, and inventing columns to avoid that would be worse. The
  // sentence is plainly prose, not a header row.
  const dataSheet = new SheetWriter();
  dataSheet.banner(0, 0,
    "This sheet is intentionally empty. It is meant to hold the raw survey data, " +
    "but the columns for it have not been specified yet.", 6);
  add(dataSheet.finish(), "Data");

  // The trailing space is the client's. A cross-sheet reference written against
  // "Survey Analysis" without it would not resolve.
  add(buildSurveyAnalysis(agg, counts), "Survey Analysis ");
  add(buildRatingsSheet(agg), "In Person and TH Ratings");
  add(buildNeutralsSheet(agg), "Neutrals and Below");

  // Tab ORDER follows the template: grouped by office in the same order the
  // analysis sheet uses, alphabetical within an office. The aggregate sorts by
  // name alone, which put the tabs in an order that contradicted the analysis
  // sheet sitting two tabs to the left. Ordering is layout, so it belongs here.
  const officeRank = (office: string): number => {
    const i = OFFICE_ORDER.indexOf(office);
    if (i !== -1) return i;
    return office === UNKNOWN_OFFICE ? OFFICE_ORDER.length + 1 : OFFICE_ORDER.length;
  };
  const tabOrder = agg.providers.slice().sort((a, b) => {
    const d = officeRank(a.office) - officeRank(b.office);
    return d !== 0 ? d : a.shortName.localeCompare(b.shortName);
  });

  tabOrder.forEach((p) => {
    const name = sheetNameFor(p.shortName, names);
    if (name !== p.shortName) renamed[p.shortName] = name;
    const known = p.providerId === null ? undefined : counts.byProviderId[p.providerId]?.count;
    add(buildProviderSheet(p, known), name);
  });

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return { buffer, sheetNames: names, renamed };
}
