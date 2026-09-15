/**
 * Ops-set overrides for Total Active Clients.
 * ============================================================================
 *
 * WHY THIS EXISTS. The nightly pull counts who is active TONIGHT. A client
 * discharged on the 20th was active for most of the month and completed a
 * survey, but is gone from the count on the 30th — so the denominator shrinks
 * while the numerator stays, and the completion percentage inflates. The
 * practice's dummy records sit across real clinicians and inflate it the other
 * way. Neither is something software should guess at: both are judgements about
 * what a month MEANT, and the person who makes that judgement is the ops lead.
 *
 * So this stores a number he typed, and the export uses it in place of the
 * pulled one.
 *
 * KEYED ON THE PERIOD, NOT THE PROVIDER
 * -------------------------------------
 * (provider_id, period_from, period_to) — the export's range, exactly. An
 * override is an answer to "what was Amanda's caseload in October", and that is
 * not an answer about November.
 *
 * The alternative shape — one number per provider with an "applies until" date —
 * was rejected. A threshold date is exactly how October's number leaks into
 * November: it keeps applying until somebody remembers to change it, and the
 * report that is wrong is the one nobody looked at. Keying on the range means an
 * override can only ever apply to the report it was typed for.
 *
 * The cost is that a number typed for October does not apply to a Q4 export,
 * because those are different questions with different denominators. The dialog
 * shows which periods carry overrides, so this is visible rather than silent.
 *
 * CLEARING IS A DELETE. There is no "cleared" state to reason about and no way
 * to leave a blank behind: the row is gone, the selection falls through to the
 * pulled count, and the export behaves exactly as it did before anyone typed
 * anything.
 *
 * NO HEURISTICS LIVE HERE OR ANYWHERE. Nothing subtracts dummy records, matches
 * a name prefix, or guesses which patients are real. The client was explicit
 * that the software should not try, and this table is the tool he asked for
 * instead.
 *
 * PHI: none. A provider id, a count, a staff email and two dates.
 */

import { getPool } from "../db/pool";

export interface ActiveCountOverride {
  providerId: number;
  periodFrom: string;
  periodTo: string;
  activeCount: number;
  note: string | null;
  setBy: string;
  setAt: string;
  updatedAt: string;
}

export async function initActiveCountOverridesTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS survey_active_count_overrides (
      id            SERIAL      PRIMARY KEY,
      provider_id   INTEGER     NOT NULL,
      period_from   DATE        NOT NULL,
      period_to     DATE        NOT NULL,
      active_count  INTEGER     NOT NULL CHECK (active_count >= 0),
      note          TEXT,
      set_by        TEXT        NOT NULL,
      set_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // One override per provider per period. Two people saving in the same minute
  // therefore produce one row, last write wins, and set_by/set_at say which
  // write that was — rather than two rows and an export that has to pick.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS survey_active_count_overrides_uniq
       ON survey_active_count_overrides (provider_id, period_from, period_to)`,
  );
  console.log("[active-count-overrides] Table initialized");
}

/** Every override for one reporting period. */
export async function getOverridesForPeriod(
  from: string, to: string,
): Promise<ActiveCountOverride[]> {
  const { rows } = await getPool().query(
    `SELECT provider_id, period_from::text, period_to::text,
            active_count, note, set_by, set_at, updated_at
       FROM survey_active_count_overrides
      WHERE period_from = $1::date AND period_to = $2::date`,
    [from, to],
  );
  return rows.map(mapRow);
}

/**
 * Set one, or replace the one already there.
 *
 * An upsert rather than an insert: he will change his mind, and a second row
 * for the same provider and period is not a second opinion, it is the same
 * opinion revised.
 */
export async function setOverride(params: {
  providerId: number;
  periodFrom: string;
  periodTo: string;
  activeCount: number;
  note: string | null;
  setBy: string;
}): Promise<ActiveCountOverride> {
  const { rows } = await getPool().query(
    `INSERT INTO survey_active_count_overrides
       (provider_id, period_from, period_to, active_count, note, set_by)
     VALUES ($1, $2::date, $3::date, $4, $5, $6)
     ON CONFLICT (provider_id, period_from, period_to) DO UPDATE SET
       active_count = EXCLUDED.active_count,
       note         = EXCLUDED.note,
       set_by       = EXCLUDED.set_by,
       set_at       = NOW(),
       updated_at   = NOW()
     RETURNING provider_id, period_from::text, period_to::text,
               active_count, note, set_by, set_at, updated_at`,
    [params.providerId, params.periodFrom, params.periodTo,
     params.activeCount, params.note, params.setBy],
  );
  return mapRow(rows[0]);
}

/** Clear one. The pulled count returns because there is nothing left to prefer. */
export async function clearOverride(
  providerId: number, from: string, to: string,
): Promise<boolean> {
  const res = await getPool().query(
    `DELETE FROM survey_active_count_overrides
      WHERE provider_id = $1 AND period_from = $2::date AND period_to = $3::date`,
    [providerId, from, to],
  );
  return (res.rowCount ?? 0) > 0;
}

function mapRow(r: any): ActiveCountOverride {
  return {
    providerId: r.provider_id,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    activeCount: r.active_count,
    note: r.note ?? null,
    setBy: r.set_by,
    setAt: String(r.set_at),
    updatedAt: String(r.updated_at),
  };
}
