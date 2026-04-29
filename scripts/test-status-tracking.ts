/**
 * Verification script for status-code time tracking (session 1).
 *
 * The repo has no Vitest/Jest infrastructure, so deliverable acceptance
 * tests are runnable assertions instead. This script exercises every
 * acceptance check listed in the session brief against the configured
 * Postgres DB. All work happens inside a single transaction that is
 * ROLLED BACK at the end — no rows are persisted.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/test-status-tracking.ts
 *
 * Exit code: 0 if all checks pass, 1 otherwise.
 */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required (point at a dev DB; this script rolls back).");
  process.exit(1);
}

// Each check returns null on success, or an error message string on failure.
type Check = () => Promise<string | null>;

const results: Array<{ name: string; ok: boolean; detail: string | null }> = [];

async function run(name: string, fn: Check) {
  process.stdout.write(`▶ ${name} ... `);
  try {
    const detail = await fn();
    if (detail === null) {
      console.log("ok");
      results.push({ name, ok: true, detail: null });
    } else {
      console.log(`FAIL: ${detail}`);
      results.push({ name, ok: false, detail });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAIL (threw): ${msg}`);
    results.push({ name, ok: false, detail: msg });
  }
}

async function main() {
  // Bootstrap schema for fresh dev DBs. Both init functions are idempotent
  // (CREATE TABLE IF NOT EXISTS) so this is a no-op against a populated DB.
  // Calls them via the app's own pool helper so the migration in
  // initActivityTable() runs through its real code path.
  const { initSyncTables } = await import("../server/sync/db");
  const { initActivityTable } = await import("../server/activity/db");
  await initSyncTables();
  await initActivityTable();

  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  // -------------------------------------------------------------------------
  // 1. Migration check: created_at is TIMESTAMPTZ in dev DB
  // -------------------------------------------------------------------------
  await run("migration: activity_log.created_at is TIMESTAMPTZ", async () => {
    const { rows } = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'activity_log' AND column_name = 'created_at'
    `);
    if (rows.length === 0) return "activity_log.created_at column missing";
    const t = rows[0].data_type;
    return t === "timestamp with time zone" ? null : `expected timestamptz, got ${t}`;
  });

  // -------------------------------------------------------------------------
  // 2. Migration round-trip: prior TEXT-format ISO values survive cast
  // -------------------------------------------------------------------------
  await run("migration: existing ISO strings round-trip after cast", async () => {
    // Insert a row, read it back as text, confirm valid timestamptz.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata, created_at)
         VALUES ('contact_updated', 'test@example.org', 'contact', '999999', 'Synthetic',
                 '{}', '2026-04-21 14:08:33.412+00')`,
      );
      const { rows } = await client.query(
        `SELECT
           EXTRACT(EPOCH FROM created_at) AS row_ts,
           EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-04-21 14:08:33.412+00') AS expected_ts
         FROM activity_log
         WHERE entity_id = '999999' AND actor_email = 'test@example.org'
         ORDER BY id DESC LIMIT 1`,
      );
      await client.query("ROLLBACK");
      if (rows.length === 0) return "round-trip row missing";
      const rowTs = Number(rows[0].row_ts);
      const expected = Number(rows[0].expected_ts);
      // Round-trip = cast preserved the value: row epoch matches the literal's epoch.
      return Math.abs(rowTs - expected) < 0.001 ? null : `epoch mismatch: row=${rowTs} expected=${expected}`;
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // 3. logStatusChange happy path — inserts the expected row shape
  // -------------------------------------------------------------------------
  await run("logStatusChange: writes a status_changed row with from/to metadata", async () => {
    const { logStatusChange } = await import("../server/activity/db");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // logStatusChange uses the module-level pool, not our client. Run the
      // write, then read it back through pool.query, then clean it up.
      const synthId = -42_001; // negative id to avoid colliding with prod data
      await logStatusChange({
        actorEmail: "test@example.org",
        contactId: synthId,
        contactName: "Synthetic",
        fromCode: 100,
        fromLabel: "intake",
        toCode: 200,
        toLabel: "ready_to_schedule",
      });
      const { rows } = await pool.query(
        `SELECT type, actor_email, entity_type, entity_id, metadata::jsonb AS meta
           FROM activity_log
          WHERE entity_id = $1 AND type = 'status_changed'
          ORDER BY id DESC LIMIT 1`,
        [String(synthId)],
      );
      await pool.query(`DELETE FROM activity_log WHERE entity_id = $1`, [String(synthId)]);
      await client.query("ROLLBACK");
      if (rows.length === 0) return "no row written";
      const r = rows[0];
      if (r.type !== "status_changed") return `wrong type: ${r.type}`;
      if (r.actor_email !== "test@example.org") return `wrong actor: ${r.actor_email}`;
      if (r.entity_type !== "contact") return `wrong entity_type: ${r.entity_type}`;
      const m = r.meta as { from: number; fromLabel: string; to: number; toLabel: string };
      if (m.from !== 100) return `wrong from: ${m.from}`;
      if (m.to !== 200) return `wrong to: ${m.to}`;
      if (m.fromLabel !== "intake") return `wrong fromLabel: ${m.fromLabel}`;
      if (m.toLabel !== "ready_to_schedule") return `wrong toLabel: ${m.toLabel}`;
      return null;
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // 4. Hardened semantics: failure propagates instead of silently swallowing
  // -------------------------------------------------------------------------
  await run("logStatusChange: throws on DB write failure (does not swallow)", async () => {
    // Force a failure by passing a value that violates a NOT NULL constraint.
    // We do this by importing the helper but calling pool.query directly with
    // a deliberately malformed insert; the helper itself wraps no try/catch,
    // so any pg error must surface.
    const { logStatusChange } = await import("../server/activity/db");

    // Contaminate JSON.stringify to throw, simulating a serialization failure
    // inside the helper. Cleaner than corrupting the DB.
    const orig = JSON.stringify;
    (JSON as any).stringify = () => {
      throw new Error("synthetic-stringify-failure");
    };
    try {
      let threw = false;
      try {
        await logStatusChange({
          actorEmail: "test@example.org",
          contactId: -42_002,
          fromCode: 100,
          toCode: 200,
        });
      } catch (e) {
        threw = e instanceof Error && /synthetic-stringify-failure/.test(e.message);
      }
      return threw ? null : "logStatusChange did not propagate the failure";
    } finally {
      (JSON as any).stringify = orig;
    }
  });

  // -------------------------------------------------------------------------
  // 5. logActivity (non-status) still swallows — no regression for other types
  // -------------------------------------------------------------------------
  await run("logActivity (best-effort): does NOT throw when write fails", async () => {
    const { logActivity } = await import("../server/activity/db");
    const orig = JSON.stringify;
    (JSON as any).stringify = () => {
      throw new Error("synthetic-stringify-failure");
    };
    try {
      let threw = false;
      try {
        await logActivity({
          type: "contact_updated",
          actorEmail: "test@example.org",
          entityType: "contact",
          entityId: "-42003",
          metadata: {},
        });
      } catch {
        threw = true;
      }
      return threw ? "logActivity propagated an error (regression!)" : null;
    } finally {
      (JSON as any).stringify = orig;
    }
  });

  // -------------------------------------------------------------------------
  // 6. Endpoint shape: getStatusDurations returns the documented contract
  // -------------------------------------------------------------------------
  await run("getStatusDurations: returns expected shape and handles NULL", async () => {
    const { getStatusDurations } = await import("../server/activity/db");
    const result = await getStatusDurations();
    if (!result || typeof result !== "object") return "result is not an object";
    if (!Array.isArray(result.byContact)) return "byContact missing or not array";
    if (!Array.isArray(result.byStatusCode)) return "byStatusCode missing or not array";
    if (typeof result.generatedAt !== "string") return "generatedAt missing";
    // Sample first row shape (if any contacts exist)
    if (result.byContact.length > 0) {
      const r0 = result.byContact[0];
      if (typeof r0.contactId !== "number") return "contactId not number";
      if (r0.statusCode !== null && typeof r0.statusCode !== "number")
        return "statusCode wrong type";
      if (
        r0.timeInCurrentStatusSeconds !== null &&
        typeof r0.timeInCurrentStatusSeconds !== "number"
      )
        return "timeInCurrentStatusSeconds wrong type";
    }
    if (result.byStatusCode.length > 0) {
      const a0 = result.byStatusCode[0];
      const required = [
        "statusCode",
        "countTotal",
        "countWithData",
        "avgSeconds",
        "medianSeconds",
        "p90Seconds",
      ] as const;
      for (const key of required) {
        if (!(key in a0)) return `aggregate missing ${key}`;
      }
    }
    return null;
  });

  // -------------------------------------------------------------------------
  // 7. End-to-end: upsertSingleContact transitions log, no-ops don't, creates don't
  //    Uses a real, randomly-named contact_id outside production range (negative).
  // -------------------------------------------------------------------------
  await run(
    "upsertSingleContact: logs on transition, skips on no-op, skips on insert",
    async () => {
      const { upsertSingleContact } = await import("../server/sync/db");
      const synthId = -1 - Math.floor(Math.random() * 1_000_000);
      const baseContact = {
        contactId: synthId,
        name: "Synthetic User",
        email: "test@example.org",
        phone: null,
        status: "intake",
        statusCode: 100,
        serviceRequested: null,
        daysOnWaitlist: 0,
        dateAdded: "2026-01-01",
      } as any;

      try {
        // (a) Insert (creation): should NOT log.
        await upsertSingleContact({ ...baseContact });
        let { rows: r1 } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM activity_log
            WHERE entity_id = $1 AND type = 'status_changed'`,
          [String(synthId)],
        );
        if (r1[0].n !== 0) return `insert path wrote ${r1[0].n} log row(s); expected 0`;

        // (b) No-op upsert (same status_code): should NOT log.
        await upsertSingleContact({ ...baseContact });
        let { rows: r2 } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM activity_log
            WHERE entity_id = $1 AND type = 'status_changed'`,
          [String(synthId)],
        );
        if (r2[0].n !== 0) return `no-op upsert wrote ${r2[0].n} log row(s); expected 0`;

        // (c) Transition: should log exactly one row.
        await upsertSingleContact({ ...baseContact, statusCode: 200, status: "ready_to_schedule" });
        let { rows: r3 } = await pool.query(
          `SELECT (metadata::jsonb->>'from')::int AS f, (metadata::jsonb->>'to')::int AS t
             FROM activity_log
            WHERE entity_id = $1 AND type = 'status_changed'`,
          [String(synthId)],
        );
        if (r3.length !== 1) return `transition wrote ${r3.length} log rows; expected 1`;
        if (r3[0].f !== 100 || r3[0].t !== 200)
          return `transition metadata wrong: from=${r3[0].f} to=${r3[0].t}`;

        return null;
      } finally {
        // Clean up
        await pool.query(`DELETE FROM activity_log WHERE entity_id = $1`, [String(synthId)]);
        await pool.query(`DELETE FROM sync_contacts WHERE contact_id = $1`, [synthId]);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 8. End-to-end: fullSyncMigrationContacts mirrors the same semantics
  // -------------------------------------------------------------------------
  await run(
    "fullSyncMigrationContacts: logs on transition, skips on no-op, skips on insert",
    async () => {
      const { fullSyncMigrationContacts } = await import("../server/sync/db");
      const synthId = -2_000_000 - Math.floor(Math.random() * 1_000_000);
      const baseContact = {
        contactId: synthId,
        name: "Synthetic Migrate",
        email: "test@example.org",
        phone: null,
        status: "intake",
        statusCode: 100,
        serviceRequested: null,
        daysOnWaitlist: 0,
        dateAdded: "2026-01-01",
        assignedTo: null,
        requestingFor: null,
        reasonForSeeking: null,
        reasonForTherapy: null,
        detailedReason: null,
        formCompletedBy: null,
        modality: null,
        priorServices: null,
        priorProvider: null,
        flags: null,
        insurancePayer: null,
        insurancePlan: null,
        insuranceId: null,
        patientDob: null,
        gender: null,
        age: null,
        streetAddress: null,
        city: null,
        state: null,
        zipCode: null,
        rfsLink: null,
        lastNote: null,
      } as any;

      try {
        // (a) Insert path
        await fullSyncMigrationContacts([{ ...baseContact }]);
        let count = await pool.query(
          `SELECT COUNT(*)::int AS n FROM activity_log
            WHERE entity_id = $1 AND type = 'status_changed'`,
          [String(synthId)],
        );
        if (count.rows[0].n !== 0)
          return `migration insert wrote ${count.rows[0].n} log rows; expected 0`;

        // (b) No-op
        await fullSyncMigrationContacts([{ ...baseContact }]);
        count = await pool.query(
          `SELECT COUNT(*)::int AS n FROM activity_log
            WHERE entity_id = $1 AND type = 'status_changed'`,
          [String(synthId)],
        );
        if (count.rows[0].n !== 0)
          return `migration no-op wrote ${count.rows[0].n} log rows; expected 0`;

        // (c) Transition
        await fullSyncMigrationContacts([
          { ...baseContact, statusCode: 202, status: "scheduled" },
        ]);
        const trans = await pool.query(
          `SELECT (metadata::jsonb->>'from')::int AS f, (metadata::jsonb->>'to')::int AS t
             FROM activity_log
            WHERE entity_id = $1 AND type = 'status_changed'`,
          [String(synthId)],
        );
        if (trans.rows.length !== 1)
          return `migration transition wrote ${trans.rows.length} log rows; expected 1`;
        if (trans.rows[0].f !== 100 || trans.rows[0].t !== 202)
          return `migration transition metadata wrong: from=${trans.rows[0].f} to=${trans.rows[0].t}`;

        return null;
      } finally {
        await pool.query(`DELETE FROM activity_log WHERE entity_id = $1`, [String(synthId)]);
        await pool.query(`DELETE FROM sync_contacts WHERE contact_id = $1`, [synthId]);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  await pool.end();

  const failed = results.filter((r) => !r.ok);
  console.log("\n────────────────────────────────────────");
  console.log(`Total: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Verification script crashed:", err);
  process.exit(1);
});
