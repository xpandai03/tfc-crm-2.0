/**
 * Reminders Database
 *
 * PostgreSQL database for storing email reminders.
 * Uses pg pool for async access.
 */

import { getPool } from "../db/pool";
import type { Reminder, CreateReminderParams, IntakeComment, AttentionFlag, CreateIntakeCommentParams } from "./types";

/**
 * Initialize the reminders-related tables (idempotent)
 */
export async function initRemindersTable(): Promise<void> {
  const pool = getPool();

  console.log("[reminders-db] Initializing tables...");

  // Create reminders table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      contact_name TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      reminder_text TEXT NOT NULL,
      due_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      is_second_reminder BOOLEAN NOT NULL DEFAULT false,
      parent_reminder_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      FOREIGN KEY (parent_reminder_id) REFERENCES reminders(id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_reminders_due_status
      ON reminders(due_at, status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_reminders_status
      ON reminders(status)
  `);

  // Create intake_comments table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS intake_comments (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      contact_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      author_initials TEXT NOT NULL,
      comment_text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_intake_comments_contact
      ON intake_comments(contact_id)
  `);

  // Create attention_flags table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attention_flags (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      flagged_by_email TEXT NOT NULL,
      flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cleared_by_email TEXT,
      cleared_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_attention_flags_contact
      ON attention_flags(contact_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_attention_flags_active
      ON attention_flags(cleared_at)
  `);

  // Create crm_providers table for editable/new providers
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_providers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      credentials TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      specialties TEXT NOT NULL DEFAULT '[]',
      age_groups TEXT NOT NULL DEFAULT '[]',
      insurances TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Type-drift fix: crm_providers.is_active came across as INTEGER during the
  // SQLite->Postgres migration (b8913bf) even though the DDL declares BOOLEAN.
  // As a result `WHERE is_active = true` threw "operator does not exist:
  // integer = boolean" on every getAllCrmProviders() call, which the CRM-merge
  // try/catch swallowed — so CRM-managed providers silently never appeared in
  // GET /api/providers (created rows persisted but were invisible).
  //
  // Convert the column to BOOLEAN. GUARDED: ALTER ... TYPE is not self-
  // idempotent, so we only run it while the column is still integer; once
  // converted this whole block is a no-op on subsequent boots. Wrapped in its
  // own try/catch so a failure here can't abort the rest of table init.
  // 0/1 convert cleanly to false/true via (is_active <> 0).
  try {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'crm_providers' AND column_name = 'is_active'`
    );
    if (rows[0] && rows[0].data_type === "integer") {
      await pool.query(`ALTER TABLE crm_providers ALTER COLUMN is_active DROP DEFAULT`);
      await pool.query(`ALTER TABLE crm_providers ALTER COLUMN is_active TYPE boolean USING (is_active <> 0)`);
      await pool.query(`ALTER TABLE crm_providers ALTER COLUMN is_active SET DEFAULT true`);
      await pool.query(`ALTER TABLE crm_providers ALTER COLUMN is_active SET NOT NULL`);
      console.log("[reminders-db] Converted crm_providers.is_active INTEGER -> BOOLEAN");
    }
  } catch (e) {
    console.error("[reminders-db] crm_providers.is_active type conversion FAILED:", e);
  }

  // Phase 1 (provider unification): add email as the universal join key, with a
  // case-insensitive UNIQUE index that doubles as the duplicate-from-retries
  // guard. Partial (WHERE email IS NOT NULL) so existing/blank-email rows don't
  // collide. Additive + idempotent — runs on boot, no RUN_MIGRATIONS dependency.
  // Nothing READS this column yet (Phase 1 only captures it).
  try {
    await pool.query(`ALTER TABLE crm_providers ADD COLUMN IF NOT EXISTS email TEXT`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS crm_providers_email_lower_uniq ON crm_providers (lower(email)) WHERE email IS NOT NULL`);
    console.log("[reminders-db] Ensured crm_providers.email column + case-insensitive partial-unique index");
  } catch (e) {
    console.error("[reminders-db] crm_providers.email column/index migration FAILED:", e);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_overrides (
      id SERIAL PRIMARY KEY,
      provider_name TEXT NOT NULL UNIQUE,
      specialties TEXT,
      insurances TEXT,
      populations TEXT,
      notes TEXT,
      age_groups TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Migrations: add columns that may be missing from existing databases
  try {
    await pool.query(`ALTER TABLE provider_overrides ADD COLUMN IF NOT EXISTS age_groups TEXT`);
    console.log("[reminders-db] Ensured age_groups column on provider_overrides");
  } catch {
    // Column already exists — ignore
  }

  // Roster soft-delete: a suppressed roster provider is hidden from the
  // provider list / pickers / matching feed (filtered in the GET merge by
  // normalized name). Additive + idempotent — runs on every boot, no
  // RUN_MIGRATIONS dependency. CRM-authoritative: survives the manual xlsx import.
  try {
    await pool.query(`ALTER TABLE provider_overrides ADD COLUMN IF NOT EXISTS suppressed BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE provider_overrides ADD COLUMN IF NOT EXISTS suppressed_at TIMESTAMPTZ`);
    console.log("[reminders-db] Ensured suppressed/suppressed_at columns on provider_overrides");
  } catch {
    // Columns already exist — ignore
  }

  // Provider availability — populated by the standalone Fly.io provider
  // availability form (separate app). Single integer accepting_clients +
  // optional special_considerations free-text. Keyed by lowercased email.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_availability (
      id                       SERIAL PRIMARY KEY,
      provider_email           TEXT NOT NULL UNIQUE,
      provider_name            TEXT,
      accepting_clients        INTEGER NOT NULL DEFAULT 0,
      special_considerations   TEXT,
      last_form_submitted_at   TIMESTAMPTZ,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Idempotent guards. Cheap insurance against any dev DB that may have
  // received the older 3-counts shape from earlier WIP. No prod data
  // exists yet.
  try {
    await pool.query(`ALTER TABLE provider_availability ADD COLUMN IF NOT EXISTS accepting_clients INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE provider_availability ADD COLUMN IF NOT EXISTS special_considerations TEXT`);
    await pool.query(`ALTER TABLE provider_availability DROP COLUMN IF EXISTS accepting_individual`);
    await pool.query(`ALTER TABLE provider_availability DROP COLUMN IF EXISTS accepting_couples`);
    await pool.query(`ALTER TABLE provider_availability DROP COLUMN IF EXISTS accepting_family`);
    await pool.query(`ALTER TABLE provider_availability DROP COLUMN IF EXISTS availability`);
  } catch {
    // Migration already applied or column doesn't exist — ignore
  }

  console.log("[reminders-db] Tables initialized successfully");
}

/**
 * Create a new reminder (and optional second reminder)
 */
export async function createReminder(params: CreateReminderParams): Promise<{
  id: number;
  secondId?: number;
}> {
  const pool = getPool();

  const sql = `
    INSERT INTO reminders (
      contact_id, contact_name, created_by_email, reminder_text,
      due_at, is_second_reminder, parent_reminder_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `;

  // Insert primary reminder
  const result = await pool.query(sql, [
    params.contactId,
    params.contactName,
    params.createdByEmail,
    params.reminderText,
    params.reminderDateTime,
    false, // is_second_reminder
    null,
  ]);

  const primaryId = result.rows[0].id;
  let secondId: number | undefined;

  // Insert second reminder if provided
  if (params.secondReminderDateTime) {
    const secondResult = await pool.query(sql, [
      params.contactId,
      params.contactName,
      params.createdByEmail,
      params.reminderText,
      params.secondReminderDateTime,
      true, // is_second_reminder
      primaryId,
    ]);
    secondId = secondResult.rows[0].id;
  }

  console.log(
    `[reminders-db] Created reminder ${primaryId}${secondId ? ` with second reminder ${secondId}` : ""}`
  );

  return { id: primaryId, secondId };
}

/**
 * Get all pending reminders that are due
 */
export async function getDueReminders(): Promise<Reminder[]> {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      id,
      contact_id AS "contactId",
      contact_name AS "contactName",
      created_by_email AS "createdByEmail",
      reminder_text AS "reminderText",
      due_at AS "dueAt",
      status,
      retry_count AS "retryCount",
      is_second_reminder AS "isSecondReminder",
      parent_reminder_id AS "parentReminderId",
      created_at AS "createdAt",
      sent_at AS "sentAt"
    FROM reminders
    WHERE status = 'pending'
      AND due_at::timestamptz <= NOW()
      AND retry_count < 3
    ORDER BY due_at ASC
  `);

  return result.rows as Reminder[];
}

/**
 * Mark reminder as sent
 */
export async function markReminderSent(id: number): Promise<void> {
  const pool = getPool();

  await pool.query(
    `
    UPDATE reminders
    SET status = 'sent', sent_at = NOW()
    WHERE id = $1
  `,
    [id]
  );

  console.log(`[reminders-db] Marked reminder ${id} as sent`);
}

/**
 * Mark reminder as failed and increment retry count
 */
export async function markReminderFailed(id: number): Promise<void> {
  const pool = getPool();

  await pool.query(
    `
    UPDATE reminders
    SET status = CASE WHEN retry_count >= 2 THEN 'failed' ELSE 'pending' END,
        retry_count = retry_count + 1
    WHERE id = $1
  `,
    [id]
  );

  console.log(`[reminders-db] Marked reminder ${id} as failed, incremented retry count`);
}

/**
 * Get reminder stats for monitoring
 */
export async function getReminderStats(): Promise<{
  pending: number;
  sent: number;
  failed: number;
}> {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      status,
      COUNT(*)::int AS count
    FROM reminders
    GROUP BY status
  `);

  const rows = result.rows as { status: string; count: number }[];

  const stats = { pending: 0, sent: 0, failed: 0 };
  rows.forEach((row) => {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = row.count;
    }
  });

  return stats;
}

// ============================================================================
// Intake Comments
// ============================================================================

/**
 * Get all comments for a contact, newest first
 */
export async function getIntakeComments(contactId: number): Promise<IntakeComment[]> {
  const pool = getPool();

  const result = await pool.query(
    `
    SELECT
      id,
      contact_id AS "contactId",
      contact_name AS "contactName",
      author_email AS "authorEmail",
      author_initials AS "authorInitials",
      comment_text AS "commentText",
      created_at AS "createdAt"
    FROM intake_comments
    WHERE contact_id = $1
    ORDER BY created_at DESC
  `,
    [contactId]
  );

  return result.rows as IntakeComment[];
}

/**
 * Create a new intake comment and auto-create attention flag if none active
 */
export async function createIntakeComment(params: CreateIntakeCommentParams): Promise<{
  commentId: number;
  flagCreated: boolean;
}> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Insert comment
    const commentResult = await client.query(
      `
      INSERT INTO intake_comments (contact_id, contact_name, author_email, author_initials, comment_text)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `,
      [
        params.contactId,
        params.contactName,
        params.authorEmail,
        params.authorInitials,
        params.commentText,
      ]
    );

    const commentId = commentResult.rows[0].id;

    // Auto-create attention flag if no active flag exists
    let flagCreated = false;
    const existingFlag = await client.query(
      `
      SELECT id FROM attention_flags
      WHERE contact_id = $1 AND cleared_at IS NULL
    `,
      [params.contactId]
    );

    if (existingFlag.rows.length === 0) {
      await client.query(
        `
        INSERT INTO attention_flags (contact_id, flagged_by_email)
        VALUES ($1, $2)
      `,
        [params.contactId, params.authorEmail]
      );
      flagCreated = true;
      console.log(`[intake-comments] Auto-created attention flag for contact ${params.contactId}`);
    }

    await client.query("COMMIT");

    console.log(`[intake-comments] Created comment ${commentId} for contact ${params.contactId}`);
    return { commentId, flagCreated };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// Attention Flags
// ============================================================================

/**
 * Get all active (uncleared) attention flags
 */
export async function getActiveAttentionFlags(): Promise<AttentionFlag[]> {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      id,
      contact_id AS "contactId",
      flagged_by_email AS "flaggedByEmail",
      flagged_at AS "flaggedAt",
      cleared_by_email AS "clearedByEmail",
      cleared_at AS "clearedAt"
    FROM attention_flags
    WHERE cleared_at IS NULL
    ORDER BY flagged_at DESC
  `);

  return result.rows as AttentionFlag[];
}

/**
 * Clear an attention flag for a contact
 */
export async function clearAttentionFlag(contactId: number, clearedByEmail: string): Promise<boolean> {
  const pool = getPool();

  const result = await pool.query(
    `
    UPDATE attention_flags
    SET cleared_by_email = $1, cleared_at = NOW()
    WHERE contact_id = $2 AND cleared_at IS NULL
  `,
    [clearedByEmail, contactId]
  );

  const cleared = (result.rowCount ?? 0) > 0;
  if (cleared) {
    console.log(`[attention-flags] Cleared flag for contact ${contactId} by ${clearedByEmail}`);
  }
  return cleared;
}

// ============================================================================
// CRM Providers (editable / user-created providers)
// ============================================================================

export interface CrmProvider {
  id: number;
  name: string;
  credentials: string;
  location: string;
  email: string | null;    // Phase 1: universal join key (UNIQUE on lower(email)). NULL = not captured yet.
  specialties: string[];   // stored as JSON array
  ageGroups: string[];     // stored as JSON array
  insurances: string[];    // stored as JSON array
  notes: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCrmProviderParams {
  name: string;
  credentials?: string;
  location?: string;
  email?: string;
  specialties?: string[];
  ageGroups?: string[];
  insurances?: string[];
  notes?: string;
}

// Normalize an email input for storage: trim; empty/whitespace -> NULL so a
// blank email never collides under the partial-unique index or stores "".
function normalizeEmailForStorage(email: string | undefined | null): string | null {
  const v = (email ?? "").trim();
  return v === "" ? null : v;
}

export async function getAllCrmProviders(): Promise<CrmProvider[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, credentials, location, email, specialties, age_groups, insurances, notes,
           is_active, created_at, updated_at
    FROM crm_providers
    WHERE is_active = true
    ORDER BY name ASC
  `);

  return result.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    credentials: row.credentials,
    location: row.location,
    email: row.email ?? null,
    specialties: JSON.parse(row.specialties || "[]"),
    ageGroups: JSON.parse(row.age_groups || "[]"),
    insurances: JSON.parse(row.insurances || "[]"),
    notes: row.notes,
    isActive: row.is_active === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getCrmProviderById(id: number): Promise<CrmProvider | null> {
  const pool = getPool();
  const result = await pool.query(
    `
    SELECT id, name, credentials, location, email, specialties, age_groups, insurances, notes,
           is_active, created_at, updated_at
    FROM crm_providers WHERE id = $1
  `,
    [id]
  );

  const row = result.rows[0] as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    credentials: row.credentials,
    location: row.location,
    email: row.email ?? null,
    specialties: JSON.parse(row.specialties || "[]"),
    ageGroups: JSON.parse(row.age_groups || "[]"),
    insurances: JSON.parse(row.insurances || "[]"),
    notes: row.notes,
    isActive: row.is_active === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createCrmProvider(params: CreateCrmProviderParams): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `
    INSERT INTO crm_providers (name, credentials, location, email, specialties, age_groups, insurances, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `,
    [
      params.name.trim(),
      params.credentials?.trim() || "",
      params.location?.trim() || "",
      normalizeEmailForStorage(params.email),
      JSON.stringify(params.specialties || []),
      JSON.stringify(params.ageGroups || []),
      JSON.stringify(params.insurances || []),
      params.notes?.trim() || "",
    ]
  );
  const id = result.rows[0].id;
  console.log(`[crm-providers] Created provider ${id}: ${params.name}`);
  return id;
}

export async function updateCrmProvider(id: number, updates: Partial<CreateCrmProviderParams>): Promise<boolean> {
  const pool = getPool();
  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) { setClauses.push(`name = $${paramIndex++}`); values.push(updates.name.trim()); }
  if (updates.credentials !== undefined) { setClauses.push(`credentials = $${paramIndex++}`); values.push(updates.credentials.trim()); }
  if (updates.location !== undefined) { setClauses.push(`location = $${paramIndex++}`); values.push(updates.location.trim()); }
  if (updates.email !== undefined) { setClauses.push(`email = $${paramIndex++}`); values.push(normalizeEmailForStorage(updates.email)); }
  if (updates.specialties !== undefined) { setClauses.push(`specialties = $${paramIndex++}`); values.push(JSON.stringify(updates.specialties)); }
  if (updates.ageGroups !== undefined) { setClauses.push(`age_groups = $${paramIndex++}`); values.push(JSON.stringify(updates.ageGroups)); }
  if (updates.insurances !== undefined) { setClauses.push(`insurances = $${paramIndex++}`); values.push(JSON.stringify(updates.insurances)); }
  if (updates.notes !== undefined) { setClauses.push(`notes = $${paramIndex++}`); values.push(updates.notes.trim()); }

  if (setClauses.length === 0) return false;

  setClauses.push("updated_at = NOW()");
  values.push(id);

  const result = await pool.query(
    `UPDATE crm_providers SET ${setClauses.join(", ")} WHERE id = $${paramIndex} AND is_active = true`,
    values
  );

  console.log(`[crm-providers] Updated provider ${id}: ${result.rowCount} rows`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Soft-delete (deactivate) a CRM provider by flipping is_active to false.
 * All read paths filter WHERE is_active = true, so the provider disappears
 * from every list/picker while its row and all name-keyed history
 * (assignments, overrides, availability, activity log) are preserved. This is
 * NOT a hard delete — it is fully reversible by setting is_active back to true.
 * Returns true if an active row was deactivated (false if already inactive or
 * missing). Mirrors updateCrmProvider's WHERE ... AND is_active = true guard.
 */
export async function deactivateCrmProvider(id: number): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE crm_providers SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active = true`,
    [id]
  );
  console.log(`[crm-providers] Deactivated provider ${id}: ${result.rowCount} rows`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Reactivate a soft-deleted CRM provider (is_active back to true). Inverse of
 * deactivateCrmProvider. Returns true if an inactive row was reactivated.
 */
export async function reactivateCrmProvider(id: number): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE crm_providers SET is_active = true, updated_at = NOW() WHERE id = $1 AND is_active = false`,
    [id]
  );
  console.log(`[crm-providers] Reactivated provider ${id}: ${result.rowCount} rows`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * List soft-deleted (inactive) CRM providers, for the hidden-providers view.
 */
export async function getInactiveCrmProviders(): Promise<CrmProvider[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, credentials, location, email, specialties, age_groups, insurances, notes,
           is_active, created_at, updated_at
    FROM crm_providers
    WHERE is_active = false
    ORDER BY name ASC
  `);
  return result.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    credentials: row.credentials,
    location: row.location,
    email: row.email ?? null,
    specialties: JSON.parse(row.specialties || "[]"),
    ageGroups: JSON.parse(row.age_groups || "[]"),
    insurances: JSON.parse(row.insurances || "[]"),
    notes: row.notes,
    isActive: row.is_active === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

// ============================================================================
// Provider Overrides (edits to spreadsheet providers)
// ============================================================================

export interface ProviderOverride {
  id: number;
  providerName: string;
  specialties: string[] | null;
  insurances: string[] | null;
  populations: string[] | null;
  notes: string | null;
  ageGroups: Record<string, Record<string, string>> | null;
  suppressed: boolean;
  suppressedAt: string | null;
  updatedAt: string;
}

export interface UpsertOverrideParams {
  providerName: string;
  specialties?: string[];
  insurances?: string[];
  populations?: string[];
  notes?: string;
  ageGroups?: Record<string, Record<string, string>>;
  suppressed?: boolean;
}

export async function getProviderOverride(providerName: string): Promise<ProviderOverride | null> {
  const pool = getPool();
  const result = await pool.query(
    `
    SELECT id, provider_name, specialties, insurances, populations, notes, age_groups, suppressed, suppressed_at, updated_at
    FROM provider_overrides WHERE provider_name = $1
  `,
    [providerName]
  );

  const row = result.rows[0] as any;
  if (!row) return null;
  return {
    id: row.id,
    providerName: row.provider_name,
    specialties: row.specialties ? JSON.parse(row.specialties) : null,
    insurances: row.insurances ? JSON.parse(row.insurances) : null,
    populations: row.populations ? JSON.parse(row.populations) : null,
    notes: row.notes,
    ageGroups: row.age_groups ? JSON.parse(row.age_groups) : null,
    suppressed: row.suppressed === true,
    suppressedAt: row.suppressed_at ?? null,
    updatedAt: row.updated_at,
  };
}

export async function getAllProviderOverrides(): Promise<ProviderOverride[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, provider_name, specialties, insurances, populations, notes, age_groups, suppressed, suppressed_at, updated_at
    FROM provider_overrides ORDER BY provider_name ASC
  `);

  return result.rows.map((row: any) => ({
    id: row.id,
    providerName: row.provider_name,
    specialties: row.specialties ? JSON.parse(row.specialties) : null,
    insurances: row.insurances ? JSON.parse(row.insurances) : null,
    populations: row.populations ? JSON.parse(row.populations) : null,
    notes: row.notes,
    ageGroups: row.age_groups ? JSON.parse(row.age_groups) : null,
    suppressed: row.suppressed === true,
    suppressedAt: row.suppressed_at ?? null,
    updatedAt: row.updated_at,
  }));
}

export async function upsertProviderOverride(params: UpsertOverrideParams): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingResult = await client.query(
      `SELECT id FROM provider_overrides WHERE provider_name = $1`,
      [params.providerName]
    );

    if (existingResult.rows.length > 0) {
      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (params.specialties !== undefined) { setClauses.push(`specialties = $${paramIndex++}`); values.push(JSON.stringify(params.specialties)); }
      if (params.insurances !== undefined) { setClauses.push(`insurances = $${paramIndex++}`); values.push(JSON.stringify(params.insurances)); }
      if (params.populations !== undefined) { setClauses.push(`populations = $${paramIndex++}`); values.push(JSON.stringify(params.populations)); }
      if (params.notes !== undefined) { setClauses.push(`notes = $${paramIndex++}`); values.push(params.notes); }
      if (params.ageGroups !== undefined) { setClauses.push(`age_groups = $${paramIndex++}`); values.push(JSON.stringify(params.ageGroups)); }
      if (params.suppressed !== undefined) {
        setClauses.push(`suppressed = $${paramIndex++}`); values.push(params.suppressed);
        // suppressed_at literal is derived from a boolean — no injection risk.
        setClauses.push(`suppressed_at = ${params.suppressed ? "NOW()" : "NULL"}`);
      }

      if (setClauses.length === 0) {
        await client.query("ROLLBACK");
        return;
      }
      setClauses.push("updated_at = NOW()");
      values.push(params.providerName);

      await client.query(
        `UPDATE provider_overrides SET ${setClauses.join(", ")} WHERE provider_name = $${paramIndex}`,
        values
      );
    } else {
      await client.query(
        `
        INSERT INTO provider_overrides (provider_name, specialties, insurances, populations, notes, age_groups, suppressed, suppressed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, ${params.suppressed === true ? "NOW()" : "NULL"})
      `,
        [
          params.providerName,
          params.specialties ? JSON.stringify(params.specialties) : null,
          params.insurances ? JSON.stringify(params.insurances) : null,
          params.populations ? JSON.stringify(params.populations) : null,
          params.notes !== undefined ? params.notes : null,
          params.ageGroups ? JSON.stringify(params.ageGroups) : null,
          params.suppressed === true,
        ]
      );
    }

    await client.query("COMMIT");
    console.log(`[provider-overrides] Upserted override for: ${params.providerName}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// Provider Availability (self-reported via standalone availability form)
// ============================================================================

export interface ProviderAvailability {
  id: number;
  providerEmail: string;
  providerName: string | null;
  acceptingClients: number;
  specialConsiderations: string | null;
  lastFormSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProviderAvailabilityParams {
  providerEmail: string;
  providerName?: string | null;
  acceptingClients?: number;
  specialConsiderations?: string | null;
  lastFormSubmittedAt?: string | null;
}

function rowToProviderAvailability(row: any): ProviderAvailability {
  return {
    id: row.id,
    providerEmail: row.providerEmail,
    providerName: row.providerName ?? null,
    acceptingClients: row.acceptingClients ?? 0,
    specialConsiderations: row.specialConsiderations ?? null,
    lastFormSubmittedAt: row.lastFormSubmittedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getProviderAvailability(email: string): Promise<ProviderAvailability | undefined> {
  const pool = getPool();
  const result = await pool.query(
    `
    SELECT
      id,
      provider_email AS "providerEmail",
      provider_name AS "providerName",
      accepting_clients AS "acceptingClients",
      special_considerations AS "specialConsiderations",
      last_form_submitted_at AS "lastFormSubmittedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM provider_availability
    WHERE provider_email = $1
  `,
    [email.trim().toLowerCase()]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return rowToProviderAvailability(row);
}

export async function getAllProviderAvailability(): Promise<ProviderAvailability[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      id,
      provider_email AS "providerEmail",
      provider_name AS "providerName",
      accepting_clients AS "acceptingClients",
      special_considerations AS "specialConsiderations",
      last_form_submitted_at AS "lastFormSubmittedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM provider_availability
    ORDER BY provider_email ASC
  `);
  return result.rows.map(rowToProviderAvailability);
}

/**
 * Upsert availability row keyed by lowercased provider_email.
 *
 * Leave-untouched semantics: only fields explicitly present in `params`
 * (i.e. !== undefined) are written. Passing `null` for an optional field
 * (e.g. specialConsiderations: null) DOES clear the column. Omitting the
 * field leaves the existing value alone. This matches the
 * provider_overrides upsert pattern above.
 *
 * Form submissions always include acceptingClients and lastFormSubmittedAt;
 * manual PATCH edits never include lastFormSubmittedAt.
 */
export async function upsertProviderAvailability(
  params: UpsertProviderAvailabilityParams
): Promise<ProviderAvailability> {
  const pool = getPool();
  const client = await pool.connect();

  const normalizedEmail = params.providerEmail.trim().toLowerCase();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id FROM provider_availability WHERE provider_email = $1`,
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (params.providerName !== undefined) {
        setClauses.push(`provider_name = $${paramIndex++}`);
        values.push(params.providerName);
      }
      if (params.acceptingClients !== undefined) {
        setClauses.push(`accepting_clients = $${paramIndex++}`);
        values.push(params.acceptingClients);
      }
      if (params.specialConsiderations !== undefined) {
        setClauses.push(`special_considerations = $${paramIndex++}`);
        values.push(params.specialConsiderations);
      }
      if (params.lastFormSubmittedAt !== undefined) {
        setClauses.push(`last_form_submitted_at = $${paramIndex++}`);
        values.push(params.lastFormSubmittedAt);
      }

      if (setClauses.length > 0) {
        setClauses.push("updated_at = NOW()");
        values.push(normalizedEmail);
        await client.query(
          `UPDATE provider_availability SET ${setClauses.join(", ")} WHERE provider_email = $${paramIndex}`,
          values
        );
      }
    } else {
      await client.query(
        `
        INSERT INTO provider_availability (
          provider_email, provider_name,
          accepting_clients, special_considerations,
          last_form_submitted_at
        ) VALUES ($1, $2, $3, $4, $5)
      `,
        [
          normalizedEmail,
          params.providerName ?? null,
          params.acceptingClients ?? 0,
          params.specialConsiderations ?? null,
          params.lastFormSubmittedAt ?? null,
        ]
      );
    }

    await client.query("COMMIT");
    console.log(`[provider-availability] Upserted availability for: ${normalizedEmail}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Re-read so callers receive the canonical row (with timestamps).
  const fresh = await getProviderAvailability(normalizedEmail);
  if (!fresh) {
    throw new Error(`[provider-availability] Upsert succeeded but row not found for ${normalizedEmail}`);
  }
  return fresh;
}
