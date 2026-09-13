/**
 * Storage for per-clinician active client counts read out of TherapyNotes.
 * ============================================================================
 *
 * A DATED HISTORY, NOT A COLUMN ON crm_providers, and that is the whole design
 * decision. The survey export is scoped to a period. A single mutable column
 * would give an August report December's denominator, and — worse — would make
 * the same report return a different percentage every time it was run. This
 * project already settled that reports must be reproducible; the reasoning
 * applies unchanged.
 *
 * So each pass writes one row per dropdown option, stamped with the day it was
 * read, and the export selects the newest row on or before its period end. Once
 * a period has passed, that answer never changes again.
 *
 * The cost is nothing: 31 options a night is ~11,300 rows a year.
 *
 * EVERYTHING IS STORED, INCLUDING WHAT DID NOT WORK. A clinician whose count
 * could not be parsed is stored as a failure with its reason, and a label that
 * matches no provider is stored unmatched. A count with no provider is
 * harmless; a silently dropped one hides a gap in the roster.
 *
 * TEST ANNA IS RECORDED AND NEVER SUBTRACTED. The practice's dummy records are
 * spread across real clinicians, so a blanket subtraction would wrongly reduce
 * whoever holds them. Both figures the agent reports are kept so the decision
 * can be made later without another pass.
 */

import { getPool } from "../db/pool";
import type { MatchStatus } from "./clinician-match";

export interface ActiveCountRow {
  capturedAt: string;
  capturedOn: string;
  optionValue: string;
  label: string;
  isAggregate: boolean;
  providerId: number | null;
  matchStatus: MatchStatus;
  activeCount: number | null;
  status: "success" | "failure";
  failureReason: string | null;
  countText: string | null;
  testAnnaExact: number | null;
  testAnnaTokenMatch: number | null;
  testAnnaStatus: string | null;
}

export async function initActiveCountsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tn_active_counts (
      id                    SERIAL PRIMARY KEY,
      captured_at           TIMESTAMPTZ NOT NULL,
      captured_on           DATE        NOT NULL,
      option_value          TEXT        NOT NULL,
      label                 TEXT        NOT NULL,
      is_aggregate          BOOLEAN     NOT NULL DEFAULT false,
      provider_id           INTEGER,
      match_status          TEXT        NOT NULL,
      active_count          INTEGER,
      status                TEXT        NOT NULL,
      failure_reason        TEXT,
      count_text            TEXT,
      test_anna_exact       INTEGER,
      test_anna_token_match INTEGER,
      test_anna_status      TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // One row per option per day. A re-run on the same day overwrites rather than
  // duplicating, so a manual trigger after a failed overnight pass is safe.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS tn_active_counts_day_option_uniq
       ON tn_active_counts (captured_on, option_value)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS tn_active_counts_provider_day
       ON tn_active_counts (provider_id, captured_on DESC)`,
  );
  console.log("[active-counts] Table initialized");
}

/** Write one pass. Idempotent per (day, option). */
export async function storeActiveCounts(rows: ActiveCountRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const pool = getPool();
  let written = 0;
  for (const r of rows) {
    const res = await pool.query(
      `INSERT INTO tn_active_counts (
         captured_at, captured_on, option_value, label, is_aggregate, provider_id,
         match_status, active_count, status, failure_reason, count_text,
         test_anna_exact, test_anna_token_match, test_anna_status
       ) VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (captured_on, option_value) DO UPDATE SET
         captured_at = EXCLUDED.captured_at,
         label = EXCLUDED.label,
         is_aggregate = EXCLUDED.is_aggregate,
         provider_id = EXCLUDED.provider_id,
         match_status = EXCLUDED.match_status,
         active_count = EXCLUDED.active_count,
         status = EXCLUDED.status,
         failure_reason = EXCLUDED.failure_reason,
         count_text = EXCLUDED.count_text,
         test_anna_exact = EXCLUDED.test_anna_exact,
         test_anna_token_match = EXCLUDED.test_anna_token_match,
         test_anna_status = EXCLUDED.test_anna_status`,
      [
        r.capturedAt, r.capturedOn, r.optionValue, r.label, r.isAggregate, r.providerId,
        r.matchStatus, r.activeCount, r.status, r.failureReason, r.countText,
        r.testAnnaExact, r.testAnnaTokenMatch, r.testAnnaStatus,
      ],
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

export interface ProviderActiveCount {
  providerId: number;
  activeCount: number;
  capturedOn: string;
}

/**
 * Each provider's count AS OF a date: the newest successful reading on or
 * before it.
 *
 * ON OR BEFORE, not "nearest". Nearest would let a reading taken after the
 * period ended change a report that had already been run, which is the mutable
 * column's flaw wearing a different hat.
 *
 * Failures and unmatched rows are excluded here by construction — a row with a
 * NULL count or no provider cannot become a denominator. They remain in the
 * table for the run report.
 */
export async function getActiveCountsAsOf(asOf: string): Promise<ProviderActiveCount[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (provider_id)
            provider_id, active_count, captured_on::text AS captured_on
       FROM tn_active_counts
      WHERE provider_id IS NOT NULL
        AND status = 'success'
        AND active_count IS NOT NULL
        AND captured_on <= $1::date
      ORDER BY provider_id, captured_on DESC`,
    [asOf],
  );
  return rows.map((r: any) => ({
    providerId: r.provider_id,
    activeCount: r.active_count,
    capturedOn: r.captured_on,
  }));
}
