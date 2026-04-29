/**
 * Reverse migration for activity_log.created_at: TIMESTAMPTZ → TEXT.
 *
 * The forward migration runs automatically in initActivityTable() at boot.
 * This script provides the explicit rollback path required for reviewable,
 * reversible schema changes. Casts existing TIMESTAMPTZ values to ISO TEXT
 * to preserve the row contents (matches the pre-migration default of NOW()).
 *
 * Usage:
 *   npx tsx scripts/down-activity-created-at.ts
 *
 * Requires DATABASE_URL pointing to the target Postgres instance.
 */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const before = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'activity_log' AND column_name = 'created_at'
    `);
    const dataType = before.rows[0]?.data_type;
    console.log(`[down] activity_log.created_at current type: ${dataType ?? "(missing)"}`);

    if (dataType !== "timestamp with time zone") {
      console.log("[down] Nothing to do — column is not TIMESTAMPTZ.");
      return;
    }

    await pool.query(`
      ALTER TABLE activity_log
        ALTER COLUMN created_at DROP DEFAULT,
        ALTER COLUMN created_at TYPE TEXT USING created_at::text,
        ALTER COLUMN created_at SET DEFAULT (NOW());
    `);

    const after = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'activity_log' AND column_name = 'created_at'
    `);
    console.log(`[down] activity_log.created_at new type: ${after.rows[0]?.data_type}`);

    const sample = await pool.query(`
      SELECT id, created_at FROM activity_log ORDER BY id DESC LIMIT 3
    `);
    console.log("[down] Sample rows after revert:", sample.rows);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[down] Failed:", err);
  process.exit(1);
});
