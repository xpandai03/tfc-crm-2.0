/**
 * Survey export — reading the data and handing back a workbook.
 * ============================================================================
 *
 * The seam between the route and the two pure layers beneath it. This is the
 * only place that does I/O for the export: it reads submissions and the roster,
 * hands them to ./aggregate.ts, hands that to ./workbook.ts, and returns bytes.
 *
 * BOTH ROSTERS ARE READ, deliberately. getAllCrmProviders() returns active
 * providers only, and a departed provider's submissions still belong in their
 * office's counts and in the negative listings — they simply get no tab. Their
 * office can only come from their own (inactive) row, so it has to be read.
 *
 * NOTHING HERE IS AUTHENTICATED. The guard lives on the route in
 * server/routes.ts, registered after the auth middleware. This module must
 * never be reachable from server/survey/routes.ts, which is mounted BEFORE auth
 * so the public survey forms work without a session.
 */

import { getRecentSurveySubmissions } from "../sync/db";
import { getAllCrmProviders, getInactiveCrmProviders } from "../reminders/db";
import { providerShortName } from "@shared/provider-short-name";
import { getActiveCountsAsOf } from "../therapy-notes/active-counts-db";
import { getOverridesForPeriod } from "./active-count-overrides-db";
import { aggregateSurveys, type RosterEntry, type SubmissionInput, type SurveyAggregate } from "./aggregate";
import { buildSurveyWorkbook, type ActiveClientCounts } from "./workbook";

/**
 * Upper bound on rows pulled for one export. A quarter of real submissions is
 * in the hundreds; this is a guard against an unbounded read, not a page size.
 */
const MAX_SUBMISSIONS = 20000;

export interface SurveyExportRange { from: string; to: string }

export interface SurveyExportResult {
  buffer: Buffer;
  filename: string;
  /** For the log entry and the server log line. Counts only — never content. */
  stats: {
    submissionsInPeriod: number;
    providerCount: number;
    departedCount: number;
    unresolvedCount: number;
    sheetCount: number;
    /** Providers carrying a denominator for this period, pulled or typed. */
    providersWithCount: number;
    /** How many of those were typed by a person for this period. */
    overriddenCount: number;
    buildMs: number;
  };
}

/** The current calendar quarter, as the default range the UI offers. */
export function currentQuarter(now: Date = new Date()): SurveyExportRange {
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3);
  const startMonth = q * 3;
  const start = new Date(Date.UTC(y, startMonth, 1));
  const end = new Date(Date.UTC(y, startMonth + 3, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/**
 * The calendar month we are in.
 *
 * The SNAPSHOT's default, where the quarter is the export's. Different defaults
 * because they answer different questions: the export is the month-end
 * document, and the snapshot is what the ops lead reads mid-month to see who
 * needs reminding — a quarter-to-date figure would tell him nothing about this
 * month's reminding.
 */
export function currentMonth(now: Date = new Date()): SurveyExportRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** `TFC-Client-Survey-2026-07-01_to_2026-09-30.xlsx` — the range is in the name. */
export function exportFilename(range: SurveyExportRange): string {
  return `TFC-Client-Survey-${range.from}_to_${range.to}.xlsx`;
}

/**
 * Everything a report about one period needs, read and merged once.
 *
 * EXTRACTED SO THE SNAPSHOT AND THE WORKBOOK CANNOT DISAGREE. The Submissions
 * snapshot shows the same three numbers the export writes, and the client will
 * check one against the other — he has said so. Two code paths reading the same
 * tables is two chances to select a different count, apply an override
 * differently, or resolve a therapist label to a different provider. So there
 * is one path, and the snapshot is a second RENDERING of it rather than a
 * second calculation.
 */
export interface SurveyPeriodData {
  aggregate: SurveyAggregate;
  activeCounts: ActiveClientCounts;
  /** How many figures a person typed for this period. */
  overrideCount: number;
}

export async function loadSurveyPeriodData(
  range: SurveyExportRange,
): Promise<SurveyPeriodData> {
  const [active, inactive, rows, counts, overrides] = await Promise.all([
    getAllCrmProviders(),
    getInactiveCrmProviders(),
    getRecentSurveySubmissions(MAX_SUBMISSIONS),
    // AS OF THE PERIOD END, not "now". A report for August run in December must
    // use August's denominator, or the same report returns a different
    // percentage every time it is run.
    getActiveCountsAsOf(range.to),
    // Numbers the ops lead typed FOR THIS EXACT RANGE. Never for another one —
    // see server/survey/active-count-overrides-db.ts for why the key is the
    // period rather than a date the number applies until.
    getOverridesForPeriod(range.from, range.to),
  ]);

  const roster: RosterEntry[] = active.concat(inactive).map((p) => ({
    id: p.id,
    name: p.name,
    shortName: providerShortName({ name: p.name, shortName: p.shortName }),
    office: p.location ?? "",
    isActive: p.isActive,
  }));

  const submissions: SubmissionInput[] = rows.map((r) => ({
    id: r.id,
    submittedAt: r.submittedAt,
    createdAt: r.createdAt ?? null,
    payload: r.payload ?? {},
  }));

  const activeCounts: ActiveClientCounts = { byProviderId: {}, newestCapturedOn: null };
  counts.forEach((c) => {
    activeCounts.byProviderId[c.providerId] = { count: c.activeCount, capturedOn: c.capturedOn };
    if (!activeCounts.newestCapturedOn || c.capturedOn > activeCounts.newestCapturedOn) {
      activeCounts.newestCapturedOn = c.capturedOn;
    }
  });

  // THE OVERRIDE WINS, AND SAYS WHAT IT REPLACED.
  //
  // Applied on top rather than folded into the query, so the pulled figure
  // survives into the workbook as the thing the marker compares against. An
  // override for a provider the pull had NOTHING for is a real case and is
  // allowed: the reason to have a denominator does not depend on the agent
  // having managed to read one. Such a provider now counts as having a count,
  // which is what lets their office total complete.
  //
  // Nothing here subtracts anything. There is no dummy-record rule, no name
  // prefix, no heuristic — the number is whatever a person typed.
  overrides.forEach((o) => {
    const pulled = activeCounts.byProviderId[o.providerId] ?? null;
    activeCounts.byProviderId[o.providerId] = {
      count: o.activeCount,
      capturedOn: pulled?.capturedOn ?? null,
      override: {
        pulled: pulled?.count ?? null,
        setBy: o.setBy,
        setAt: o.setAt,
        note: o.note,
      },
    };
  });

  const aggregate = aggregateSurveys({ roster, submissions, period: range });
  return { aggregate, activeCounts, overrideCount: overrides.length };
}

export async function buildSurveyExport(range: SurveyExportRange): Promise<SurveyExportResult> {
  const started = Date.now();
  const { aggregate, activeCounts, overrideCount } = await loadSurveyPeriodData(range);
  const { buffer, sheetNames } = buildSurveyWorkbook(aggregate, activeCounts);

  return {
    buffer,
    filename: exportFilename(range),
    stats: {
      submissionsInPeriod: aggregate.submissionsInPeriod,
      providerCount: aggregate.providers.length,
      departedCount: aggregate.departed.length,
      unresolvedCount: aggregate.unresolved.length,
      sheetCount: sheetNames.length,
      providersWithCount: Object.keys(activeCounts.byProviderId).length,
      overriddenCount: overrideCount,
      buildMs: Date.now() - started,
    },
  };
}
