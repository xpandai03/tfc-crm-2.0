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
import { aggregateSurveys, type RosterEntry, type SubmissionInput } from "./aggregate";
import { buildSurveyWorkbook } from "./workbook";

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

/** `TFC-Client-Survey-2026-07-01_to_2026-09-30.xlsx` — the range is in the name. */
export function exportFilename(range: SurveyExportRange): string {
  return `TFC-Client-Survey-${range.from}_to_${range.to}.xlsx`;
}

export async function buildSurveyExport(range: SurveyExportRange): Promise<SurveyExportResult> {
  const started = Date.now();

  const [active, inactive, rows] = await Promise.all([
    getAllCrmProviders(),
    getInactiveCrmProviders(),
    getRecentSurveySubmissions(MAX_SUBMISSIONS),
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

  const aggregate = aggregateSurveys({ roster, submissions, period: range });
  const { buffer, sheetNames } = buildSurveyWorkbook(aggregate);

  return {
    buffer,
    filename: exportFilename(range),
    stats: {
      submissionsInPeriod: aggregate.submissionsInPeriod,
      providerCount: aggregate.providers.length,
      departedCount: aggregate.departed.length,
      unresolvedCount: aggregate.unresolved.length,
      sheetCount: sheetNames.length,
      buildMs: Date.now() - started,
    },
  };
}
