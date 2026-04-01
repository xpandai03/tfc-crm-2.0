/**
 * Sync Database Layer
 *
 * SQLite-backed cache of Excel waitlist data.
 * Populated by n8n background sync, read by CRM API endpoints.
 *
 * Design:
 * - sync_contacts: mirrors Excel waitlist rows (upsert on sync)
 * - sync_meta: singleton row tracking sync health
 * - All reads are <10ms (SQLite local file)
 * - Writes to Excel still go through n8n async
 */

import crypto from "crypto";
import { getDatabase } from "../reminders/db";

const MONTH_NAMES: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Validate and return YYYY-MM-DD or null. */
function toValidIsoDate(s: string): string | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, yr, mo, dy] = m;
  const y = parseInt(yr, 10), mon = parseInt(mo, 10), day = parseInt(dy, 10);
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  const d = new Date(y, mon - 1, day);
  if (d.getFullYear() !== y || d.getMonth() !== mon - 1 || d.getDate() !== day) return null;
  return s;
}

/** Normalize Excel serial dates (e.g. 32211) to ISO string (YYYY-MM-DD) at ingestion time. */
export function normalizeDateValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s === "") return null;

  // Strip datetime suffix: "2025-01-05T00:00:00Z" → "2025-01-05"
  const isoDatetime = s.match(/^(\d{4}-\d{2}-\d{2})[T ]/);
  if (isoDatetime) return toValidIsoDate(isoDatetime[1]);

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return toValidIsoDate(s);

  // YYYY/MM/DD → YYYY-MM-DD
  const slashIso = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashIso) return toValidIsoDate(`${slashIso[1]}-${slashIso[2]}-${slashIso[3]}`);

  // M/D/YYYY or MM/DD/YYYY
  const usDate = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usDate) {
    const mo = usDate[1].padStart(2, "0");
    const dy = usDate[2].padStart(2, "0");
    return toValidIsoDate(`${usDate[3]}-${mo}-${dy}`);
  }

  // Written month: "January 5, 2025" or "Jan 5, 2025"
  const written = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (written) {
    const monthIdx = MONTH_NAMES[written[1].toLowerCase()];
    if (monthIdx !== undefined) {
      const mo = String(monthIdx + 1).padStart(2, "0");
      const dy = written[2].padStart(2, "0");
      return toValidIsoDate(`${written[3]}-${mo}-${dy}`);
    }
  }

  // Numeric? Could be Excel serial.
  const num = parseFloat(s);
  if (!isNaN(num) && num > 15000 && num < 80000) {
    const excelEpoch = new Date(1899, 11, 30);
    const d = new Date(excelEpoch.getTime() + num * 86400000);
    return d.toISOString().split("T")[0]; // YYYY-MM-DD
  }

  // Unrecognized format — return null to trigger reconstruction fallback
  return null;
}

/** Reconstruct date_added from days_on_waitlist when date is missing. */
function deriveDateFromDays(daysValue: unknown): string | null {
  if (daysValue === undefined || daysValue === null) return null;
  const days = Number(daysValue);
  if (isNaN(days) || days < 0) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  now.setDate(now.getDate() - days);
  return now.toISOString().split("T")[0];
}

// ============================================================================
// Types
// ============================================================================

export interface SyncContact {
  contactId: number;
  name: string;
  email: string | null;
  phone: string | null;
  status: string | null;
  statusCode: number | null;
  serviceRequested: string | null;
  daysOnWaitlist: number | null;
  dateAdded: string | null;
  assignedTo: string | null;

  // Intake
  requestingFor: string | null;
  reasonForSeeking: string | null;
  reasonForTherapy: string | null;
  detailedReason: string | null;
  formCompletedBy: string | null;
  modality: string | null;
  referralSource: string | null;
  priorServices: string | null;
  priorProvider: string | null;
  preferredContact: string | null;
  custody: string | null;
  flags: string | null;
  priority: string | null;

  // Insurance
  insurancePayer: string | null;
  insurancePlan: string | null;
  insuranceId: string | null;
  insuranceStatus: string | null;
  referralAuth: string | null;
  referralStatus: string | null;

  // Demographics
  patientDob: string | null;
  gender: string | null;
  age: number | null;

  // Address
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  county: string | null;

  // Links
  rfsLink: string | null;
  documentLink: string | null;

  // Timeline
  lastContact: string | null;
  lastNote: string | null;

  // Sync metadata
  syncedAt: string;
  syncHash: string | null;
}

export interface SyncMeta {
  lastSyncAt: string | null;
  lastSyncRows: number;
  lastSyncMs: number;
  syncStatus: "ok" | "stale" | "error" | "never";
  errorMessage: string | null;
}

export interface SyncPayloadContact {
  contactId: number;
  [key: string]: unknown;
}

// ============================================================================
// Table Initialization
// ============================================================================

export function initSyncTables(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_contacts (
      contact_id        INTEGER PRIMARY KEY,
      name              TEXT NOT NULL,
      email             TEXT,
      phone             TEXT,
      status            TEXT,
      status_code       INTEGER,
      service_requested TEXT,
      days_on_waitlist  INTEGER,
      date_added        TEXT,
      assigned_to       TEXT,

      requesting_for    TEXT,
      reason_for_seeking TEXT,
      reason_for_therapy TEXT,
      detailed_reason    TEXT,
      form_completed_by  TEXT,
      modality           TEXT,
      referral_source    TEXT,
      prior_services     TEXT,
      prior_provider     TEXT,
      preferred_contact  TEXT,
      custody            TEXT,
      flags              TEXT,
      priority           TEXT,

      insurance_payer    TEXT,
      insurance_plan     TEXT,
      insurance_id       TEXT,
      insurance_status   TEXT,
      referral_auth      TEXT,
      referral_status    TEXT,

      patient_dob        TEXT,
      gender             TEXT,
      age                INTEGER,

      street_address     TEXT,
      city               TEXT,
      state              TEXT,
      zip_code           TEXT,
      county             TEXT,

      rfs_link           TEXT,
      document_link      TEXT,

      last_contact       TEXT,
      last_note          TEXT,

      synced_at          TEXT NOT NULL DEFAULT (datetime('now')),
      sync_hash          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_contacts_status_code
      ON sync_contacts(status_code);
    CREATE INDEX IF NOT EXISTS idx_sync_contacts_assigned
      ON sync_contacts(assigned_to);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      last_sync_at    TEXT,
      last_sync_rows  INTEGER DEFAULT 0,
      last_sync_ms    INTEGER DEFAULT 0,
      sync_status     TEXT DEFAULT 'never',
      error_message   TEXT
    );

    INSERT OR IGNORE INTO sync_meta (id) VALUES (1);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS form_submissions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      source      TEXT NOT NULL DEFAULT 'rfs',
      contact_id  INTEGER,
      name        TEXT NOT NULL,
      payload     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_form_submissions_created
      ON form_submissions(created_at DESC);
  `);

  console.log("[sync-db] Sync tables initialized");
}

// ============================================================================
// Hash Computation
// ============================================================================

function computeRowHash(contact: Record<string, unknown>): string {
  // Hash all data fields to detect changes (exclude sync metadata)
  const relevant = { ...contact };
  delete relevant.syncedAt;
  delete relevant.syncHash;
  const str = JSON.stringify(relevant, Object.keys(relevant).sort());
  return crypto.createHash("md5").update(str).digest("hex");
}

// ============================================================================
// Sync Operations
// ============================================================================

/**
 * Upsert all contacts from n8n sync payload.
 * Returns counts of synced, skipped (unchanged), and deleted rows.
 */
export function syncContacts(contacts: SyncPayloadContact[]): {
  synced: number;
  skipped: number;
  deleted: number;
  durationMs: number;
} {
  const db = getDatabase();
  const startMs = Date.now();

  const upsertStmt = db.prepare(`
    INSERT INTO sync_contacts (
      contact_id, name, email, phone, status, status_code,
      service_requested, days_on_waitlist, date_added, assigned_to,
      requesting_for, reason_for_seeking, reason_for_therapy, detailed_reason,
      form_completed_by, modality, referral_source, prior_services,
      prior_provider, preferred_contact, custody, flags, priority,
      insurance_payer, insurance_plan, insurance_id, insurance_status,
      referral_auth, referral_status,
      patient_dob, gender, age,
      street_address, city, state, zip_code, county,
      rfs_link, document_link,
      last_contact, last_note,
      synced_at, sync_hash
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      datetime('now'), ?
    ) ON CONFLICT(contact_id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      phone = excluded.phone,
      status = excluded.status,
      status_code = excluded.status_code,
      service_requested = excluded.service_requested,
      days_on_waitlist = excluded.days_on_waitlist,
      date_added = excluded.date_added,
      assigned_to = excluded.assigned_to,
      requesting_for = excluded.requesting_for,
      reason_for_seeking = excluded.reason_for_seeking,
      reason_for_therapy = excluded.reason_for_therapy,
      detailed_reason = excluded.detailed_reason,
      form_completed_by = excluded.form_completed_by,
      modality = excluded.modality,
      referral_source = excluded.referral_source,
      prior_services = excluded.prior_services,
      prior_provider = excluded.prior_provider,
      preferred_contact = excluded.preferred_contact,
      custody = excluded.custody,
      flags = excluded.flags,
      priority = excluded.priority,
      insurance_payer = excluded.insurance_payer,
      insurance_plan = excluded.insurance_plan,
      insurance_id = excluded.insurance_id,
      insurance_status = excluded.insurance_status,
      referral_auth = excluded.referral_auth,
      referral_status = excluded.referral_status,
      patient_dob = excluded.patient_dob,
      gender = excluded.gender,
      age = excluded.age,
      street_address = excluded.street_address,
      city = excluded.city,
      state = excluded.state,
      zip_code = excluded.zip_code,
      county = excluded.county,
      rfs_link = excluded.rfs_link,
      document_link = excluded.document_link,
      last_contact = excluded.last_contact,
      last_note = excluded.last_note,
      synced_at = datetime('now'),
      sync_hash = excluded.sync_hash
    WHERE excluded.sync_hash != sync_contacts.sync_hash OR sync_contacts.sync_hash IS NULL
  `);

  const getHashStmt = db.prepare(
    `SELECT sync_hash FROM sync_contacts WHERE contact_id = ?`
  );

  let synced = 0;
  let skipped = 0;

  // Run all upserts in a transaction for atomicity and speed
  const syncAll = db.transaction(() => {
    const incomingIds = new Set<number>();

    for (const raw of contacts) {
      if (raw.contactId === undefined || raw.contactId === null) continue;
      const id = Number(raw.contactId);
      if (isNaN(id)) continue;
      incomingIds.add(id);

      const hash = computeRowHash(raw);

      // Check if hash matches — skip if unchanged
      const existing = getHashStmt.get(id) as { sync_hash: string | null } | undefined;
      if (existing && existing.sync_hash === hash) {
        skipped++;
        continue;
      }

      const str = (v: unknown): string | null =>
        v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : null;
      const num = (v: unknown): number | null => {
        if (v === undefined || v === null) return null;
        const n = Number(v);
        return isNaN(n) ? null : n;
      };

      const normalizedDateAdded =
        normalizeDateValue(raw.dateAdded) ?? deriveDateFromDays(raw.daysOnWaitlist);

      upsertStmt.run(
        id,
        str(raw.name) || "Unknown",
        str(raw.email),
        str(raw.phone),
        str(raw.status),
        num(raw.statusCode),
        str(raw.serviceRequested),
        num(raw.daysOnWaitlist),
        normalizedDateAdded,
        str(raw.assignedTo),
        str(raw.requestingFor),
        str(raw.reasonForSeeking),
        str(raw.reasonForTherapy ?? raw["Reason for Therapy MCQ"] ?? raw["reasonForTherapyMCQ"]),
        str(raw.detailedReason ?? raw["DetailedReason"]),
        str(raw.formCompletedBy),
        str(raw.modality ?? raw["Desired Modality"] ?? raw["desiredModality"]),
        str(raw.referralSource),
        str(raw.priorServices),
        str(raw.priorProvider),
        str(raw.preferredContact ?? raw["preferredContactMethod"] ?? raw["contactPreference"]),
        str(raw.custody ?? raw["custodyStatus"]),
        str(raw.flags ?? raw["alert"]),
        str(raw.priority ?? raw["urgency"]),
        str(raw.insurancePayer ?? raw.insurance ?? raw["Primary Insurance Provider"]),
        str(raw.insurancePlan ?? raw["planName"]),
        str(raw.insuranceId ?? raw["memberId"] ?? raw["policyNumber"]),
        str(raw.insuranceStatus ?? raw["verificationStatus"]),
        str(raw.referralAuth ?? raw["authNumber"]),
        str(raw.referralStatus),
        normalizeDateValue(raw.patientDob ?? raw.dob ?? raw.dateOfBirth),
        str(raw.gender ?? raw["sex"]),
        num(raw.age),
        str(raw.streetAddress ?? raw.address ?? raw["street"]),
        str(raw.city),
        str(raw.state),
        str(raw.zipCode ?? raw.zip ?? raw["postalCode"]),
        str(raw.county),
        str(raw.rfsLink ?? raw.rfs ?? raw["sharepointLink"] ?? raw["formLink"]),
        str(raw.documentLink ?? raw.documents ?? raw["fileLink"]),
        str(raw.lastContact),
        str(raw.lastNote),
        hash,
      );
      synced++;
    }

    // Delete contacts no longer in Excel
    const allIds = db
      .prepare(`SELECT contact_id FROM sync_contacts`)
      .all() as { contact_id: number }[];

    let deleted = 0;
    const deleteStmt = db.prepare(`DELETE FROM sync_contacts WHERE contact_id = ?`);
    for (const row of allIds) {
      if (!incomingIds.has(row.contact_id)) {
        deleteStmt.run(row.contact_id);
        deleted++;
      }
    }

    return deleted;
  });

  const deleted = syncAll();
  const durationMs = Date.now() - startMs;

  // Update sync_meta
  db.prepare(`
    UPDATE sync_meta SET
      last_sync_at = datetime('now'),
      last_sync_rows = ?,
      last_sync_ms = ?,
      sync_status = 'ok',
      error_message = NULL
    WHERE id = 1
  `).run(contacts.length, durationMs);

  console.log(
    `[sync-db] Sync complete: ${synced} upserted, ${skipped} unchanged, ${deleted} deleted in ${durationMs}ms`
  );

  return { synced, skipped, deleted, durationMs };
}

/**
 * Record a sync error in sync_meta.
 */
export function recordSyncError(error: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE sync_meta SET
      sync_status = 'error',
      error_message = ?
    WHERE id = 1
  `).run(error);
}

// ============================================================================
// Read Operations (used by API endpoints)
// ============================================================================

/**
 * Get all contacts from the sync cache.
 * Returns them in the same shape the frontend expects.
 */
export function getAllSyncContacts(): SyncContact[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      contact_id as contactId,
      name, email, phone, status,
      status_code as statusCode,
      service_requested as serviceRequested,
      days_on_waitlist as daysOnWaitlist,
      date_added as dateAdded,
      assigned_to as assignedTo,
      requesting_for as requestingFor,
      reason_for_seeking as reasonForSeeking,
      reason_for_therapy as reasonForTherapy,
      detailed_reason as detailedReason,
      form_completed_by as formCompletedBy,
      modality,
      referral_source as referralSource,
      prior_services as priorServices,
      prior_provider as priorProvider,
      preferred_contact as preferredContact,
      custody, flags, priority,
      insurance_payer as insurancePayer,
      insurance_plan as insurancePlan,
      insurance_id as insuranceId,
      insurance_status as insuranceStatus,
      referral_auth as referralAuth,
      referral_status as referralStatus,
      patient_dob as patientDob,
      gender, age,
      street_address as streetAddress,
      city, state,
      zip_code as zipCode,
      county,
      rfs_link as rfsLink,
      document_link as documentLink,
      last_contact as lastContact,
      last_note as lastNote,
      synced_at as syncedAt,
      sync_hash as syncHash
    FROM sync_contacts
    ORDER BY name ASC
  `).all() as SyncContact[];

  return rows;
}

/**
 * Get a single contact by ID from the sync cache.
 */
export function getSyncContactById(contactId: number): SyncContact | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      contact_id as contactId,
      name, email, phone, status,
      status_code as statusCode,
      service_requested as serviceRequested,
      days_on_waitlist as daysOnWaitlist,
      date_added as dateAdded,
      assigned_to as assignedTo,
      requesting_for as requestingFor,
      reason_for_seeking as reasonForSeeking,
      reason_for_therapy as reasonForTherapy,
      detailed_reason as detailedReason,
      form_completed_by as formCompletedBy,
      modality,
      referral_source as referralSource,
      prior_services as priorServices,
      prior_provider as priorProvider,
      preferred_contact as preferredContact,
      custody, flags, priority,
      insurance_payer as insurancePayer,
      insurance_plan as insurancePlan,
      insurance_id as insuranceId,
      insurance_status as insuranceStatus,
      referral_auth as referralAuth,
      referral_status as referralStatus,
      patient_dob as patientDob,
      gender, age,
      street_address as streetAddress,
      city, state,
      zip_code as zipCode,
      county,
      rfs_link as rfsLink,
      document_link as documentLink,
      last_contact as lastContact,
      last_note as lastNote,
      synced_at as syncedAt,
      sync_hash as syncHash
    FROM sync_contacts
    WHERE contact_id = ?
  `).get(contactId) as SyncContact | undefined;

  return row || null;
}

/**
 * Get sync health metadata.
 */
export function getSyncMeta(): SyncMeta {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      last_sync_at as lastSyncAt,
      last_sync_rows as lastSyncRows,
      last_sync_ms as lastSyncMs,
      sync_status as syncStatus,
      error_message as errorMessage
    FROM sync_meta
    WHERE id = 1
  `).get() as SyncMeta | undefined;

  if (!row) {
    return {
      lastSyncAt: null,
      lastSyncRows: 0,
      lastSyncMs: 0,
      syncStatus: "never",
      errorMessage: null,
    };
  }

  // Check staleness: if last sync > 90s ago, mark as stale
  if (row.lastSyncAt && row.syncStatus === "ok") {
    const lastSync = new Date(row.lastSyncAt + "Z").getTime();
    const age = Date.now() - lastSync;
    if (age > 90_000) {
      return { ...row, syncStatus: "stale" };
    }
  }

  return row;
}

/**
 * Get distinct staff members from sync cache.
 */
export function getSyncStaffList(): string[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT DISTINCT assigned_to
    FROM sync_contacts
    WHERE assigned_to IS NOT NULL AND assigned_to != ''
    ORDER BY assigned_to ASC
  `).all() as { assigned_to: string }[];

  return rows.map((r) => r.assigned_to);
}

/**
 * Get sync contact count (quick check if sync has data).
 */
export function getSyncContactCount(): number {
  const db = getDatabase();
  const row = db.prepare(`SELECT COUNT(*) as count FROM sync_contacts`).get() as { count: number };
  return row.count;
}

// ============================================================================
// Direct Intake Operations (bypasses n8n/Excel entirely)
// ============================================================================

/**
 * Generate a unique contact_id for direct-intake contacts.
 * Uses 900_000+ range to avoid collision with n8n-sourced IDs (typically < 100k).
 */
export function generateIntakeContactId(): number {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT MAX(contact_id) as maxId FROM sync_contacts WHERE contact_id >= 900000`
  ).get() as { maxId: number | null };
  return (row.maxId ?? 899999) + 1;
}

/**
 * Insert a new contact created via /api/intake.
 * Writes directly to sync_contacts with full structured fields — no n8n, no Excel.
 */
export function insertIntakeContact(fields: {
  contactId: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  lastNote?: string | null;

  serviceRequested?: string | null;
  requestingFor?: string | null;
  reasonForSeeking?: string | null;
  reasonForTherapy?: string | null;
  detailedReason?: string | null;
  formCompletedBy?: string | null;
  modality?: string | null;
  referralSource?: string | null;
  priorServices?: string | null;
  priorProvider?: string | null;
  preferredContact?: string | null;
  custody?: string | null;
  flags?: string | null;
  priority?: string | null;

  insurancePayer?: string | null;
  insurancePlan?: string | null;
  insuranceId?: string | null;

  patientDob?: string | null;
  gender?: string | null;

  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  county?: string | null;
}): void {
  const db = getDatabase();
  const today = new Date().toISOString().split("T")[0];

  db.prepare(`
    INSERT INTO sync_contacts (
      contact_id, name, email, phone,
      status, status_code, service_requested,
      date_added, days_on_waitlist, assigned_to,

      requesting_for, reason_for_seeking, reason_for_therapy, detailed_reason,
      form_completed_by, modality, referral_source, prior_services,
      prior_provider, preferred_contact, custody, flags, priority,

      insurance_payer, insurance_plan, insurance_id,

      patient_dob, gender,

      street_address, city, state, zip_code, county,

      last_contact, last_note,
      synced_at, sync_hash
    ) VALUES (
      ?, ?, ?, ?,
      'New -- No Outreach', 100, ?,
      ?, 0, NULL,

      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,

      ?, ?, ?,

      ?, ?,

      ?, ?, ?, ?, ?,

      ?, ?,
      datetime('now'), ?
    )
  `).run(
    fields.contactId,
    fields.name,
    fields.email || null,
    fields.phone || null,
    fields.serviceRequested || null,
    today,

    fields.requestingFor || null,
    fields.reasonForSeeking || null,
    fields.reasonForTherapy || null,
    fields.detailedReason || null,
    fields.formCompletedBy || null,
    fields.modality || null,
    fields.referralSource || null,
    fields.priorServices || null,
    fields.priorProvider || null,
    fields.preferredContact || null,
    fields.custody || null,
    fields.flags || null,
    fields.priority || null,

    fields.insurancePayer || null,
    fields.insurancePlan || null,
    fields.insuranceId || null,

    fields.patientDob || null,
    fields.gender || null,

    fields.streetAddress || null,
    fields.city || null,
    fields.state || null,
    fields.zipCode || null,
    fields.county || null,

    today,
    fields.lastNote || null,
    `intake-${fields.contactId}`,
  );

  console.log(`[sync-db] Intake contact inserted: ${fields.contactId} (${fields.name})`);
}

// ============================================================================
// Write-Through Operations
// ============================================================================

/**
 * Update a contact's status in the sync cache (write-through).
 * Called before async n8n write so UI reflects change instantly.
 */
export function updateSyncContactStatus(contactId: number, statusCode: number, status: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE sync_contacts
    SET status_code = ?, status = ?, synced_at = datetime('now')
    WHERE contact_id = ?
  `).run(statusCode, status, contactId);
}

/**
 * Update a contact's assigned_to in the sync cache (write-through).
 */
export function updateSyncContactAssignment(contactId: number, assignedTo: string | null): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE sync_contacts
    SET assigned_to = ?, synced_at = datetime('now')
    WHERE contact_id = ?
  `).run(assignedTo, contactId);
}

/**
 * Append a note to a contact's last_note field in the sync cache (write-through).
 */
export function appendSyncContactNote(
  contactId: number,
  note: string,
  author: string,
  timestamp: string
): void {
  const db = getDatabase();
  const existing = db.prepare(
    `SELECT last_note FROM sync_contacts WHERE contact_id = ?`
  ).get(contactId) as { last_note: string | null } | undefined;

  // Prepend new note to existing (same format n8n uses in Excel)
  const newEntry = `${author} ${timestamp} ${note}`;
  const updated = existing?.last_note
    ? `${newEntry}\n${existing.last_note}`
    : newEntry;

  db.prepare(`
    UPDATE sync_contacts
    SET last_note = ?, last_contact = ?, synced_at = datetime('now')
    WHERE contact_id = ?
  `).run(updated, timestamp.split("T")[0], contactId);
}

/**
 * Enrich a sync contact with detailed data (from n8n contact snapshot).
 * Updates only non-null fields — preserves existing board data.
 */
export function enrichSyncContact(contactId: number, detailed: Record<string, unknown>): void {
  const db = getDatabase();

  const str = (v: unknown): string | null =>
    v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : null;
  const num = (v: unknown): number | null => {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };

  // Use existing waitlist days as fallback for date reconstruction if needed
  const existing = db
    .prepare(`SELECT days_on_waitlist as daysOnWaitlist FROM sync_contacts WHERE contact_id = ?`)
    .get(contactId) as { daysOnWaitlist: number | null } | undefined;
  const fallbackDays = existing?.daysOnWaitlist ?? null;
  const normalizedOrDerivedDateAdded =
    normalizeDateValue(detailed.dateAdded ?? detailed["date_added"])
    ?? deriveDateFromDays(detailed.daysOnWaitlist ?? fallbackDays);

  // Only update fields that have values in the detailed data
  const updates: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Array<[string, unknown]> = [
    ["email", str(detailed.email)],
    ["phone", str(detailed.phone)],
    ["date_added", normalizedOrDerivedDateAdded],
    ["requesting_for", str(detailed.requestingFor)],
    ["reason_for_seeking", str(detailed.reasonForSeeking)],
    ["reason_for_therapy", str(detailed.reasonForTherapy ?? detailed["Reason for Therapy MCQ"] ?? detailed["reasonForTherapyMCQ"])],
    ["detailed_reason", str(detailed.detailedReason ?? detailed["DetailedReason"])],
    ["form_completed_by", str(detailed.formCompletedBy)],
    ["modality", str(detailed.modality ?? detailed["Desired Modality"])],
    ["referral_source", str(detailed.referralSource)],
    ["prior_services", str(detailed.priorServices)],
    ["prior_provider", str(detailed.priorProvider)],
    ["preferred_contact", str(detailed.preferredContact ?? detailed["preferredContactMethod"])],
    ["custody", str(detailed.custody ?? detailed["custodyStatus"])],
    ["flags", str(detailed.flags ?? detailed["alert"])],
    ["priority", str(detailed.priority ?? detailed["urgency"])],
    ["insurance_payer", str(detailed.insurancePayer ?? detailed.insurance ?? detailed["Primary Insurance Provider"])],
    ["insurance_plan", str(detailed.insurancePlan ?? detailed["planName"])],
    ["insurance_id", str(detailed.insuranceId ?? detailed["memberId"] ?? detailed["policyNumber"])],
    ["insurance_status", str(detailed.insuranceStatus ?? detailed["verificationStatus"])],
    ["referral_auth", str(detailed.referralAuth ?? detailed["authNumber"])],
    ["referral_status", str(detailed.referralStatus)],
    ["patient_dob", normalizeDateValue(detailed.patientDob ?? detailed.dob ?? detailed.dateOfBirth)],
    ["gender", str(detailed.gender ?? detailed["sex"])],
    ["age", num(detailed.age)],
    ["street_address", str(detailed.streetAddress ?? detailed.address ?? detailed["street"])],
    ["city", str(detailed.city)],
    ["state", str(detailed.state)],
    ["zip_code", str(detailed.zipCode ?? detailed.zip ?? detailed["postalCode"])],
    ["county", str(detailed.county)],
    ["rfs_link", str(detailed.rfsLink ?? detailed.rfs ?? detailed["sharepointLink"] ?? detailed["formLink"])],
    ["document_link", str(detailed.documentLink ?? detailed.documents ?? detailed["fileLink"])],
    ["last_contact", str(detailed.lastContact)],
    ["last_note", str(detailed.lastNote)],
  ];

  for (const [col, val] of fieldMap) {
    if (val !== null) {
      updates.push(`${col} = ?`);
      values.push(val);
    }
  }

  if (updates.length === 0) return;

  updates.push("synced_at = datetime('now')");
  values.push(contactId);

  db.prepare(
    `UPDATE sync_contacts SET ${updates.join(", ")} WHERE contact_id = ?`
  ).run(...values);

  console.log(`[sync-db] Enriched contact ${contactId} with ${updates.length - 1} detailed fields`);
}

/**
 * Upsert a single contact (board + detailed data merged).
 * Used by the manual "Sync Contact Now" feature.
 * IMPORTANT: This does NOT delete other contacts — it only upserts one row.
 */
export function upsertSingleContact(contact: SyncPayloadContact): void {
  const db = getDatabase();
  const id = Number(contact.contactId);
  if (isNaN(id)) return;

  const hash = computeRowHash(contact);

  const str = (v: unknown): string | null =>
    v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : null;
  const num = (v: unknown): number | null => {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };

  const normalizedDateAdded =
    normalizeDateValue(contact.dateAdded) ?? deriveDateFromDays(contact.daysOnWaitlist);

  db.prepare(`
    INSERT INTO sync_contacts (
      contact_id, name, email, phone, status, status_code,
      service_requested, days_on_waitlist, date_added, assigned_to,
      requesting_for, reason_for_seeking, reason_for_therapy, detailed_reason,
      form_completed_by, modality, referral_source, prior_services,
      prior_provider, preferred_contact, custody, flags, priority,
      insurance_payer, insurance_plan, insurance_id, insurance_status,
      referral_auth, referral_status,
      patient_dob, gender, age,
      street_address, city, state, zip_code, county,
      rfs_link, document_link,
      last_contact, last_note,
      synced_at, sync_hash
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      datetime('now'), ?
    )
    ON CONFLICT(contact_id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      phone = excluded.phone,
      status = excluded.status,
      status_code = excluded.status_code,
      service_requested = excluded.service_requested,
      days_on_waitlist = excluded.days_on_waitlist,
      date_added = excluded.date_added,
      assigned_to = excluded.assigned_to,
      requesting_for = excluded.requesting_for,
      reason_for_seeking = excluded.reason_for_seeking,
      reason_for_therapy = excluded.reason_for_therapy,
      detailed_reason = excluded.detailed_reason,
      form_completed_by = excluded.form_completed_by,
      modality = excluded.modality,
      referral_source = excluded.referral_source,
      prior_services = excluded.prior_services,
      prior_provider = excluded.prior_provider,
      preferred_contact = excluded.preferred_contact,
      custody = excluded.custody,
      flags = excluded.flags,
      priority = excluded.priority,
      insurance_payer = excluded.insurance_payer,
      insurance_plan = excluded.insurance_plan,
      insurance_id = excluded.insurance_id,
      insurance_status = excluded.insurance_status,
      referral_auth = excluded.referral_auth,
      referral_status = excluded.referral_status,
      patient_dob = excluded.patient_dob,
      gender = excluded.gender,
      age = excluded.age,
      street_address = excluded.street_address,
      city = excluded.city,
      state = excluded.state,
      zip_code = excluded.zip_code,
      county = excluded.county,
      rfs_link = excluded.rfs_link,
      document_link = excluded.document_link,
      last_contact = excluded.last_contact,
      last_note = excluded.last_note,
      synced_at = datetime('now'),
      sync_hash = excluded.sync_hash
  `).run(
    id,
    str(contact.name) || "Unknown",
    str(contact.email),
    str(contact.phone),
    str(contact.status),
    num(contact.statusCode),
    str(contact.serviceRequested),
    num(contact.daysOnWaitlist),
    normalizedDateAdded,
    str(contact.assignedTo),
    str(contact.requestingFor),
    str(contact.reasonForSeeking),
    str(contact.reasonForTherapy ?? (contact as any)["Reason for Therapy MCQ"] ?? (contact as any)["reasonForTherapyMCQ"]),
    str(contact.detailedReason ?? (contact as any)["DetailedReason"]),
    str(contact.formCompletedBy),
    str(contact.modality ?? (contact as any)["Desired Modality"] ?? (contact as any)["desiredModality"]),
    str(contact.referralSource),
    str(contact.priorServices),
    str(contact.priorProvider),
    str(contact.preferredContact ?? (contact as any)["preferredContactMethod"] ?? (contact as any)["contactPreference"]),
    str(contact.custody ?? (contact as any)["custodyStatus"]),
    str(contact.flags ?? (contact as any)["alert"]),
    str(contact.priority ?? (contact as any)["urgency"]),
    str(contact.insurancePayer ?? contact.insurance ?? (contact as any)["Primary Insurance Provider"]),
    str(contact.insurancePlan ?? (contact as any)["planName"]),
    str(contact.insuranceId ?? (contact as any)["memberId"] ?? (contact as any)["policyNumber"]),
    str(contact.insuranceStatus ?? (contact as any)["verificationStatus"]),
    str(contact.referralAuth ?? (contact as any)["authNumber"]),
    str(contact.referralStatus),
    normalizeDateValue(contact.patientDob ?? contact.dob ?? contact.dateOfBirth),
    str(contact.gender ?? (contact as any)["sex"]),
    num(contact.age),
    str(contact.streetAddress ?? contact.address ?? (contact as any)["street"]),
    str(contact.city),
    str(contact.state),
    str(contact.zipCode ?? contact.zip ?? (contact as any)["postalCode"]),
    str(contact.county),
    str(contact.rfsLink ?? contact.rfs ?? (contact as any)["sharepointLink"] ?? (contact as any)["formLink"]),
    str(contact.documentLink ?? contact.documents ?? (contact as any)["fileLink"]),
    str(contact.lastContact),
    str(contact.lastNote),
    hash,
  );

  console.log(`[sync-db] Upserted single contact ${id} (no delete of other rows)`);
}

// ============================================================================
// Form Submissions (immutable audit log)
// ============================================================================

export interface FormSubmission {
  id: number;
  createdAt: string;
  source: string;
  contactId: number | null;
  name: string;
  payload: Record<string, unknown>;
}

export function insertFormSubmission(fields: {
  source: string;
  contactId: number;
  name: string;
  payload: unknown;
}): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO form_submissions (source, contact_id, name, payload)
    VALUES (?, ?, ?, ?)
  `).run(
    fields.source,
    fields.contactId,
    fields.name,
    JSON.stringify(fields.payload),
  );
}

export function getRecentSubmissions(limit: number = 50): FormSubmission[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      id,
      created_at  AS createdAt,
      source,
      contact_id  AS contactId,
      name,
      payload
    FROM form_submissions
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as Array<Omit<FormSubmission, "payload"> & { payload: string }>;

  return rows.map((r) => ({
    ...r,
    payload: JSON.parse(r.payload),
  }));
}

// ============================================================================
// Migration Operations (one-time Excel → CRM import)
// ============================================================================

export interface MigrationContact {
  contactId: number;
  name: string;
  email: string | null;
  phone: string | null;
  status: string | null;
  statusCode: number | null;
  serviceRequested: string | null;
  daysOnWaitlist: number | null;
  dateAdded: string | null;
  assignedTo: string | null;
  requestingFor: string | null;
  reasonForSeeking: string | null;
  reasonForTherapy: string | null;
  detailedReason: string | null;
  formCompletedBy: string | null;
  modality: string | null;
  priorServices: string | null;
  priorProvider: string | null;
  insurancePayer: string | null;
  insurancePlan: string | null;
  insuranceId: string | null;
  patientDob: string | null;
  gender: string | null;
  age: number | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  rfsLink: string | null;
  lastNote: string | null;
  flags: string | null;
}

/**
 * Insert migration contacts using INSERT OR IGNORE.
 * Skips rows where contact_id already exists — safe to re-run.
 * Returns per-row results for reporting.
 */
export function insertMigrationContacts(
  contacts: MigrationContact[]
): { migrated: number; skipped: number; errors: Array<{ contactId: number; message: string }> } {
  const db = getDatabase();
  let migrated = 0;
  let skipped = 0;
  const errors: Array<{ contactId: number; message: string }> = [];

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO sync_contacts (
      contact_id, name, email, phone, status, status_code,
      service_requested, days_on_waitlist, date_added, assigned_to,
      requesting_for, reason_for_seeking, reason_for_therapy, detailed_reason,
      form_completed_by, modality, referral_source, prior_services,
      prior_provider, preferred_contact, custody, flags, priority,
      insurance_payer, insurance_plan, insurance_id, insurance_status,
      referral_auth, referral_status,
      patient_dob, gender, age,
      street_address, city, state, zip_code, county,
      rfs_link, document_link,
      last_contact, last_note,
      synced_at, sync_hash
    ) VALUES (
      @contactId, @name, @email, @phone, @status, @statusCode,
      @serviceRequested, @daysOnWaitlist, @dateAdded, @assignedTo,
      @requestingFor, @reasonForSeeking, @reasonForTherapy, @detailedReason,
      @formCompletedBy, @modality, NULL, @priorServices,
      @priorProvider, NULL, NULL, @flags, NULL,
      @insurancePayer, @insurancePlan, @insuranceId, NULL,
      NULL, NULL,
      @patientDob, @gender, @age,
      @streetAddress, @city, @state, @zipCode, NULL,
      @rfsLink, NULL,
      NULL, @lastNote,
      datetime('now'), @syncHash
    )
  `);

  const runAll = db.transaction(() => {
    for (const c of contacts) {
      try {
        const result = insertStmt.run({
          ...c,
          syncHash: `migrate-${c.contactId}`,
        });
        if (result.changes > 0) migrated++;
        else skipped++;
      } catch (err) {
        errors.push({
          contactId: c.contactId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  runAll();
  return { migrated, skipped, errors };
}
