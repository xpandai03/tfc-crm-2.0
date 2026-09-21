/**
 * TherapyNotes patient identity, stored so matching can see it.
 * ============================================================================
 *
 * WHY THIS TABLE EXISTS. Survey matching searches CRM contacts, and about half
 * the practice's active patients predate the CRM. Two of them were submitted
 * through the survey on the client call with correct details and could not
 * match, because there was nothing to match against. This is that something.
 *
 * REFRESH, NOT APPEND, AND ONLY ON A COMPLETE PULL
 * ------------------------------------------------
 * A patient who was active yesterday and is not today must stop being
 * matchable, so a pull REPLACES the table rather than adding to it. But it does
 * so inside one transaction and ONLY when every clinician read cleanly: a
 * partial pull leaves yesterday's table exactly as it was.
 *
 * Stale-but-whole beats fresh-but-half. A half-replaced table silently removes
 * the patients belonging to whichever clinicians failed, and the symptom — a
 * survey that would have matched yesterday landing in review today — looks like
 * a matcher bug rather than a pull failure.
 *
 * VERBATIM AND NORMALISED, SIDE BY SIDE
 * -------------------------------------
 * The raw columns hold exactly what TherapyNotes rendered. The *_key columns
 * hold the same values through the CRM's OWN normalisers — nameKeys, canonicalDob
 * and phoneKey from server/survey/matching.ts — so both populations key in one
 * space and there is no second normaliser to drift.
 *
 * A NAME HAS MORE THAN ONE KEY. TherapyNotes renders a patient with a preferred
 * name as "Preferred (Legal) Last", so one row is two readings and they live in
 * tn_patient_name_keys, one per row. name_key on this table still holds the
 * first of them, which is what nameKey() has always produced.
 *
 * SHARED CARE IS ONE ROW. A patient under two clinicians is one chart id with
 * two clinician values, stored as a JSON array. Zero patients are shared-care
 * today; the shape is right and costs nothing, and discovering the case through
 * a wrong match is not the way to find out.
 *
 * PHI. This holds identity for roughly a thousand people. It is protected
 * exactly as sync_contacts is: no public route reaches it, every reader is
 * behind the auth middleware, and nothing here is ever logged — the runner logs
 * counts only.
 */

import { getPool } from "../db/pool";
import { canonicalDob, nameKeys, phoneKey } from "../survey/matching";

export interface TnPatientRow {
  chartId: string;
  name: string;
  dob: string;
  phone: string;
  clinicians: string[];
}

export async function initTnPatientsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tn_patients (
      chart_id      TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      dob           TEXT NOT NULL,
      phone         TEXT NOT NULL DEFAULT '',
      name_key      TEXT NOT NULL,
      dob_key       TEXT,
      phone_key     TEXT,
      clinicians    TEXT NOT NULL DEFAULT '[]',
      captured_at   TIMESTAMPTZ NOT NULL,
      last_seen_on  DATE NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // EVERY READING OF EVERY NAME, ONE ROW EACH.
  //
  // A name has more than one reading. TherapyNotes renders a patient with a
  // preferred name as "Preferred (Legal) Last" — the practice uses "Minor" on
  // children's records — so that row is BOTH "minor <last>" and "<legal>
  // <last>", and a survey carrying the legal name only ever meets the second.
  // A single name_key column cannot hold both, so the readings live here, one
  // row per reading, keyed on the chart.
  //
  // tn_patients.name_key is deliberately NOT dropped or retyped. It still holds
  // nameKeys(name)[0], which is exactly nameKey(name), so every existing reader
  // keeps its meaning and this change stays additive and reversible.
  //
  // dob_key is carried alongside so the matcher's query shape — name AND date
  // of birth, both exact after normalisation — is answerable from one index on
  // one table. It is a copy of tn_patients.dob_key, written in the same
  // transaction, and the wholesale replace keeps the two from drifting.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tn_patient_name_keys (
      chart_id  TEXT NOT NULL,
      name_key  TEXT NOT NULL,
      dob_key   TEXT,
      PRIMARY KEY (chart_id, name_key)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS tn_patient_name_keys_name_dob
       ON tn_patient_name_keys (name_key, dob_key)`,
  );
  // The index MOVES to the side table. The old one covered a single key per
  // chart, which is the assumption this change exists to remove.
  //
  // TO REVERSE THE WHOLE CHANGE:
  //   DROP INDEX IF EXISTS tn_patient_name_keys_name_dob;
  //   DROP TABLE IF EXISTS tn_patient_name_keys;
  //   CREATE INDEX IF NOT EXISTS tn_patients_name_dob ON tn_patients (name_key, dob_key);
  try {
    await pool.query(`DROP INDEX IF EXISTS tn_patients_name_dob`);
  } catch (e) {
    console.error("[tn-patients] dropping the superseded name_dob index FAILED:", e);
  }

  // The link between the two populations. Written ONLY when a match resolves a
  // contact to a chart; never guessed, never backfilled. Additive and nullable,
  // so every existing contact keeps its meaning.
  try {
    await pool.query(`ALTER TABLE sync_contacts ADD COLUMN IF NOT EXISTS tn_chart_id TEXT`);
  } catch (e) {
    console.error("[tn-patients] sync_contacts.tn_chart_id migration FAILED:", e);
  }
  // Where a TherapyNotes match lands on the submission. Additive and nullable.
  try {
    await pool.query(
      `ALTER TABLE survey_match_reviews ADD COLUMN IF NOT EXISTS matched_chart_id TEXT`,
    );
  } catch (e) {
    console.error("[tn-patients] survey_match_reviews.matched_chart_id migration FAILED:", e);
  }
  console.log("[tn-patients] Table initialized");
}

/**
 * Replace the table with one complete pull.
 *
 * ALL OR NOTHING. The delete and every insert share a transaction, so a failure
 * part-way through leaves the previous pull intact rather than a fragment of
 * this one. The caller is responsible for only calling this on a complete pull;
 * this is the second guard, not the first.
 */
export async function replaceTnPatients(
  rows: TnPatientRow[], capturedAt: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const pool = getPool();
  const client = await pool.connect();
  const day = capturedAt.slice(0, 10);
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM tn_patients");
    // The readings go with the rows they belong to, in the same transaction and
    // the same wholesale replace. There is no backfill and never needs to be: a
    // pull rewrites both tables, so tomorrow's 03:00 pass re-keys the entire
    // population whatever the rule says by then.
    await client.query("DELETE FROM tn_patient_name_keys");
    for (const r of rows) {
      const readings = nameKeys(r.name);
      const dobKey = canonicalDob(r.dob);
      await client.query(
        `INSERT INTO tn_patients
           (chart_id, name, dob, phone, name_key, dob_key, phone_key,
            clinicians, captured_at, last_seen_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date)
         ON CONFLICT (chart_id) DO UPDATE SET
           name = EXCLUDED.name, dob = EXCLUDED.dob, phone = EXCLUDED.phone,
           name_key = EXCLUDED.name_key, dob_key = EXCLUDED.dob_key,
           phone_key = EXCLUDED.phone_key, clinicians = EXCLUDED.clinicians,
           captured_at = EXCLUDED.captured_at, last_seen_on = EXCLUDED.last_seen_on`,
        [
          // readings[0] IS nameKey(r.name) — see nameKeys. Taken from the array
          // rather than computed a second way, so the column and the side table
          // cannot disagree about the primary reading.
          r.chartId, r.name, r.dob, r.phone,
          readings[0] ?? "", dobKey, phoneKey(r.phone),
          JSON.stringify(r.clinicians), capturedAt, day,
        ],
      );
      for (const k of readings) {
        await client.query(
          `INSERT INTO tn_patient_name_keys (chart_id, name_key, dob_key)
           VALUES ($1,$2,$3)
           ON CONFLICT (chart_id, name_key) DO UPDATE SET dob_key = EXCLUDED.dob_key`,
          [r.chartId, k, dobKey],
        );
      }
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => { /* the pool will discard it */ });
    throw e;
  } finally {
    client.release();
  }
}

/** Every stored patient, in the identity shape the matcher consumes. */
export async function getTnPatientIdentities(): Promise<
  { chartId: string; name: string; dob: string; phone: string; clinicians: string[] }[]
> {
  const { rows } = await getPool().query(
    `SELECT chart_id, name, dob, phone, clinicians FROM tn_patients`,
  );
  return rows.map((r: any) => ({
    chartId: r.chart_id,
    name: r.name,
    dob: r.dob,
    phone: r.phone ?? "",
    clinicians: safeArray(r.clinicians),
  }));
}

function safeArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Counts for the run report. Never content. */
export async function tnPatientStats(): Promise<{ rows: number; capturedOn: string | null }> {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS n, MAX(last_seen_on)::text AS d FROM tn_patients`,
  );
  return { rows: rows[0]?.n ?? 0, capturedOn: rows[0]?.d ?? null };
}

/**
 * Record that a contact is the same person as a chart.
 *
 * Written only by a match that resolved a CRM contact carrying a chart id, so
 * the link is a consequence of evidence rather than an assumption. Never
 * overwritten with NULL.
 */
export async function linkContactToChart(contactId: number, chartId: string): Promise<void> {
  if (!chartId) return;
  await getPool().query(
    `UPDATE sync_contacts SET tn_chart_id = $2 WHERE contact_id = $1 AND tn_chart_id IS DISTINCT FROM $2`,
    [contactId, chartId],
  );
}
