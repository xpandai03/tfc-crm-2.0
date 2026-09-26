/**
 * The Survey Insights snapshot — two tables, and nothing else.
 * ============================================================================
 *
 * WHAT THE CLIENT ASKED FOR, and what he cut it down to. He was offered a full
 * survey results view and scoped it to: "I really only want the total active
 * clients, the total surveys completed, and then the percentage. Same thing for
 * location — I don't want it broken down by provider. Just a quick snapshot."
 *
 * So: one row per provider, one row per office, three numbers each. No question
 * breakdown, no comments, no chart. He was specific because he has watched
 * reports grow past their usefulness.
 *
 * WHY HE WANTS IT. The export is the month-end document; this is the glance. He
 * reads it mid-month to see who needs reminding — if Amanda has 45 active
 * clients and 3 surveys, he goes and talks to Amanda's clients.
 *
 * NOT A SECOND CALCULATION
 * ------------------------
 * Every number here comes out of loadSurveyPeriodData(), which is the function
 * the workbook is built from. This module RESHAPES that data; it does not read
 * a table, resolve a therapist label, or select a count. The client will hold
 * the snapshot and the workbook side by side, and the only way to guarantee
 * they agree is for there to be nothing that could disagree.
 *
 * THE PERCENTAGE IS EXCEL'S, COMPUTED HERE
 * ----------------------------------------
 * There is no Excel on a web page, so the one number the workbook delegates has
 * to be computed. The workbook writes `=D2/C2` formatted `0%`, and Excel's `0%`
 * renders a whole percent, rounding half away from zero. Math.round does the
 * same for the non-negative values this can produce. So `percent()` below is
 * that formula and that format, and 3/45 reads 7% in both places.
 *
 * THE BOTH-OR-NEITHER RULE IS THE WORKBOOK'S, KEPT
 * ------------------------------------------------
 * The workbook writes no percentage where there is no denominator, and no
 * office total unless EVERY provider in that office has one — because summing
 * the counts that happen to exist and dividing all the surveys by it inflates
 * the figure silently. The snapshot obeys the same rule, for the same reason
 * and so the two files agree. A withheld number renders as a dash with a
 * reason, never as a zero.
 *
 * PHI: none. Provider names are staff names; everything else is a count.
 */

import { UNKNOWN_OFFICE } from "./aggregate";
import { loadSurveyPeriodData, type SurveyExportRange } from "./export";
import { tnPullHealth, type TnPullHealth } from "../therapy-notes/tn-patients-db";

/** One provider's line in the snapshot. */
export interface SnapshotProviderRow {
  providerId: number | null;
  name: string;
  shortName: string;
  office: string;
  /** NULL when no count exists for this period — never 0, which is a real count. */
  activeClients: number | null;
  surveys: number;
  /** Whole percent, as Excel's `0%` would render it. NULL when no denominator. */
  percent: number | null;
  /** Set when a person typed this figure for this period. */
  override: { pulled: number | null; setBy: string; setAt: string } | null;
}

/** One office's line. Figures are sums of the providers above. */
export interface SnapshotOfficeRow {
  office: string;
  providers: number;
  /** NULL unless EVERY provider in this office has a count — the workbook's rule. */
  activeClients: number | null;
  surveys: number;
  percent: number | null;
  /** How many of this office's providers are missing a count, for the reason text. */
  missingCounts: number;
}

export interface SurveySnapshot {
  period: SurveyExportRange;
  providers: SnapshotProviderRow[];
  offices: SnapshotOfficeRow[];
  /** The practice line, on the same rule as an office. */
  total: SnapshotOfficeRow;
  /** Newest TherapyNotes reading used, for the "as of" line. */
  countsAsOf: string | null;
  submissionsInPeriod: number;
  overrideCount: number;
  /**
   * The nightly TherapyNotes patient pull — the population survey matching and
   * filing depend on. Null only if it could not be read at all; the snapshot's
   * own numbers do not depend on it.
   */
  patientPull: TnPullHealth | null;
}

/**
 * Exactly what the workbook's `=D/C` with a `0%` format produces.
 *
 * Exported so the test can assert the snapshot and the workbook agree by
 * running the same function over the same pair, rather than by two people
 * believing they implemented the same rounding.
 */
export function percent(surveys: number, active: number | null): number | null {
  if (active === null || active === 0) return null;
  return Math.round((surveys / active) * 100);
}

export async function buildSurveySnapshot(range: SurveyExportRange): Promise<SurveySnapshot> {
  const { aggregate, activeCounts, overrideCount } = await loadSurveyPeriodData(range);
  // Its own read, and never fatal: the snapshot's figures do not depend on it.
  const patientPull = await tnPullHealth().catch(() => null);

  const providers: SnapshotProviderRow[] = aggregate.providers.map((p) => {
    const cell = p.providerId === null ? undefined : activeCounts.byProviderId[p.providerId];
    const activeClients = cell?.count ?? null;
    return {
      providerId: p.providerId,
      name: p.name,
      shortName: p.shortName,
      office: p.office,
      activeClients,
      surveys: p.surveyCount,
      percent: percent(p.surveyCount, activeClients),
      override: cell?.override
        ? { pulled: cell.override.pulled, setBy: cell.override.setBy, setAt: cell.override.setAt }
        : null,
    };
  });

  // ---- the office table ------------------------------------------------
  //
  // A RATIO OF THE SUMS, not an average of the percentages. Those differ, and
  // the difference is not small: two providers at 3/45 (7%) and 1/5 (20%)
  // average to 13.5%, while the ratio of sums is 4/50 = 8%. The ratio is the
  // one that answers "what share of this office's clients responded", which is
  // the question being asked, and it is what the workbook's SUM-then-divide
  // rollup computes.
  const byOffice = new Map<string, SnapshotProviderRow[]>();
  providers.forEach((r) => {
    const key = r.office || UNKNOWN_OFFICE;
    const list = byOffice.get(key);
    if (list) list.push(r); else byOffice.set(key, [r]);
  });

  const offices: SnapshotOfficeRow[] = Array.from(byOffice.entries())
    .map(([office, rows]) => rollup(office, rows))
    // Template order, with the no-office bucket last so it reads as a remainder
    // rather than as a fourth office.
    .sort((a, b) => officeRank(a.office) - officeRank(b.office));

  return {
    period: range,
    providers,
    offices,
    total: rollup("Total", providers),
    countsAsOf: activeCounts.newestCapturedOn,
    submissionsInPeriod: aggregate.submissionsInPeriod,
    overrideCount,
    patientPull,
  };
}

function rollup(office: string, rows: SnapshotProviderRow[]): SnapshotOfficeRow {
  const surveys = rows.reduce((n, r) => n + r.surveys, 0);
  const missingCounts = rows.filter((r) => r.activeClients === null).length;
  // THE WORKBOOK'S RULE. Complete, or blank. Summing only the counts that exist
  // and dividing ALL the surveys by that sum inflates the percentage — every
  // survey counts, only some of the clients do.
  const complete = rows.length > 0 && missingCounts === 0;
  const activeClients = complete
    ? rows.reduce((n, r) => n + (r.activeClients ?? 0), 0)
    : null;
  return {
    office,
    providers: rows.length,
    activeClients,
    surveys,
    percent: percent(surveys, activeClients),
    missingCounts,
  };
}

const OFFICE_ORDER = ["ABQ", "LL", "RR"];
function officeRank(office: string): number {
  const i = OFFICE_ORDER.indexOf(office);
  if (i !== -1) return i;
  return office === UNKNOWN_OFFICE ? OFFICE_ORDER.length + 1 : OFFICE_ORDER.length;
}
