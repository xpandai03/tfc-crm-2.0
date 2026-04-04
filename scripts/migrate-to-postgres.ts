/**
 * One-time migration script: SQLite → Postgres
 *
 * Reads all tables from the SQLite database and copies them to Postgres.
 * Safe to re-run (uses DROP TABLE IF EXISTS + CREATE).
 *
 * Usage:
 *   npx tsx scripts/migrate-to-postgres.ts
 *
 * Requires:
 *   DATABASE_URL environment variable pointing to Postgres
 *   SQLite database at ./reminders.db (dev) or /data/reminders.db (prod)
 */

import Database from "better-sqlite3";
import pg from "pg";
import path from "path";

const SQLITE_PATH =
  process.env.NODE_ENV === "production"
    ? "/data/reminders.db"
    : path.join(process.cwd(), "reminders.db");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

// Postgres schema — translated from SQLite CREATE TABLE statements
const PG_SCHEMA = `
-- Reminders
CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  contact_name TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  reminder_text TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  is_second_reminder INTEGER NOT NULL DEFAULT 0,
  parent_reminder_id INTEGER REFERENCES reminders(id),
  created_at TEXT NOT NULL DEFAULT (NOW()::TEXT),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_due_status ON reminders(due_at, status);

-- Intake comments
CREATE TABLE IF NOT EXISTS intake_comments (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  contact_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  author_initials TEXT NOT NULL,
  comment_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
);
CREATE INDEX IF NOT EXISTS idx_intake_comments_contact ON intake_comments(contact_id);

-- Attention flags
CREATE TABLE IF NOT EXISTS attention_flags (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  flagged_by_email TEXT NOT NULL,
  flagged_at TEXT NOT NULL DEFAULT (NOW()::TEXT),
  cleared_by_email TEXT,
  cleared_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attention_flags_contact ON attention_flags(contact_id);
CREATE INDEX IF NOT EXISTS idx_attention_flags_active ON attention_flags(cleared_at);

-- CRM providers
CREATE TABLE IF NOT EXISTS crm_providers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  credentials TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  specialties TEXT NOT NULL DEFAULT '[]',
  age_groups TEXT NOT NULL DEFAULT '[]',
  insurances TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (NOW()::TEXT),
  updated_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
);

-- Provider overrides
CREATE TABLE IF NOT EXISTS provider_overrides (
  id SERIAL PRIMARY KEY,
  provider_name TEXT NOT NULL UNIQUE,
  specialties TEXT,
  insurances TEXT,
  populations TEXT,
  notes TEXT,
  age_groups TEXT,
  updated_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
);

-- Sync contacts
CREATE TABLE IF NOT EXISTS sync_contacts (
  contact_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  status TEXT,
  status_code INTEGER,
  service_requested TEXT,
  days_on_waitlist INTEGER,
  date_added TEXT,
  assigned_to TEXT,
  requesting_for TEXT,
  reason_for_seeking TEXT,
  reason_for_therapy TEXT,
  detailed_reason TEXT,
  form_completed_by TEXT,
  modality TEXT,
  referral_source TEXT,
  prior_services TEXT,
  prior_provider TEXT,
  preferred_contact TEXT,
  custody TEXT,
  flags TEXT,
  priority TEXT,
  insurance_payer TEXT,
  insurance_plan TEXT,
  insurance_id TEXT,
  insurance_status TEXT,
  referral_auth TEXT,
  referral_status TEXT,
  patient_dob TEXT,
  gender TEXT,
  age INTEGER,
  street_address TEXT,
  city TEXT,
  state TEXT,
  zip_code TEXT,
  county TEXT,
  rfs_link TEXT,
  document_link TEXT,
  last_contact TEXT,
  last_note TEXT,
  synced_at TEXT NOT NULL DEFAULT (NOW()::TEXT),
  sync_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_contacts_status_code ON sync_contacts(status_code);
CREATE INDEX IF NOT EXISTS idx_sync_contacts_assigned ON sync_contacts(assigned_to);

-- Sync meta
CREATE TABLE IF NOT EXISTS sync_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at TEXT,
  last_sync_rows INTEGER DEFAULT 0,
  last_sync_ms INTEGER DEFAULT 0,
  sync_status TEXT DEFAULT 'never',
  error_message TEXT
);

-- Form submissions
CREATE TABLE IF NOT EXISTS form_submissions (
  id SERIAL PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (NOW()::TEXT),
  source TEXT NOT NULL DEFAULT 'rfs',
  form_type TEXT NOT NULL DEFAULT 'intake',
  submitted_at TEXT,
  contact_id INTEGER,
  name TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_form_submissions_created ON form_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submissions_form_type ON form_submissions(form_type);

-- Provider assignments
CREATE TABLE IF NOT EXISTS contact_provider_assignments (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  contact_name TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  credential TEXT NOT NULL,
  assignment_comment TEXT,
  assigned_by_email TEXT NOT NULL,
  assigned_by_initials TEXT NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (NOW()::TEXT),
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS idx_assignments_contact ON contact_provider_assignments(contact_id);

-- Activity log
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  entity_name TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);

-- Email snapshots
CREATE TABLE IF NOT EXISTS email_snapshots (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  sent_by_email TEXT NOT NULL,
  cc_emails TEXT NOT NULL DEFAULT '[]',
  sent_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_contact ON email_snapshots(contact_id);

-- Therapy notes records
CREATE TABLE IF NOT EXISTS therapy_notes_records (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL UNIQUE,
  contact_name TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  tn_status TEXT NOT NULL DEFAULT 'in_progress',
  tn_patient_url TEXT,
  tn_patient_id TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (NOW()::TEXT),
  updated_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tn_contact_id ON therapy_notes_records(contact_id);
`;

// Tables with SERIAL PKs (auto-increment) — need sequence reset after data copy
const SERIAL_TABLES = [
  "reminders", "intake_comments", "attention_flags", "crm_providers",
  "provider_overrides", "form_submissions", "contact_provider_assignments",
  "activity_log", "email_snapshots", "therapy_notes_records",
];

// Tables where PK is NOT auto-increment
const NON_SERIAL_TABLES = ["sync_contacts", "sync_meta"];

async function migrate() {
  console.log("=== SQLite → Postgres Migration ===\n");
  console.log("SQLite path:", SQLITE_PATH);
  console.log("Postgres URL:", DATABASE_URL!.replace(/:[^:@]+@/, ":****@"));

  // Open SQLite
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  console.log("\nSQLite opened successfully.");

  // Connect to Postgres
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  console.log("Postgres connected successfully.\n");

  try {
    // Step 1: Create schema
    console.log("--- Creating Postgres schema ---");
    await client.query(PG_SCHEMA);
    console.log("Schema created.\n");

    // Step 2: Get all tables from SQLite
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;

    console.log("Tables to migrate:", tables.map(t => t.name).join(", "));
    console.log("");

    // Step 3: Copy data table by table
    for (const { name: table } of tables) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];

      if (rows.length === 0) {
        console.log(`  ${table}: 0 rows (skipped)`);
        continue;
      }

      // Clear existing data in Postgres (idempotent)
      await client.query(`DELETE FROM ${table}`);

      // Get column names from first row
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      const insertSQL = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;

      // Insert rows in batches
      let inserted = 0;
      await client.query("BEGIN");
      for (const row of rows) {
        const values = columns.map(col => {
          const val = row[col];
          if (val === undefined) return null;
          return val;
        });
        await client.query(insertSQL, values);
        inserted++;
      }
      await client.query("COMMIT");

      console.log(`  ${table}: ${inserted} rows copied`);
    }

    // Step 4: Reset sequences for SERIAL tables
    console.log("\n--- Resetting sequences ---");
    for (const table of SERIAL_TABLES) {
      try {
        const result = await client.query(`SELECT MAX(id) as max_id FROM ${table}`);
        const maxId = result.rows[0]?.max_id;
        if (maxId !== null && maxId !== undefined) {
          await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), $1)`, [maxId]);
          console.log(`  ${table}: sequence reset to ${maxId}`);
        }
      } catch (err) {
        // Table might be empty or not have a sequence
        console.log(`  ${table}: no sequence to reset`);
      }
    }

    // Step 5: Insert sync_meta if missing
    try {
      await client.query("INSERT INTO sync_meta (id) VALUES (1) ON CONFLICT DO NOTHING");
    } catch {}

    // Step 6: Validation
    console.log("\n--- Validation ---");
    let allMatch = true;
    for (const { name: table } of tables) {
      const sqliteCount = (sqlite.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number }).cnt;
      const pgResult = await client.query(`SELECT COUNT(*) as cnt FROM ${table}`);
      const pgCount = parseInt(pgResult.rows[0].cnt);

      const match = sqliteCount === pgCount;
      if (!match) allMatch = false;
      console.log(`  ${table}: SQLite=${sqliteCount} Postgres=${pgCount} ${match ? "✓" : "✗ MISMATCH"}`);
    }

    console.log(`\n=== Migration ${allMatch ? "SUCCESSFUL ✓" : "HAS MISMATCHES ✗"} ===`);
  } catch (err) {
    console.error("\n!!! Migration failed:", err);
    await client.query("ROLLBACK").catch(() => {});
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

migrate();
