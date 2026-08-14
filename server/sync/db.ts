/**
 * Sync Database Layer
 *
 * Postgres-backed cache of Excel waitlist data.
 * Populated by n8n background sync, read by CRM API endpoints.
 *
 * Design:
 * - sync_contacts: mirrors Excel waitlist rows (upsert on sync)
 * - sync_meta: singleton row tracking sync health
 * - Writes to Excel still go through n8n async
 */

import crypto from "crypto";
import { getPool } from "../db/pool";
import { logStatusChange } from "../activity/db";
import {
  getStatusLabel,
  isActiveStatusCode,
  getUmbrellaForStatusCode,
} from "@shared/status-codes";
import { normalizeInsurance } from "@shared/insurance-utils";
import {
  normalizeModality,
  normalizeModalityTokens,
  getPrimaryModality,
  getModalityPriorities,
  matchesPrimaryModality,
} from "@shared/modality-utils";

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
  // Ordered modality priorities (p1 = top choice). NULL when never prioritized;
  // readers fall back to parsing `modality`. Use the accessors in
  // @shared/modality-utils rather than reading these directly.
  modalityP1: string | null;
  modalityP2: string | null;
  modalityP3: string | null;
  modalityP4: string | null;
  /** Paperwork Status — CRM-owned, NULL = not tracked. See shared/paperwork-status.ts. */
  paperworkStatus: string | null;
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

  // Origin
  intakeSource: string | null;

  // Preferred service language (e.g. "English"/"Spanish"); display-only.
  // Optional: only getSyncContactById selects it; board reads omit it.
  language?: string | null;

  // TN V2 scheduled appointment (CRM-owned)
  scheduledAppointmentDate: string | null;
  scheduledAppointmentTime: string | null;

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

export async function initSyncTables(): Promise<void> {
  const pool = getPool();

  await pool.query(`
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

      intake_source      TEXT DEFAULT 'website_form',

      -- TN V2 (Add to Schedule in TN Beta): staff-entered initial appointment.
      -- CRM-owned; never written by the n8n sync upsert (see DO UPDATE SET below).
      scheduled_appointment_date TEXT,
      scheduled_appointment_time TEXT,

      -- Modality priorities: the contact's modality selections as an ORDERED
      -- list (p1 = top choice). Canonical buckets from shared/modality-utils
      -- MODALITIES, NOT raw form strings — the raw text stays in modality.
      -- Reports/Insights count by p1 only; the pipeline filter matches ANY of
      -- p1..p4. NULL p1 means "not prioritized yet" and readers fall back to
      -- normalizing the modality string. CRM-owned; never written by the n8n
      -- sync upserts (excluded from every DO UPDATE SET below).
      modality_p1 TEXT,
      modality_p2 TEXT,
      modality_p3 TEXT,
      modality_p4 TEXT,

      -- Paperwork Status: has intake paperwork gone out / come back. Allowed
      -- values live in shared/paperwork-status.ts; NULL = not tracked yet.
      -- NOT a status code — no interaction with the status/umbrella cluster.
      -- CRM-owned; never written by the n8n sync upserts (excluded from every
      -- DO UPDATE SET below and from enrichSyncContact's fieldMap).
      paperwork_status TEXT,

      synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sync_hash          TEXT
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sync_contacts_status_code
      ON sync_contacts(status_code)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sync_contacts_assigned
      ON sync_contacts(assigned_to)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      last_sync_at    TIMESTAMPTZ,
      last_sync_rows  INTEGER DEFAULT 0,
      last_sync_ms    INTEGER DEFAULT 0,
      sync_status     TEXT DEFAULT 'never',
      error_message   TEXT
    )
  `);

  await pool.query(`
    INSERT INTO sync_meta (id) VALUES (1) ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS form_submissions (
      id            SERIAL PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source        TEXT NOT NULL DEFAULT 'rfs',
      form_type     TEXT NOT NULL DEFAULT 'intake',
      submitted_at  TEXT,
      contact_id    INTEGER,
      name          TEXT NOT NULL DEFAULT '',
      payload       TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_form_submissions_created
      ON form_submissions(created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_form_submissions_form_type
      ON form_submissions(form_type)
  `);

  // Additive column migrations — only run when RUN_MIGRATIONS=true to avoid
  // unnecessary ALTER TABLE pressure on every cold start during rapid deploys
  if (process.env.RUN_MIGRATIONS === "true") {
    console.log("[sync-db] RUN_MIGRATIONS=true — running column migrations");
    try {
      await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS form_type TEXT NOT NULL DEFAULT 'intake'`);
    } catch (_) { /* column already exists */ }
    try {
      await pool.query(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS submitted_at TEXT`);
    } catch (_) { /* column already exists */ }
    try {
      await pool.query(`ALTER TABLE sync_contacts ADD COLUMN IF NOT EXISTS source_submission_id INTEGER`);
    } catch (_) { /* column already exists */ }
    try {
      await pool.query(`ALTER TABLE sync_contacts ADD COLUMN IF NOT EXISTS intake_source TEXT DEFAULT 'website_form'`);
    } catch (_) { /* column already exists */ }
    // TN V2 scheduled appointment columns. Prod adds these manually via
    // migrations/add-scheduled-appointment-tn-v2.sql (schema-before-code, C16);
    // this block keeps fresh/non-prod DBs in sync without a manual step.
    try {
      await pool.query(`ALTER TABLE sync_contacts ADD COLUMN IF NOT EXISTS scheduled_appointment_date TEXT`);
    } catch (_) { /* column already exists */ }
    try {
      await pool.query(`ALTER TABLE sync_contacts ADD COLUMN IF NOT EXISTS scheduled_appointment_time TEXT`);
    } catch (_) { /* column already exists */ }
    // Contact preferred-language column (additive nullable; CRM-owned, never
    // written by the n8n sync upsert). Prod adds it via
    // migrations/add-language-column.sql (schema-before-code, C16); this keeps
    // fresh/non-prod DBs in sync without a manual step.
    try {
      await pool.query(`ALTER TABLE sync_contacts ADD COLUMN IF NOT EXISTS language TEXT`);
    } catch (_) { /* column already exists */ }
    // Modality priority columns. Prod adds these manually via
    // migrations/add-modality-priorities.sql (schema-before-code, C16); this
    // block keeps fresh/non-prod DBs in sync without a manual step. CRM-owned —
    // excluded from every sync upsert's DO UPDATE SET.
    try {
      await pool.query(
        `ALTER TABLE sync_contacts
           ADD COLUMN IF NOT EXISTS modality_p1 TEXT,
           ADD COLUMN IF NOT EXISTS modality_p2 TEXT,
           ADD COLUMN IF NOT EXISTS modality_p3 TEXT,
           ADD COLUMN IF NOT EXISTS modality_p4 TEXT`
      );
    } catch (_) { /* columns already exist */ }
    try {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_sync_contacts_modality_p1
           ON sync_contacts(modality_p1)`
      );
    } catch (_) { /* index already exists */ }
    // Paperwork status. Prod adds this manually via
    // migrations/add-paperwork-status.sql (schema-before-code, C16); this block
    // keeps fresh/non-prod DBs in sync without a manual step. CRM-owned —
    // excluded from every sync upsert's DO UPDATE SET.
    try {
      await pool.query(`ALTER TABLE sync_contacts ADD COLUMN IF NOT EXISTS paperwork_status TEXT`);
    } catch (_) { /* column already exists */ }
  }

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
export async function syncContacts(contacts: SyncPayloadContact[]): Promise<{
  synced: number;
  skipped: number;
  deleted: number;
  durationMs: number;
}> {
  const pool = getPool();
  const client = await pool.connect();
  const startMs = Date.now();

  let synced = 0;
  let skipped = 0;
  let deleted = 0;

  try {
    await client.query('BEGIN');

    const incomingIds = new Set<number>();

    const upsertSql = `
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
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20, $21, $22, $23,
        $24, $25, $26, $27,
        $28, $29,
        $30, $31, $32,
        $33, $34, $35, $36, $37,
        $38, $39,
        $40, $41,
        NOW(), $42
      ) ON CONFLICT(contact_id) DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        -- status/status_code CRM-owned (COALESCE): the Sheet only fills them when the CRM has none.
        status = COALESCE(sync_contacts.status, EXCLUDED.status),
        status_code = COALESCE(sync_contacts.status_code, EXCLUDED.status_code),
        service_requested = EXCLUDED.service_requested,
        days_on_waitlist = EXCLUDED.days_on_waitlist,
        date_added = EXCLUDED.date_added,
        -- assigned_to intentionally omitted: CRM fully owns it (incl. unassign=null); the INSERT still seeds new contacts.
        requesting_for = EXCLUDED.requesting_for,
        reason_for_seeking = EXCLUDED.reason_for_seeking,
        reason_for_therapy = EXCLUDED.reason_for_therapy,
        detailed_reason = EXCLUDED.detailed_reason,
        form_completed_by = EXCLUDED.form_completed_by,
        -- modality CRM-owned (COALESCE): the Sheet only fills it when the CRM
        -- has none. Staff edits and the priority columns derived from it must
        -- survive a sync. modality_p1..p4 are omitted entirely — unenumerated
        -- columns are never touched by this upsert.
        modality = COALESCE(sync_contacts.modality, EXCLUDED.modality),
        referral_source = EXCLUDED.referral_source,
        prior_services = EXCLUDED.prior_services,
        prior_provider = EXCLUDED.prior_provider,
        preferred_contact = EXCLUDED.preferred_contact,
        custody = EXCLUDED.custody,
        flags = EXCLUDED.flags,
        priority = EXCLUDED.priority,
        insurance_payer = EXCLUDED.insurance_payer,
        insurance_plan = EXCLUDED.insurance_plan,
        insurance_id = EXCLUDED.insurance_id,
        insurance_status = EXCLUDED.insurance_status,
        referral_auth = EXCLUDED.referral_auth,
        referral_status = EXCLUDED.referral_status,
        patient_dob = EXCLUDED.patient_dob,
        gender = EXCLUDED.gender,
        age = EXCLUDED.age,
        street_address = EXCLUDED.street_address,
        city = EXCLUDED.city,
        state = EXCLUDED.state,
        zip_code = EXCLUDED.zip_code,
        county = EXCLUDED.county,
        rfs_link = EXCLUDED.rfs_link,
        document_link = EXCLUDED.document_link,
        last_contact = EXCLUDED.last_contact,
        last_note = CASE WHEN sync_contacts.last_note IS NOT NULL AND sync_contacts.last_note != '' THEN sync_contacts.last_note ELSE EXCLUDED.last_note END,
        synced_at = NOW(),
        sync_hash = EXCLUDED.sync_hash
      WHERE EXCLUDED.sync_hash != sync_contacts.sync_hash OR sync_contacts.sync_hash IS NULL
    `;

    for (const raw of contacts) {
      if (raw.contactId === undefined || raw.contactId === null) continue;
      const id = Number(raw.contactId);
      if (isNaN(id)) continue;
      incomingIds.add(id);

      const hash = computeRowHash(raw);

      // Check if hash matches — skip if unchanged
      const existingResult = await client.query(
        `SELECT sync_hash FROM sync_contacts WHERE contact_id = $1`, [id]
      );
      const existing = existingResult.rows[0] as { sync_hash: string | null } | undefined;
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

      await client.query(upsertSql, [
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
      ]);
      synced++;
    }

    // Delete contacts no longer in Excel (only n8n-sourced IDs < 900k)
    // CRM-native contacts (900k+) are created via /api/intake and must survive sync
    const allIdsResult = await client.query(`SELECT contact_id FROM sync_contacts WHERE contact_id < 900000`);
    const allIds = allIdsResult.rows as { contact_id: number }[];

    for (const row of allIds) {
      if (!incomingIds.has(row.contact_id)) {
        await client.query(`DELETE FROM sync_contacts WHERE contact_id = $1`, [row.contact_id]);
        deleted++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const durationMs = Date.now() - startMs;

  // Update sync_meta
  await pool.query(`
    UPDATE sync_meta SET
      last_sync_at = NOW(),
      last_sync_rows = $1,
      last_sync_ms = $2,
      sync_status = 'ok',
      error_message = NULL
    WHERE id = 1
  `, [contacts.length, durationMs]);

  console.log(
    `[sync-db] Sync complete: ${synced} upserted, ${skipped} unchanged, ${deleted} deleted in ${durationMs}ms`
  );

  return { synced, skipped, deleted, durationMs };
}

/**
 * Record a sync error in sync_meta.
 */
export async function recordSyncError(error: string): Promise<void> {
  const pool = getPool();
  await pool.query(`
    UPDATE sync_meta SET
      sync_status = 'error',
      error_message = $1
    WHERE id = 1
  `, [error]);
}

// ============================================================================
// Read Operations (used by API endpoints)
// ============================================================================

/**
 * Get all contacts from the sync cache.
 * Returns them in the same shape the frontend expects.
 */
export async function getAllSyncContacts(): Promise<SyncContact[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      contact_id AS "contactId",
      name, email, phone, status,
      status_code AS "statusCode",
      service_requested AS "serviceRequested",
      days_on_waitlist AS "daysOnWaitlist",
      date_added AS "dateAdded",
      assigned_to AS "assignedTo",
      requesting_for AS "requestingFor",
      reason_for_seeking AS "reasonForSeeking",
      reason_for_therapy AS "reasonForTherapy",
      detailed_reason AS "detailedReason",
      form_completed_by AS "formCompletedBy",
      modality,
      modality_p1 AS "modalityP1",
      modality_p2 AS "modalityP2",
      modality_p3 AS "modalityP3",
      modality_p4 AS "modalityP4",
      paperwork_status AS "paperworkStatus",
      referral_source AS "referralSource",
      prior_services AS "priorServices",
      prior_provider AS "priorProvider",
      preferred_contact AS "preferredContact",
      custody, flags, priority,
      insurance_payer AS "insurancePayer",
      insurance_plan AS "insurancePlan",
      insurance_id AS "insuranceId",
      insurance_status AS "insuranceStatus",
      referral_auth AS "referralAuth",
      referral_status AS "referralStatus",
      patient_dob AS "patientDob",
      gender, age,
      street_address AS "streetAddress",
      city, state,
      zip_code AS "zipCode",
      county,
      rfs_link AS "rfsLink",
      document_link AS "documentLink",
      last_contact AS "lastContact",
      last_note AS "lastNote",
      intake_source AS "intakeSource",
      language AS "language",
      synced_at AS "syncedAt",
      sync_hash AS "syncHash"
    FROM sync_contacts
    ORDER BY name ASC
  `);

  return result.rows as SyncContact[];
}

// ============================================================================
// Export: Waitlist Snapshot
// ============================================================================

/**
 * Canonical column order — matches the operational Agent-Master spreadsheet exactly.
 * DO NOT reorder, rename, or remove columns without an explicit schema change decision.
 * Typos and trailing spaces are intentional (they match the real spreadsheet).
 */
export const WAITLIST_EXPORT_COLUMNS = [
  "ContactId",
  "Type",
  "Status",
  "First Name",
  "Middle Name",
  "Last Name",
  "Date Added To Waitlist2",
  "Days on Waitlist (running)",
  "Requesting Services For",
  "Form Completed By",
  "Notes added by agent",
  "Patient DOB",
  "Sex",
  "Gender Identity",
  "Street Address",
  "Apartment/Suite",
  "City",
  "State",
  "Zip Code",
  "Home Phone",
  "Mobile Phone",
  "Email",
  "Consent Emails",
  "Desired Modality",
  "Insurance Type",
  "Primary Insurance Provider",
  "Insurance ID Number",
  "Subscriber Relationship",
  "Subscriber Name",
  "Subscriber DOB",
  "Subscriber ID Number",
  "Secondary Insurance",
  "Detailed Reason",
  "Therapy Issues",
  "Prior Counseling",
  "When + Who",
  "Was TFC?",
  "Last Outcome",
  "Digital Signature",
  "Confirmation Accuracy",
  "Participant Name ",  // trailing space is intentional (matches spreadsheet)
  "Participant Email ", // trailing space is intentional
  "Participant Phone",
  "RFS LINK",
  "Date Added To Waitlist",
  "Date added to waitlist cleaned",
  "Editor",
  "Current Status",
  "Date Removed From Waitlist",
  "RUN ID",
  "Computed Addintion day", // typo is intentional (matches spreadsheet)
  "days on waitlist",
  "Full name",
  "Admin Assigned to Contact",
  "Inactive",
  "Reason for Therapy MCQ",
  "Attention Required",
] as const;

export type WaitlistExportRow = Record<(typeof WAITLIST_EXPORT_COLUMNS)[number], string | number>;

/**
 * Filter set for the waitlist export.
 *
 * Mirrors the waitlist list view's filter state 1:1 (see the filter useMemo in
 * client/src/components/waitlist/waitlist-list-view.tsx). The export must return
 * exactly what the user is looking at; before this existed the export ignored
 * every filter and always returned all rows.
 *
 * All fields optional — an absent/null field means "no constraint". An empty
 * object therefore reproduces the old unfiltered behavior, which is what the
 * n8n/API-key callers expect.
 */
export interface WaitlistExportFilters {
  hideInactive?: boolean;
  umbrella?: string | null;          // umbrella id (WL/PS/SCH/REF/PMR/INS)
  statusCodes?: number[] | null;     // explicit code allow-list (Insights drill-down)
  insurance?: string | null;         // normalized insurance bucket
  modality?: string | null;          // canonical modality bucket (matches ANY token)
  language?: string | null;          // exact "English"/"Spanish"
  reason?: string | null;            // one reasonForTherapy token
  serviceType?: string | null;       // exact requestingFor
  search?: string | null;            // case-insensitive substring of name
  // Assignment filter. Applied by the waitlist PAGE (not the list view) before
  // the list ever sees the contacts, so it must be honored here too or an
  // "Assigned to me" export would silently include everyone else's contacts.
  assignedTo?: string | null;        // staff email; matched case-insensitively
}

/** Effective status code for a row — mirrors the client's statusCode ?? stringStatusToCode. */
function exportStatusCode(r: Record<string, unknown>): number {
  const raw = r.status_code;
  if (raw === null || raw === undefined) return 100; // client's stringStatusToCode default
  const n = Number(raw);
  return Number.isNaN(n) ? 100 : n;
}

/**
 * Apply the list view's filter semantics to a raw sync_contacts row.
 *
 * Implemented in JS rather than SQL on purpose: the insurance and modality
 * predicates run through the SHARED normalizers, which cannot be expressed in
 * SQL without duplicating them. Reusing the shared functions is what keeps the
 * export and the on-screen list from drifting. Row counts here are ~1k, so the
 * in-process filter is not a performance concern.
 */
export function matchesWaitlistExportFilters(
  r: Record<string, unknown>,
  f: WaitlistExportFilters,
): boolean {
  const statusCode = exportStatusCode(r);

  if (f.hideInactive && !isActiveStatusCode(statusCode)) return false;

  if (f.umbrella && f.umbrella !== "all") {
    if (getUmbrellaForStatusCode(statusCode) !== f.umbrella) return false;
  }

  if (f.statusCodes && f.statusCodes.length > 0) {
    if (!f.statusCodes.includes(statusCode)) return false;
  }

  if (f.insurance && f.insurance !== "all") {
    if (normalizeInsurance(r.insurance_payer as string | null) !== f.insurance) return false;
  }

  // Priority-1 only, via the SAME shared predicate the list view calls — the
  // export exists to reproduce what's on screen, so it must never hold its own
  // copy of this rule.
  if (f.modality && f.modality !== "all") {
    const ok = matchesPrimaryModality(
      {
        modalityP1: r.modality_p1 as string | null,
        modalityP2: r.modality_p2 as string | null,
        modalityP3: r.modality_p3 as string | null,
        modalityP4: r.modality_p4 as string | null,
        modality: r.modality as string | null,
      },
      f.modality,
    );
    if (!ok) return false;
  }

  if (f.language && f.language !== "all") {
    if (((r.language as string | null) ?? "") !== f.language) return false;
  }

  // reasonForTherapy is stored comma-separated; match one token.
  if (f.reason && f.reason !== "all") {
    const raw = r.reason_for_therapy;
    const tokens = typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (!tokens.includes(f.reason)) return false;
  }

  if (f.serviceType && f.serviceType !== "all") {
    if (((r.requesting_for as string | null) ?? "").trim() !== f.serviceType) return false;
  }

  if (f.search && f.search.trim()) {
    const q = f.search.toLowerCase().trim();
    if (!String(r.name ?? "").toLowerCase().includes(q)) return false;
  }

  // Mirrors the page's ownership memo: empty/absent assigned_to never matches a
  // specific staff member.
  if (f.assignedTo && f.assignedTo !== "all") {
    const assigned = String(r.assigned_to ?? "").trim().toLowerCase();
    if (!assigned || assigned !== f.assignedTo.trim().toLowerCase()) return false;
  }

  return true;
}

/**
 * Returns a flat, deterministic snapshot of waitlist contacts.
 * Every row has all 57 columns matching the canonical Agent-Master spreadsheet.
 *
 * Pass `filters` to restrict the set to what the caller's list view is showing.
 * Omitting it returns every contact (the historical behavior, still used by the
 * API-key/n8n callers).
 *
 * Guarantees:
 * - Every row has identical keys in canonical order
 * - No null/undefined values ("" for strings, 0 for numbers)
 * - No nested objects or arrays
 * - Sorted by date_added ASC, contact_id ASC (oldest first, deterministic)
 * - `total` reflects the rows RETURNED (post-filter), not the table size
 */
export async function getWaitlistExportData(
  filters: WaitlistExportFilters = {},
): Promise<{ total: number; generatedAt: string; columns: readonly string[]; rows: WaitlistExportRow[] }> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      contact_id, name, email, phone,
      status, status_code,
      service_requested, days_on_waitlist, date_added,
      assigned_to, requesting_for, reason_for_seeking,
      reason_for_therapy, detailed_reason, form_completed_by,
      modality, referral_source, prior_services, prior_provider,
      preferred_contact, custody, flags, priority,
      insurance_payer, insurance_plan, insurance_id,
      insurance_status, referral_auth, referral_status,
      patient_dob, gender, age,
      street_address, city, state, zip_code, county,
      rfs_link, document_link,
      last_contact, last_note,
      synced_at,
      language,
      modality_p1, modality_p2, modality_p3, modality_p4
    FROM sync_contacts
    ORDER BY date_added ASC, contact_id ASC
  `);

  // Apply the caller's list-view filters before shaping the export rows.
  const rows = (result.rows as Record<string, unknown>[]).filter((r) =>
    matchesWaitlistExportFilters(r, filters),
  );

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const nowMs = now.getTime();
  const generatedAt = new Date().toISOString();

  const exportRows: WaitlistExportRow[] = rows.map((r) => {
    const s = (v: unknown) => String(v ?? "");
    const dateAdded = s(r.date_added);
    const fullName = s(r.name);
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    // Compute days on waitlist from dateAdded
    let daysOnWaitlist = 0;
    let cleanedDateAdded = "";
    if (dateAdded) {
      const parsed = new Date(dateAdded);
      if (!isNaN(parsed.getTime())) {
        daysOnWaitlist = Math.max(0, Math.floor((nowMs - parsed.getTime()) / 86400000));
        cleanedDateAdded = parsed.toISOString().split("T")[0];
      }
    }

    return {
      "ContactId": s(r.contact_id),
      "Type": "Contact",
      "Status": s(r.status_code),
      "First Name": firstName,
      "Middle Name": "",
      "Last Name": lastName,
      "Date Added To Waitlist2": dateAdded,
      "Days on Waitlist (running)": daysOnWaitlist,
      "Requesting Services For": s(r.requesting_for),
      "Form Completed By": s(r.form_completed_by),
      "Notes added by agent": s(r.last_note),
      "Patient DOB": s(r.patient_dob),
      "Sex": s(r.gender),
      "Gender Identity": "",
      "Street Address": s(r.street_address),
      "Apartment/Suite": "",
      "City": s(r.city),
      "State": s(r.state),
      "Zip Code": s(r.zip_code),
      "Home Phone": "",
      "Mobile Phone": s(r.phone),
      "Email": s(r.email),
      "Consent Emails": "",
      "Desired Modality": s(r.modality),
      "Insurance Type": s(r.insurance_plan),
      "Primary Insurance Provider": s(r.insurance_payer),
      "Insurance ID Number": s(r.insurance_id),
      "Subscriber Relationship": "",
      "Subscriber Name": "",
      "Subscriber DOB": "",
      "Subscriber ID Number": "",
      "Secondary Insurance": "",
      "Detailed Reason": s(r.detailed_reason || r.reason_for_seeking),
      "Therapy Issues": "",
      "Prior Counseling": s(r.prior_services),
      "When + Who": s(r.prior_provider),
      "Was TFC?": "",
      "Last Outcome": "",
      "Digital Signature": "",
      "Confirmation Accuracy": "",
      "Participant Name ": "",
      "Participant Email ": "",
      "Participant Phone": "",
      "RFS LINK": s(r.rfs_link),
      "Date Added To Waitlist": dateAdded,
      "Date added to waitlist cleaned": cleanedDateAdded,
      "Editor": "",
      "Current Status": s(r.status),
      "Date Removed From Waitlist": "",
      "RUN ID": "",
      "Computed Addintion day": "",
      "days on waitlist": daysOnWaitlist,
      "Full name": fullName,
      "Admin Assigned to Contact": s(r.assigned_to),
      "Inactive": "",
      "Reason for Therapy MCQ": s(r.reason_for_therapy),
      "Attention Required": s(r.flags),
    } satisfies WaitlistExportRow;
  });

  return { total: exportRows.length, generatedAt, columns: WAITLIST_EXPORT_COLUMNS, rows: exportRows };
}

// ============================================================================
// Referral Report Builder (Custom Report Builder — server side)
// ============================================================================
//
// Row grain: ONE row per intake submission — form_submissions where
// form_type='intake' and name NOT LIKE 'ZZ_%' — LEFT JOIN sync_contacts on
// contact_id for dimension columns. Re-submitters therefore produce multiple
// rows; this intentionally matches the COUNT(*) semantics of getReferralsCount
// (the live "Referrals in [month]" card). Submissions with no matching
// sync_contacts row emit a row with "Unknown" dimensions — never dropped.
//
// Date basis: form_submissions.created_at::timestamptz, America/Denver-bounded.
// The bound predicate is copied VERBATIM from getReferralsCount — no new
// timezone handling is invented. `to` is treated as an INCLUSIVE calendar day:
// internally the exclusive upper bound is (to + 1 day) at MT midnight, so
// from=2026-07-01 & to=2026-07-31 covers all of July and reconciles exactly
// with getReferralsCount('2026-07-01','2026-08-01') / the Insights July card.
//
// Dimension filtering happens in JS AFTER normalization, so a filter matches
// exactly what lands in the exported normalized column (including "Unknown").
//
// PHI: Name + DOB are appended as trailing columns ONLY when
// includeIdentifiers=true. The default export carries contact_id + age bucket +
// normalized dimensions only. The route writes an activity_log entry whenever
// identifiers are included (actor + the fact of an identified export).

// Server-side status DISPLAY labels. Replicated here on purpose — we do NOT
// import the client-only STATUS_LABELS map from client/src/lib/status-config.ts
// (that file is UI-coupled: umbrella grouping, legend descriptions, legacy
// string conversion). Keep this in sync with status-config.ts:STATUS_LABELS if
// the spreadsheet labels change. The canonical slug map lives in
// shared/status-codes.ts (getStatusLabel) and is unaffected.
const REFERRAL_REPORT_STATUS_LABELS: Record<number, string> = {
  100: "New -- No Outreach",
  101: "Left Voicemail",
  102: "Response Received",
  103: "Declined Services",
  104: "Inactive -- No Response",
  200: "Ready to Schedule",
  201: "Left Voicemail",
  202: "Scheduled",
  203: "No Response",
  204: "Declined",
  205: "Initial Appt Completed",
  206: "Rescheduling Initial Appointment",
  300: "Submitted for Review",
  400: "Insurance Not Accepted",
  402: "Referred Out",
  403: "Deferred Services",
  500: "Resources Need to be Sent",
};

export const REFERRAL_REPORT_BASE_COLUMNS = [
  "Referral Date",
  "Contact ID",
  "Service Type",
  "Age",
  "Age Bucket",
  "Modality (raw)",
  // "Modality (normalized)" is the COUNTED bucket: first priority when set,
  // else the normalized legacy string. Kept under its original name so existing
  // saved reports and downstream sheets don't break. "Modality (all)" carries
  // every selection in priority order for context.
  "Modality (normalized)",
  "Modality (all)",
  "Insurance (raw)",
  "Insurance (normalized)",
  "Current Status",
] as const;

// Appended (trailing) only when includeIdentifiers=true. Kept trailing so the
// base column indices never shift between identified / de-identified exports.
export const REFERRAL_REPORT_IDENTIFIER_COLUMNS = ["Name", "DOB"] as const;

export interface ReferralReportParams {
  from: string;                 // YYYY-MM-DD (inclusive, MT)
  to: string;                   // YYYY-MM-DD (inclusive calendar day, MT)
  serviceType?: string | null;  // filter on NORMALIZED service type
  modality?: string | null;     // filter on NORMALIZED modality
  insurance?: string | null;    // filter on NORMALIZED insurance category
  statusCode?: number | null;   // filter on numeric status_code (exact)
  includeIdentifiers?: boolean; // add Name + DOB columns (PHI)
}

export interface ReferralReportResult {
  columns: string[];
  rows: Record<string, string | number>[];
  summary: {
    totalSubmissions: number;
    distinctContacts: number;
    generatedAt: string;
    appliedFilters: Record<string, unknown>;
  };
}

/** Add one calendar day to a YYYY-MM-DD string (TZ-independent, UTC math). */
function addOneDayIso(ymd: string): string {
  const [y, m, d] = ymd.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/** Format a timestamp in America/Denver as "YYYY-MM-DD HH:mm" (24h, MT). */
function formatMtDateTime(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const d = value instanceof Date ? value : new Date(String(value));
  if (isNaN(d.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * Normalize service type to a canonical category, mirroring the couples/family
 * mapping in computeAppointmentAlertText (server/routes.ts ~400-410): reads
 * requesting_for with a fallback to service_requested, and folds the historical
 * spellings ("Couples", "My Partner") into the canonical "My Partner & Myself".
 * Unmapped non-empty values are preserved verbatim (managers can still pivot);
 * empty → "Unknown".
 */
function normalizeServiceType(
  requestingFor: string | null | undefined,
  serviceRequested: string | null | undefined,
): string {
  const req = (requestingFor ?? "").trim().toLowerCase();
  const svc = (serviceRequested ?? "").trim().toLowerCase();
  if (svc === "family" || req === "my family" || req === "family") return "My Family";
  if (
    svc === "my partner & myself" || svc === "couples" ||
    req === "my partner & myself" || req === "couples" || req === "my partner"
  ) return "My Partner & Myself";
  if (req === "myself" || svc === "myself") return "Myself";
  if (req === "my child" || svc === "my child") return "My Child";
  if (req === "other" || svc === "other") return "Other";
  const raw = (requestingFor ?? "").trim() || (serviceRequested ?? "").trim();
  return raw || "Unknown";
}

/**
 * Resolve age: prefer the stored `age` column, fall back to computing from
 * patient_dob (as of now), else null (→ "Age Unknown" bucket). Reuses
 * normalizeDateValue so mixed DOB formats coerce to YYYY-MM-DD first.
 */
function resolveAge(ageCol: unknown, dob: unknown): number | null {
  const a = Number(ageCol);
  if (ageCol !== null && ageCol !== undefined && ageCol !== "" && Number.isFinite(a) && a >= 0 && a < 130) {
    return Math.floor(a);
  }
  const iso = dob ? normalizeDateValue(String(dob)) : null;
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  const now = new Date();
  let age = now.getFullYear() - y;
  const beforeBirthday =
    now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d);
  if (beforeBirthday) age -= 1;
  if (age < 0 || age > 130) return null;
  return age;
}

function ageBucket(age: number | null): string {
  if (age === null) return "Age Unknown";
  if (age < 14) return "Child (<14)";
  if (age <= 17) return "Adolescent (14-17)";
  return "Adult (18+)";
}

/**
 * Build the referral report dataset. See the header comment above for row
 * grain, date semantics, filtering, and PHI rules.
 */
export async function getReferralReportData(params: ReferralReportParams): Promise<ReferralReportResult> {
  const pool = getPool();
  const from = params.from;
  const toExclusive = addOneDayIso(params.to); // `to` inclusive → exclusive upper bound at to+1 day

  // Date predicate copied VERBATIM from getReferralsCount (do not re-invent TZ).
  const result = await pool.query(
    `
    SELECT
      f.id                    AS submission_id,
      f.created_at::timestamptz AS created_at,
      f.contact_id            AS contact_id,
      c.name                  AS contact_name,
      c.requesting_for        AS requesting_for,
      c.service_requested     AS service_requested,
      c.modality              AS modality,
      c.modality_p1           AS modality_p1,
      c.modality_p2           AS modality_p2,
      c.modality_p3           AS modality_p3,
      c.modality_p4           AS modality_p4,
      c.insurance_payer       AS insurance_payer,
      c.patient_dob           AS patient_dob,
      c.age                   AS age,
      c.status_code           AS status_code
    FROM form_submissions f
    LEFT JOIN sync_contacts c ON c.contact_id = f.contact_id
    WHERE f.form_type = 'intake'
      AND f.created_at::timestamptz >= ($1::timestamp AT TIME ZONE 'America/Denver')
      AND f.created_at::timestamptz <  ($2::timestamp AT TIME ZONE 'America/Denver')
      AND f.name NOT LIKE 'ZZ_%'
    ORDER BY f.created_at::timestamptz ASC, f.id ASC
    `,
    [from, toExclusive],
  );

  const includeIdentifiers = params.includeIdentifiers === true;
  const columns: string[] = [
    ...REFERRAL_REPORT_BASE_COLUMNS,
    ...(includeIdentifiers ? REFERRAL_REPORT_IDENTIFIER_COLUMNS : []),
  ];

  // Canonicalize filter values through the SAME normalizers so a filter matches
  // the exported normalized column (e.g. insurance "Blue Cross Blue Shield
  // Turquoise Care" → "BlueCross BlueShield Turquoise Care").
  const wantService = params.serviceType ? normalizeServiceType(params.serviceType, null) : null;
  const wantModality = params.modality ? normalizeModality(params.modality) : null;
  const wantInsurance = params.insurance ? normalizeInsurance(params.insurance) : null;
  const wantStatus =
    params.statusCode === null || params.statusCode === undefined ? null : Number(params.statusCode);

  const rows: Record<string, string | number>[] = [];
  const contactIds = new Set<string>();

  for (const r of result.rows as Record<string, unknown>[]) {
    const serviceType = normalizeServiceType(
      r.requesting_for as string | null,
      r.service_requested as string | null,
    );
    const modalityRaw = r.modality == null ? "" : String(r.modality);
    // Reports count each contact ONCE, under their first priority. The waitlist
    // filter deliberately differs (match-any) — a contact open to two offices
    // appears under both there, but is counted only under their top choice here.
    const priorityFields = {
      modalityP1: r.modality_p1 as string | null,
      modalityP2: r.modality_p2 as string | null,
      modalityP3: r.modality_p3 as string | null,
      modalityP4: r.modality_p4 as string | null,
      modality: modalityRaw,
    };
    const modalityNorm = getPrimaryModality(priorityFields);
    const modalityAll = getModalityPriorities(priorityFields).join(", ");
    const insuranceRaw = r.insurance_payer == null ? "" : String(r.insurance_payer);
    const insuranceNorm = normalizeInsurance(insuranceRaw);
    const statusCode =
      r.status_code === null || r.status_code === undefined ? null : Number(r.status_code);
    const age = resolveAge(r.age, r.patient_dob);

    // Filters (post-normalization). Missing filter = no constraint.
    if (wantService && serviceType.toLowerCase() !== wantService.toLowerCase()) continue;
    if (wantModality && modalityNorm.toLowerCase() !== wantModality.toLowerCase()) continue;
    if (wantInsurance && insuranceNorm.toLowerCase() !== wantInsurance.toLowerCase()) continue;
    if (wantStatus !== null && statusCode !== wantStatus) continue;

    const contactId = r.contact_id == null ? "" : String(r.contact_id);
    if (contactId) contactIds.add(contactId);

    const statusLabel =
      statusCode !== null && REFERRAL_REPORT_STATUS_LABELS[statusCode]
        ? `${statusCode} — ${REFERRAL_REPORT_STATUS_LABELS[statusCode]}`
        : statusCode !== null
          ? String(statusCode)
          : "Unknown";

    const row: Record<string, string | number> = {
      "Referral Date": formatMtDateTime(r.created_at),
      "Contact ID": contactId,
      "Service Type": serviceType,
      "Age": age === null ? "" : age,
      "Age Bucket": ageBucket(age),
      "Modality (raw)": modalityRaw,
      "Modality (normalized)": modalityNorm,
      "Modality (all)": modalityAll,
      "Insurance (raw)": insuranceRaw,
      "Insurance (normalized)": insuranceNorm,
      "Current Status": statusLabel,
    };
    if (includeIdentifiers) {
      // PHI — only when explicitly requested.
      row["Name"] = r.contact_name == null ? "" : String(r.contact_name);
      row["DOB"] = r.patient_dob == null ? "" : String(r.patient_dob);
    }
    rows.push(row);
  }

  return {
    columns,
    rows,
    summary: {
      totalSubmissions: rows.length,
      distinctContacts: contactIds.size,
      generatedAt: new Date().toISOString(),
      appliedFilters: {
        from: params.from,
        to: params.to,
        serviceType: wantService,
        modality: wantModality,
        insurance: wantInsurance,
        statusCode: wantStatus,
        includeIdentifiers,
      },
    },
  };
}

/**
 * Get a single contact by ID from the sync cache.
 */
export async function getSyncContactById(contactId: number): Promise<SyncContact | null> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      contact_id AS "contactId",
      name, email, phone, status,
      status_code AS "statusCode",
      service_requested AS "serviceRequested",
      days_on_waitlist AS "daysOnWaitlist",
      date_added AS "dateAdded",
      assigned_to AS "assignedTo",
      requesting_for AS "requestingFor",
      reason_for_seeking AS "reasonForSeeking",
      reason_for_therapy AS "reasonForTherapy",
      detailed_reason AS "detailedReason",
      form_completed_by AS "formCompletedBy",
      modality,
      modality_p1 AS "modalityP1",
      modality_p2 AS "modalityP2",
      modality_p3 AS "modalityP3",
      modality_p4 AS "modalityP4",
      paperwork_status AS "paperworkStatus",
      referral_source AS "referralSource",
      prior_services AS "priorServices",
      prior_provider AS "priorProvider",
      preferred_contact AS "preferredContact",
      custody, flags, priority,
      insurance_payer AS "insurancePayer",
      insurance_plan AS "insurancePlan",
      insurance_id AS "insuranceId",
      insurance_status AS "insuranceStatus",
      referral_auth AS "referralAuth",
      referral_status AS "referralStatus",
      patient_dob AS "patientDob",
      gender, age,
      street_address AS "streetAddress",
      city, state,
      zip_code AS "zipCode",
      county,
      rfs_link AS "rfsLink",
      document_link AS "documentLink",
      last_contact AS "lastContact",
      last_note AS "lastNote",
      intake_source AS "intakeSource",
      language AS "language",
      scheduled_appointment_date AS "scheduledAppointmentDate",
      scheduled_appointment_time AS "scheduledAppointmentTime",
      synced_at AS "syncedAt",
      sync_hash AS "syncHash"
    FROM sync_contacts
    WHERE contact_id = $1
  `, [contactId]);

  return (result.rows[0] as SyncContact) || null;
}

/**
 * Get other contacts in the same household (matching email or phone).
 * Returns lightweight records for the Household Members UI.
 */
export async function getHouseholdMembers(contactId: number, email: string | null, phone: string | null): Promise<Array<{
  contactId: number;
  name: string;
  requestingFor: string | null;
  patientDob: string | null;
  assignedTo: string | null;
  statusCode: string | null;
}>> {
  // Exclude placeholder emails that would cause false household matches
  const PLACEHOLDER_EMAILS = [
    "none@gmail.com", "none@none.com", "unknown@gmail.com",
    "doesnot@haveone.com", "noemail@noemail.com",
  ];
  const realEmail = email && !PLACEHOLDER_EMAILS.includes(email.toLowerCase().trim()) ? email : null;
  if (!realEmail && !phone) return [];
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [contactId];
  let idx = 2;
  if (realEmail) {
    conditions.push(`LOWER(email) = LOWER($${idx})`);
    params.push(realEmail);
    idx++;
  }
  if (phone) {
    conditions.push(`phone = $${idx}`);
    params.push(phone);
    idx++;
  }
  const result = await pool.query(`
    SELECT
      contact_id AS "contactId",
      name,
      requesting_for AS "requestingFor",
      patient_dob AS "patientDob",
      assigned_to AS "assignedTo",
      status_code AS "statusCode"
    FROM sync_contacts
    WHERE contact_id != $1
      AND (${conditions.join(" OR ")})
    ORDER BY name ASC
  `, params);
  return result.rows as Array<{
    contactId: number;
    name: string;
    requestingFor: string | null;
    patientDob: string | null;
    assignedTo: string | null;
    statusCode: string | null;
  }>;
}

/**
 * BULK household resolution for the waitlist board cards.
 *
 * ONE simple query (a single seq scan of sync_contacts) + JS grouping — NOT a SQL
 * self-join. A self-join on email/phone is O(n²) and, with no email/phone index,
 * measured ~2s on ~1k rows; grouping in JS is O(n) and sub-100ms, needing no index
 * (so no schema change). Same clustering + placeholder-email guard as
 * getHouseholdMembers() above, so a card's household exactly matches the contact
 * profile's household view. Returns Map<contactId, members[]> (member = the OTHER
 * contact's id + name + dob). No N+1 (one query per board load). The member's
 * provider is attached by the caller from the shared assignment map — this
 * function does not query assignments.
 */
export async function getHouseholdMembersByAllContacts(): Promise<Map<number, Array<{ contactId: number; name: string; dob: string | null }>>> {
  // Identical placeholder list to getHouseholdMembers() — keep in sync so the
  // card cluster never diverges from the profile cluster.
  const PLACEHOLDER_EMAILS = new Set([
    "none@gmail.com", "none@none.com", "unknown@gmail.com",
    "doesnot@haveone.com", "noemail@noemail.com",
  ]);
  const pool = getPool();
  const result = await pool.query(`
    SELECT contact_id AS "contactId", name, patient_dob AS "dob", email, phone
    FROM sync_contacts
  `);
  type Row = { contactId: number; name: string; dob: string | null; email: string | null; phone: string | null };
  const rows = result.rows as Row[];

  // Build email/phone → contactId[] groups (same OR + placeholder semantics as
  // getHouseholdMembers: a contact participates in an email group only if its
  // email is present and non-placeholder; in a phone group only if phone present).
  const byEmail = new Map<string, number[]>();
  const byPhone = new Map<string, number[]>();
  const rowById = new Map<number, Row>();
  for (const r of rows) {
    rowById.set(r.contactId, r);
    const emailKey = r.email ? r.email.toLowerCase().trim() : "";
    if (emailKey && !PLACEHOLDER_EMAILS.has(emailKey)) {
      (byEmail.get(emailKey) ?? byEmail.set(emailKey, []).get(emailKey)!).push(r.contactId);
    }
    const phoneKey = r.phone ? r.phone.trim() : "";
    if (phoneKey) {
      (byPhone.get(phoneKey) ?? byPhone.set(phoneKey, []).get(phoneKey)!).push(r.contactId);
    }
  }

  const map = new Map<number, Array<{ contactId: number; name: string; dob: string | null }>>();
  for (const r of rows) {
    const memberIds = new Set<number>();
    const emailKey = r.email ? r.email.toLowerCase().trim() : "";
    if (emailKey && !PLACEHOLDER_EMAILS.has(emailKey)) {
      for (const id of byEmail.get(emailKey) ?? []) if (id !== r.contactId) memberIds.add(id);
    }
    const phoneKey = r.phone ? r.phone.trim() : "";
    if (phoneKey) {
      for (const id of byPhone.get(phoneKey) ?? []) if (id !== r.contactId) memberIds.add(id);
    }
    if (memberIds.size === 0) continue;
    const members = [...memberIds]
      .map((id) => { const m = rowById.get(id)!; return { contactId: id, name: m.name, dob: m.dob }; })
      .sort((a, b) => a.name.localeCompare(b.name));
    map.set(r.contactId, members);
  }
  return map;
}

/**
 * Get sync health metadata.
 */
export async function getSyncMeta(): Promise<SyncMeta> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      last_sync_at AS "lastSyncAt",
      last_sync_rows AS "lastSyncRows",
      last_sync_ms AS "lastSyncMs",
      sync_status AS "syncStatus",
      error_message AS "errorMessage"
    FROM sync_meta
    WHERE id = 1
  `);

  const row = result.rows[0] as SyncMeta | undefined;

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
export async function getSyncStaffList(): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT DISTINCT assigned_to
    FROM sync_contacts
    WHERE assigned_to IS NOT NULL AND assigned_to != ''
    ORDER BY assigned_to ASC
  `);

  return (result.rows as { assigned_to: string }[]).map((r) => r.assigned_to);
}

/**
 * Get sync contact count (quick check if sync has data).
 */
export async function getSyncContactCount(): Promise<number> {
  const pool = getPool();
  const result = await pool.query(`SELECT COUNT(*) AS "count" FROM sync_contacts`);
  return parseInt(result.rows[0].count, 10);
}

// ============================================================================
// Direct Intake Operations (bypasses n8n/Excel entirely)
// ============================================================================

/**
 * Generate a unique contact_id for direct-intake contacts.
 * Uses 900_000+ range to avoid collision with n8n-sourced IDs (typically < 100k).
 */
export async function generateIntakeContactId(): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT MAX(contact_id) AS "maxId" FROM sync_contacts WHERE contact_id >= 900000`
  );
  return (result.rows[0]?.maxId ?? 899999) + 1;
}

/**
 * Insert a new contact created via /api/intake.
 * Writes directly to sync_contacts with full structured fields — no n8n, no Excel.
 */
export async function insertIntakeContact(fields: {
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
  modalityP1?: string | null;
  modalityP2?: string | null;
  modalityP3?: string | null;
  modalityP4?: string | null;
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
  sourceSubmissionId?: number | null;
  intakeSource?: string | null;
  referralAuth?: string | null;
  language?: string | null;
}): Promise<void> {
  const pool = getPool();
  const today = new Date().toISOString().split("T")[0];

  await pool.query(`
    INSERT INTO sync_contacts (
      contact_id, name, email, phone,
      status, status_code, service_requested,
      date_added, days_on_waitlist, assigned_to,

      requesting_for, reason_for_seeking, reason_for_therapy, detailed_reason,
      form_completed_by, modality, referral_source, prior_services,
      prior_provider, preferred_contact, custody, flags, priority,
      modality_p1, modality_p2, modality_p3, modality_p4,

      insurance_payer, insurance_plan, insurance_id,
      referral_auth,

      patient_dob, gender,

      street_address, city, state, zip_code, county,

      last_contact, last_note,
      intake_source,
      synced_at, sync_hash,
      source_submission_id,
      language
    ) VALUES (
      $1, $2, $3, $4,
      'New -- No Outreach', 100, $5,
      $6, 0, NULL,

      $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18, $19,
      $37, $38, $39, $40,

      $20, $21, $22,
      $23,

      $24, $25,

      $26, $27, $28, $29, $30,

      $31, $32,
      $33,
      NOW(), $34,
      $35,
      $36
    )
    ON CONFLICT(contact_id) DO UPDATE SET
      name = EXCLUDED.name,
      email = COALESCE(EXCLUDED.email, sync_contacts.email),
      phone = COALESCE(EXCLUDED.phone, sync_contacts.phone),
      service_requested = COALESCE(EXCLUDED.service_requested, sync_contacts.service_requested),
      requesting_for = COALESCE(EXCLUDED.requesting_for, sync_contacts.requesting_for),
      reason_for_seeking = COALESCE(EXCLUDED.reason_for_seeking, sync_contacts.reason_for_seeking),
      reason_for_therapy = COALESCE(EXCLUDED.reason_for_therapy, sync_contacts.reason_for_therapy),
      detailed_reason = COALESCE(EXCLUDED.detailed_reason, sync_contacts.detailed_reason),
      form_completed_by = COALESCE(EXCLUDED.form_completed_by, sync_contacts.form_completed_by),
      modality = COALESCE(EXCLUDED.modality, sync_contacts.modality),
      modality_p1 = COALESCE(EXCLUDED.modality_p1, sync_contacts.modality_p1),
      modality_p2 = COALESCE(EXCLUDED.modality_p2, sync_contacts.modality_p2),
      modality_p3 = COALESCE(EXCLUDED.modality_p3, sync_contacts.modality_p3),
      modality_p4 = COALESCE(EXCLUDED.modality_p4, sync_contacts.modality_p4),
      referral_source = COALESCE(EXCLUDED.referral_source, sync_contacts.referral_source),
      prior_services = COALESCE(EXCLUDED.prior_services, sync_contacts.prior_services),
      prior_provider = COALESCE(EXCLUDED.prior_provider, sync_contacts.prior_provider),
      preferred_contact = COALESCE(EXCLUDED.preferred_contact, sync_contacts.preferred_contact),
      insurance_payer = COALESCE(EXCLUDED.insurance_payer, sync_contacts.insurance_payer),
      insurance_plan = COALESCE(EXCLUDED.insurance_plan, sync_contacts.insurance_plan),
      insurance_id = COALESCE(EXCLUDED.insurance_id, sync_contacts.insurance_id),
      referral_auth = COALESCE(EXCLUDED.referral_auth, sync_contacts.referral_auth),
      patient_dob = COALESCE(EXCLUDED.patient_dob, sync_contacts.patient_dob),
      gender = COALESCE(EXCLUDED.gender, sync_contacts.gender),
      street_address = COALESCE(EXCLUDED.street_address, sync_contacts.street_address),
      city = COALESCE(EXCLUDED.city, sync_contacts.city),
      state = COALESCE(EXCLUDED.state, sync_contacts.state),
      zip_code = COALESCE(EXCLUDED.zip_code, sync_contacts.zip_code),
      county = COALESCE(EXCLUDED.county, sync_contacts.county),
      last_note = CASE
        WHEN EXCLUDED.last_note IS NOT NULL AND sync_contacts.last_note IS NOT NULL
        THEN sync_contacts.last_note || chr(10) || EXCLUDED.last_note
        ELSE COALESCE(EXCLUDED.last_note, sync_contacts.last_note)
      END,
      intake_source = COALESCE(EXCLUDED.intake_source, sync_contacts.intake_source),
      source_submission_id = COALESCE(EXCLUDED.source_submission_id, sync_contacts.source_submission_id),
      language = COALESCE(EXCLUDED.language, sync_contacts.language),
      synced_at = NOW()
  `, [
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
    fields.referralAuth || null,

    fields.patientDob || null,
    fields.gender || null,

    fields.streetAddress || null,
    fields.city || null,
    fields.state || null,
    fields.zipCode || null,
    fields.county || null,

    today,
    fields.lastNote || null,
    fields.intakeSource || "website_form",
    `intake-${fields.contactId}`,
    fields.sourceSubmissionId ?? null,
    fields.language || null,

    // $37-$40 — modality priorities (appended so the existing positional
    // params above keep their numbers).
    fields.modalityP1 || null,
    fields.modalityP2 || null,
    fields.modalityP3 || null,
    fields.modalityP4 || null,
  ]);

  console.log(`[sync-db] Intake contact upserted: ${fields.contactId} (${fields.name})`);
}

// ============================================================================
// Write-Through Operations
// ============================================================================

/**
 * Update a contact's status in the sync cache (write-through).
 * Called before async n8n write so UI reflects change instantly.
 */
export async function updateSyncContactStatus(contactId: number, statusCode: number, status: string): Promise<void> {
  const pool = getPool();
  await pool.query(`
    UPDATE sync_contacts
    SET status_code = $1, status = $2, synced_at = NOW()
    WHERE contact_id = $3
  `, [statusCode, status, contactId]);
}

/**
 * Update a contact's assigned_to in the sync cache (write-through).
 */
export async function updateSyncContactAssignment(contactId: number, assignedTo: string | null): Promise<void> {
  const pool = getPool();
  await pool.query(`
    UPDATE sync_contacts
    SET assigned_to = $1, synced_at = NOW()
    WHERE contact_id = $2
  `, [assignedTo, contactId]);
}

/**
 * Append a note to a contact's last_note field in the sync cache (write-through).
 */
export async function appendSyncContactNote(
  contactId: number,
  note: string,
  author: string,
  timestamp: string
): Promise<void> {
  const pool = getPool();

  // Format note in CRM header format that parseNotesRobust recognizes:
  // [XX | MM/DD/YYYY, HH:MM AM]
  const d = new Date(timestamp);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const year = d.getFullYear();
  const hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const formattedDate = `${month}/${day}/${year}`;
  const formattedTime = `${hour12}:${minutes} ${ampm}`;
  const newEntry = `[${author} | ${formattedDate}, ${formattedTime}]\n${note}`;

  // Single atomic UPDATE — no SELECT race window
  await pool.query(`
    UPDATE sync_contacts
    SET last_note = CASE
      WHEN last_note IS NULL OR last_note = '' THEN $1
      ELSE $1 || chr(10) || chr(10) || last_note
    END,
    last_contact = $2,
    synced_at = NOW()
    WHERE contact_id = $3
  `, [newEntry, timestamp.split("T")[0], contactId]);
}

/**
 * Remove a note block from a contact's last_note field.
 * Notes are stored as a concatenated text blob.
 * Matches by finding the noteContent substring and removing it.
 */
export async function removeSyncContactNote(
  contactId: number,
  noteContent: string
): Promise<boolean> {
  const pool = getPool();
  const existingResult = await pool.query(
    `SELECT last_note FROM sync_contacts WHERE contact_id = $1`, [contactId]
  );
  const existing = existingResult.rows[0] as { last_note: string | null } | undefined;

  if (!existing?.last_note) return false;

  const trimmed = noteContent.trim();
  if (!existing.last_note.includes(trimmed)) return false;

  // Remove the matched content and clean up whitespace
  const updated = existing.last_note
    .replace(trimmed, "")
    .replace(/\n{3,}/g, "\n\n") // collapse multiple blank lines
    .trim() || null;

  await pool.query(`
    UPDATE sync_contacts
    SET last_note = $1, synced_at = NOW()
    WHERE contact_id = $2
  `, [updated, contactId]);

  return true;
}

/**
 * Enrich a sync contact with detailed data (from n8n contact snapshot).
 * Updates only non-null fields — preserves existing board data.
 */
export async function enrichSyncContact(contactId: number, detailed: Record<string, unknown>): Promise<void> {
  const pool = getPool();

  const str = (v: unknown): string | null =>
    v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : null;
  const num = (v: unknown): number | null => {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };

  // Use existing waitlist days as fallback for date reconstruction if needed
  const existingResult = await pool.query(
    `SELECT days_on_waitlist AS "daysOnWaitlist" FROM sync_contacts WHERE contact_id = $1`, [contactId]
  );
  const existing = existingResult.rows[0] as { daysOnWaitlist: number | null } | undefined;
  const fallbackDays = existing?.daysOnWaitlist ?? null;
  const normalizedOrDerivedDateAdded =
    normalizeDateValue(detailed.dateAdded ?? detailed["date_added"])
    ?? deriveDateFromDays(detailed.daysOnWaitlist ?? fallbackDays);

  // Only update fields that have values in the detailed data
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  const fieldMap: Array<[string, unknown]> = [
    ["email", str(detailed.email)],
    ["phone", str(detailed.phone)],
    ["date_added", normalizedOrDerivedDateAdded],
    ["requesting_for", str(detailed.requestingFor)],
    ["reason_for_seeking", str(detailed.reasonForSeeking)],
    ["reason_for_therapy", str(detailed.reasonForTherapy ?? detailed["Reason for Therapy MCQ"] ?? detailed["reasonForTherapyMCQ"])],
    ["detailed_reason", str(detailed.detailedReason ?? detailed["DetailedReason"])],
    ["form_completed_by", str(detailed.formCompletedBy)],
    // IMPORTANT: modality is NOT re-enriched from n8n/Excel. It is CRM-owned.
    // This was the live clobber path: opening a contact whose cache was >5min
    // old fired a background enrich that overwrote the staff-entered modality
    // with the Sheet's value, and would now also desync modality_p1..p4 from
    // the string they were derived from.
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
    // IMPORTANT: Do NOT overwrite last_note from n8n/Excel enrichment.
    // CRM-added notes (via appendSyncContactNote) are the source of truth.
    // Re-enriching would erase notes added through the CRM UI.
  ];

  for (const [col, val] of fieldMap) {
    if (val !== null) {
      updates.push(`${col} = $${paramIdx}`);
      values.push(val);
      paramIdx++;
    }
  }

  if (updates.length === 0) return;

  updates.push(`synced_at = NOW()`);
  values.push(contactId);

  await pool.query(
    `UPDATE sync_contacts SET ${updates.join(", ")} WHERE contact_id = $${paramIdx}`,
    values
  );

  console.log(`[sync-db] Enriched contact ${contactId} with ${updates.length - 1} detailed fields`);
}

/**
 * Upsert a single contact (board + detailed data merged).
 * Used by the manual "Sync Contact Now" feature.
 * IMPORTANT: This does NOT delete other contacts — it only upserts one row.
 */
export async function upsertSingleContact(
  contact: SyncPayloadContact,
  options: { actorEmail?: string } = {},
): Promise<void> {
  const pool = getPool();
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

  // Capture prior status for status_changed activity logging. We read this
  // BEFORE the upsert so we can detect a transition. New contacts (no prior
  // row) are creations, not transitions, and are intentionally not logged.
  const prior = await pool.query<{ status_code: number | null; name: string | null }>(
    `SELECT status_code, name FROM sync_contacts WHERE contact_id = $1`,
    [id],
  );
  const priorStatusCode = prior.rows[0]?.status_code ?? null;
  const priorName = prior.rows[0]?.name ?? null;

  await pool.query(`
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
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18,
      $19, $20, $21, $22, $23,
      $24, $25, $26, $27,
      $28, $29,
      $30, $31, $32,
      $33, $34, $35, $36, $37,
      $38, $39,
      $40, $41,
      NOW(), $42
    )
    ON CONFLICT(contact_id) DO UPDATE SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      phone = EXCLUDED.phone,
      -- status/status_code CRM-owned (COALESCE): the Sheet only fills them when the CRM has none.
      status = COALESCE(sync_contacts.status, EXCLUDED.status),
      status_code = COALESCE(sync_contacts.status_code, EXCLUDED.status_code),
      service_requested = EXCLUDED.service_requested,
      days_on_waitlist = EXCLUDED.days_on_waitlist,
      date_added = EXCLUDED.date_added,
      -- assigned_to intentionally omitted: CRM fully owns it (incl. unassign=null); the INSERT still seeds new contacts.
      requesting_for = EXCLUDED.requesting_for,
      reason_for_seeking = EXCLUDED.reason_for_seeking,
      reason_for_therapy = EXCLUDED.reason_for_therapy,
      detailed_reason = EXCLUDED.detailed_reason,
      form_completed_by = EXCLUDED.form_completed_by,
      -- modality CRM-owned (COALESCE) — see the note in syncContacts above.
      modality = COALESCE(sync_contacts.modality, EXCLUDED.modality),
      referral_source = EXCLUDED.referral_source,
      prior_services = EXCLUDED.prior_services,
      prior_provider = EXCLUDED.prior_provider,
      preferred_contact = EXCLUDED.preferred_contact,
      custody = EXCLUDED.custody,
      flags = EXCLUDED.flags,
      priority = EXCLUDED.priority,
      insurance_payer = EXCLUDED.insurance_payer,
      insurance_plan = EXCLUDED.insurance_plan,
      insurance_id = EXCLUDED.insurance_id,
      insurance_status = EXCLUDED.insurance_status,
      referral_auth = EXCLUDED.referral_auth,
      referral_status = EXCLUDED.referral_status,
      patient_dob = EXCLUDED.patient_dob,
      gender = EXCLUDED.gender,
      age = EXCLUDED.age,
      street_address = EXCLUDED.street_address,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      zip_code = EXCLUDED.zip_code,
      county = EXCLUDED.county,
      rfs_link = EXCLUDED.rfs_link,
      document_link = EXCLUDED.document_link,
      last_contact = EXCLUDED.last_contact,
      last_note = CASE WHEN sync_contacts.last_note IS NOT NULL AND sync_contacts.last_note != '' THEN sync_contacts.last_note ELSE EXCLUDED.last_note END,
      synced_at = NOW(),
      sync_hash = EXCLUDED.sync_hash
  `, [
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
  ]);

  console.log(`[sync-db] Upserted single contact ${id} (no delete of other rows)`);

  // Log status_changed only when an existing contact's code actually moved.
  // Hardened: errors propagate to the caller (matches the UI write path).
  const newStatusCode = num(contact.statusCode);
  if (
    priorStatusCode !== null &&
    newStatusCode !== null &&
    priorStatusCode !== newStatusCode
  ) {
    await logStatusChange({
      actorEmail: options.actorEmail || "system",
      contactId: id,
      contactName: priorName ?? str(contact.name) ?? "",
      fromCode: priorStatusCode,
      fromLabel: getStatusLabel(priorStatusCode),
      toCode: newStatusCode,
      toLabel: getStatusLabel(newStatusCode),
    });
  }
}

// ============================================================================
// Form Submissions (immutable audit log)
// ============================================================================

export interface FormSubmission {
  id: number;
  createdAt: string;
  source: string;
  formType: string;
  submittedAt: string | null;
  contactId: number | null;
  name: string;
  payload: Record<string, unknown>;
}

/** Insert a submission from the existing intake flow. Returns the new row ID. */
export async function insertFormSubmission(fields: {
  source: string;
  contactId: number;
  name: string;
  payload: unknown;
}): Promise<number> {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO form_submissions (source, form_type, contact_id, name, payload)
    VALUES ($1, 'intake', $2, $3, $4)
    RETURNING id
  `, [
    fields.source,
    fields.contactId,
    fields.name,
    JSON.stringify(fields.payload),
  ]);
  return result.rows[0].id as number;
}

/** Insert a generic form submission (unified ingestion). */
export async function insertSubmission(fields: {
  formType: string;
  source: string;
  submittedAt?: string;
  contactId?: number | null;
  name?: string;
  data: Record<string, unknown>;
}): Promise<number> {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO form_submissions (form_type, source, submitted_at, contact_id, name, payload)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [
    fields.formType,
    fields.source,
    fields.submittedAt || null,
    fields.contactId ?? null,
    fields.name || "",
    JSON.stringify(fields.data),
  ]);
  return result.rows[0].id as number;
}

/**
 * Read-only inflow count: inbound INTAKE submissions received within a month,
 * bounded in Mountain Time (America/Denver). Used by the Insights "Referrals in
 * [month]" card. Replaces Lane's manual list-count (which caps at ~50 rows and
 * mixes in non-intake form types).
 *
 * Bounds are passed as half-open [monthStart, nextMonthStart) date strings
 * ('YYYY-MM-DD'); the SQL converts each MT wall-clock midnight to the correct
 * UTC instant via `AT TIME ZONE 'America/Denver'`, so an 11pm-MT submission on
 * the last day of a month counts in that month (not the next under naive UTC).
 *
 * NOTE: form_submissions.created_at is stored as TEXT in prod (SQLite→PG type
 * drift; the DDL says TIMESTAMPTZ) — so we cast `created_at::timestamptz`. All
 * rows are server-generated ISO timestamps (verified 0 uncastable / 0 null).
 *
 * Definition (default, easily switchable):
 *   - form_type = 'intake'  (excludes provider_availability / consent / feedback)
 *   - ALL sources (rfs_v2 self-submissions + uploaded_referral staff referrals)
 *   - COUNT(*) = submissions (a re-submitting contact counts twice)
 *   - test rows excluded by name (see below)
 * To switch later (one-line edits):
 *   - referral-sourced only → uncomment the `source = 'uploaded_referral'` line
 *   - distinct people → swap COUNT(*) for COUNT(DISTINCT contact_id)
 *
 * Test-row exclusion: `name NOT LIKE 'ZZ_%'`. (Do NOT exclude by contact_id —
 * ALL real intake contacts live in the 900000+ range via generateIntakeContactId,
 * so a `contact_id < 900000` filter would zero out the count.)
 */
export async function getReferralsCount(monthStart: string, nextMonthStart: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM form_submissions
    WHERE form_type = 'intake'
      AND created_at::timestamptz >= ($1::timestamp AT TIME ZONE 'America/Denver')
      AND created_at::timestamptz <  ($2::timestamp AT TIME ZONE 'America/Denver')
      AND name NOT LIKE 'ZZ_%'
      -- AND source = 'uploaded_referral'   -- toggle: referral-sourced only (off by default)
    `,
    [monthStart, nextMonthStart],
  );
  return (result.rows[0]?.count as number) ?? 0;
}

export async function getRecentSubmissions(limit: number = 50): Promise<FormSubmission[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      id,
      created_at    AS "createdAt",
      source,
      form_type     AS "formType",
      submitted_at  AS "submittedAt",
      contact_id    AS "contactId",
      name,
      payload
    FROM form_submissions
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);

  return (result.rows as Array<Omit<FormSubmission, "payload"> & { payload: string }>).map((r) => ({
    ...r,
    payload: JSON.parse(r.payload),
  }));
}

/** Get all intake submissions for a specific contact. */
export async function getSubmissionsForContact(contactId: number): Promise<FormSubmission[]> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      id,
      created_at    AS "createdAt",
      source,
      form_type     AS "formType",
      submitted_at  AS "submittedAt",
      contact_id    AS "contactId",
      name,
      payload
    FROM form_submissions
    WHERE contact_id = $1 AND form_type = 'intake'
    ORDER BY created_at DESC
  `, [contactId]);

  return (result.rows as Array<Omit<FormSubmission, "payload"> & { payload: string }>).map((r) => ({
    ...r,
    payload: JSON.parse(r.payload),
  }));
}

/** Fetch a single form submission by ID. */
export async function getSubmissionById(submissionId: number): Promise<FormSubmission | null> {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      id,
      created_at    AS "createdAt",
      source,
      form_type     AS "formType",
      submitted_at  AS "submittedAt",
      contact_id    AS "contactId",
      name,
      payload
    FROM form_submissions
    WHERE id = $1
  `, [submissionId]);

  if (result.rows.length === 0) return null;
  const r = result.rows[0] as Omit<FormSubmission, "payload"> & { payload: string };
  return { ...r, payload: JSON.parse(r.payload) };
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
 * Insert migration contacts using INSERT ... ON CONFLICT DO NOTHING.
 * Skips rows where contact_id already exists — safe to re-run.
 * Returns per-row results for reporting.
 */
export async function insertMigrationContacts(
  contacts: MigrationContact[]
): Promise<{ migrated: number; skipped: number; errors: Array<{ contactId: number; message: string }> }> {
  const pool = getPool();
  const client = await pool.connect();
  let migrated = 0;
  let skipped = 0;
  const errors: Array<{ contactId: number; message: string }> = [];

  const insertSql = `
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
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, NULL, $17,
      $18, NULL, NULL, $19, NULL,
      $20, $21, $22, NULL,
      NULL, NULL,
      $23, $24, $25,
      $26, $27, $28, $29, NULL,
      $30, NULL,
      NULL, $31,
      NOW(), $32
    )
    ON CONFLICT DO NOTHING
  `;

  try {
    await client.query('BEGIN');

    for (const c of contacts) {
      try {
        const result = await client.query(insertSql, [
          c.contactId, c.name, c.email, c.phone, c.status, c.statusCode,
          c.serviceRequested, c.daysOnWaitlist, c.dateAdded, c.assignedTo,
          c.requestingFor, c.reasonForSeeking, c.reasonForTherapy, c.detailedReason,
          c.formCompletedBy, c.modality, c.priorServices,
          c.priorProvider, c.flags,
          c.insurancePayer, c.insurancePlan, c.insuranceId,
          c.patientDob, c.gender, c.age,
          c.streetAddress, c.city, c.state, c.zipCode,
          c.rfsLink,
          c.lastNote,
          `migrate-${c.contactId}`,
        ]);
        if (result.rowCount && result.rowCount > 0) migrated++;
        else skipped++;
      } catch (err) {
        errors.push({
          contactId: c.contactId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { migrated, skipped, errors };
}

/**
 * Merge migration contacts: insert new rows, update safe fields on existing ones.
 * NEVER overwrites CRM-native data (notes, assignments, timeline, status, etc.).
 */
export async function mergeMigrationContacts(
  contacts: MigrationContact[]
): Promise<{ inserted: number; updated: number; skipped: number; errors: Array<{ contactId: number; message: string }> }> {
  const pool = getPool();
  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors: Array<{ contactId: number; message: string }> = [];

  const insertSql = `
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
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, NULL, $17,
      $18, NULL, NULL, $19, NULL,
      $20, $21, $22, NULL,
      NULL, NULL,
      $23, $24, $25,
      $26, $27, $28, $29, NULL,
      $30, NULL,
      NULL, $31,
      NOW(), $32
    )
  `;

  const updateSql = `
    UPDATE sync_contacts SET
      name = $1,
      email = $2,
      phone = $3,
      requesting_for = $4,
      reason_for_seeking = $5,
      reason_for_therapy = $6,
      detailed_reason = $7,
      form_completed_by = $8,
      modality = $9,
      prior_services = $10,
      prior_provider = $11,
      insurance_payer = $12,
      insurance_plan = $13,
      insurance_id = $14,
      patient_dob = $15,
      gender = $16,
      age = $17,
      street_address = $18,
      city = $19,
      state = $20,
      zip_code = $21,
      rfs_link = $22,
      synced_at = NOW()
    WHERE contact_id = $23
  `;

  try {
    await client.query('BEGIN');

    for (const c of contacts) {
      try {
        const checkResult = await client.query(
          `SELECT contact_id FROM sync_contacts WHERE contact_id = $1`, [c.contactId]
        );
        if (checkResult.rows.length === 0) {
          await client.query(insertSql, [
            c.contactId, c.name, c.email, c.phone, c.status, c.statusCode,
            c.serviceRequested, c.daysOnWaitlist, c.dateAdded, c.assignedTo,
            c.requestingFor, c.reasonForSeeking, c.reasonForTherapy, c.detailedReason,
            c.formCompletedBy, c.modality, c.priorServices,
            c.priorProvider, c.flags,
            c.insurancePayer, c.insurancePlan, c.insuranceId,
            c.patientDob, c.gender, c.age,
            c.streetAddress, c.city, c.state, c.zipCode,
            c.rfsLink,
            c.lastNote,
            `migrate-${c.contactId}`,
          ]);
          inserted++;
        } else {
          const result = await client.query(updateSql, [
            c.name, c.email, c.phone,
            c.requestingFor, c.reasonForSeeking, c.reasonForTherapy,
            c.detailedReason, c.formCompletedBy, c.modality,
            c.priorServices, c.priorProvider,
            c.insurancePayer, c.insurancePlan, c.insuranceId,
            c.patientDob, c.gender, c.age,
            c.streetAddress, c.city, c.state, c.zipCode,
            c.rfsLink,
            c.contactId,
          ]);
          if (result.rowCount && result.rowCount > 0) updated++;
          else skipped++;
        }
      } catch (err) {
        errors.push({
          contactId: c.contactId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { inserted, updated, skipped, errors };
}

/**
 * Full-sync migration: upsert ALL fields from production data.
 * Updates status, notes, assignments — everything. Production is truth.
 * Safe to run repeatedly (idempotent via ON CONFLICT upsert).
 */
export async function fullSyncMigrationContacts(
  contacts: MigrationContact[]
): Promise<{ inserted: number; updated: number; unchanged: number; errors: Array<{ contactId: number; message: string }> }> {
  const pool = getPool();
  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const errors: Array<{ contactId: number; message: string }> = [];

  const upsertSql = `
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
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, NULL, $17,
      $18, NULL, NULL, $19, NULL,
      $20, $21, $22, NULL,
      NULL, NULL,
      $23, $24, $25,
      $26, $27, $28, $29, NULL,
      $30, NULL,
      NULL, $31,
      NOW(), $32
    )
    ON CONFLICT(contact_id) DO UPDATE SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      phone = EXCLUDED.phone,
      -- status/status_code CRM-owned (COALESCE): the Sheet only fills them when the CRM has none.
      status = COALESCE(sync_contacts.status, EXCLUDED.status),
      status_code = COALESCE(sync_contacts.status_code, EXCLUDED.status_code),
      service_requested = EXCLUDED.service_requested,
      days_on_waitlist = EXCLUDED.days_on_waitlist,
      date_added = EXCLUDED.date_added,
      -- assigned_to intentionally omitted: CRM fully owns it (incl. unassign=null); the INSERT still seeds new contacts.
      requesting_for = EXCLUDED.requesting_for,
      reason_for_seeking = EXCLUDED.reason_for_seeking,
      reason_for_therapy = EXCLUDED.reason_for_therapy,
      detailed_reason = EXCLUDED.detailed_reason,
      form_completed_by = EXCLUDED.form_completed_by,
      -- modality CRM-owned (COALESCE) — see the note in syncContacts above.
      modality = COALESCE(sync_contacts.modality, EXCLUDED.modality),
      prior_services = EXCLUDED.prior_services,
      prior_provider = EXCLUDED.prior_provider,
      flags = EXCLUDED.flags,
      insurance_payer = EXCLUDED.insurance_payer,
      insurance_plan = EXCLUDED.insurance_plan,
      insurance_id = EXCLUDED.insurance_id,
      patient_dob = EXCLUDED.patient_dob,
      gender = EXCLUDED.gender,
      age = EXCLUDED.age,
      street_address = EXCLUDED.street_address,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      zip_code = EXCLUDED.zip_code,
      rfs_link = EXCLUDED.rfs_link,
      -- last_note CRM-owned: keep the CRM's note log if present (never clobber staff notes); take the Sheet's only when the CRM has none. Mirrors syncContacts.
      last_note = CASE WHEN sync_contacts.last_note IS NOT NULL AND sync_contacts.last_note != '' THEN sync_contacts.last_note ELSE EXCLUDED.last_note END,
      synced_at = NOW(),
      sync_hash = EXCLUDED.sync_hash
  `;

  try {
    await client.query('BEGIN');

    for (const c of contacts) {
      try {
        const hash = `fullsync-${c.contactId}-${c.statusCode}-${(c.lastNote || "").length}`;
        const checkResult = await client.query(
          `SELECT sync_hash, status_code, name FROM sync_contacts WHERE contact_id = $1`,
          [c.contactId],
        );
        const existing = checkResult.rows[0] as
          | { sync_hash: string | null; status_code: number | null; name: string | null }
          | undefined;
        const priorStatusCode = existing?.status_code ?? null;

        const result = await client.query(upsertSql, [
          c.contactId, c.name, c.email, c.phone, c.status, c.statusCode,
          c.serviceRequested, c.daysOnWaitlist, c.dateAdded, c.assignedTo,
          c.requestingFor, c.reasonForSeeking, c.reasonForTherapy, c.detailedReason,
          c.formCompletedBy, c.modality, c.priorServices,
          c.priorProvider, c.flags,
          c.insurancePayer, c.insurancePlan, c.insuranceId,
          c.patientDob, c.gender, c.age,
          c.streetAddress, c.city, c.state, c.zipCode,
          c.rfsLink,
          c.lastNote,
          hash,
        ]);

        if (!existing) {
          inserted++;
        } else if (result.rowCount && result.rowCount > 0) {
          updated++;
        } else {
          unchanged++;
        }

        // status_changed log: only on real transitions for existing contacts.
        // New rows are creations (priorStatusCode null) — not logged.
        const newStatusCode =
          c.statusCode === undefined || c.statusCode === null ? null : Number(c.statusCode);
        if (
          priorStatusCode !== null &&
          newStatusCode !== null &&
          !Number.isNaN(newStatusCode) &&
          priorStatusCode !== newStatusCode
        ) {
          await logStatusChange({
            actorEmail: "system",
            contactId: c.contactId,
            contactName: existing?.name ?? c.name ?? "",
            fromCode: priorStatusCode,
            fromLabel: getStatusLabel(priorStatusCode),
            toCode: newStatusCode,
            toLabel: getStatusLabel(newStatusCode),
          });
        }
      } catch (err) {
        errors.push({
          contactId: c.contactId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { inserted, updated, unchanged, errors };
}

// ============================================================================
// Contact Intake Field Updates (CRM edits)
// ============================================================================

/** Fields that are safe to update from the CRM UI */
const SAFE_INTAKE_FIELDS: Record<string, string> = {
  requestingFor: "requesting_for",
  reasonForSeeking: "reason_for_seeking",
  reasonForTherapy: "reason_for_therapy",
  modality: "modality",
  // Modality priorities. MUST be listed here — updateContactIntakeFields
  // silently skips keys it doesn't recognise, so omitting them would make the
  // staff edit appear to succeed while dropping the priorities.
  modalityP1: "modality_p1",
  modalityP2: "modality_p2",
  modalityP3: "modality_p3",
  modalityP4: "modality_p4",
  formCompletedBy: "form_completed_by",
  // Paperwork Status. CRM-owned and dropdown-constrained; the PATCH route
  // validates the value against shared/paperwork-status.ts before it gets here.
  // Excluded from the n8n sync upserts so a sync can never clobber it.
  paperworkStatus: "paperwork_status",
  insurancePayer: "insurance_payer",
  insurancePlan: "insurance_plan",
  insuranceId: "insurance_id",
  patientDob: "patient_dob",
  gender: "gender",
  streetAddress: "street_address",
  city: "city",
  state: "state",
  zipCode: "zip_code",
  referralSource: "referral_source",
  priorServices: "prior_services",
  priorProvider: "prior_provider",
  preferredContact: "preferred_contact",
  rfsLink: "rfs_link",
  // CRM-owned, dropdown-constrained ("English"/"Spanish"/NULL). Persisted here
  // but excluded from the n8n sync upserts so a sync never clobbers a manual value.
  language: "language",
};

/**
 * Update only safe intake fields on an existing contact.
 * Returns the list of fields that actually changed.
 */
export async function updateContactIntakeFields(
  contactId: number,
  updates: Record<string, string | null>
): Promise<{ updated: string[]; notFound: boolean }> {
  const pool = getPool();

  // Check contact exists
  const existingResult = await pool.query(
    `SELECT contact_id FROM sync_contacts WHERE contact_id = $1`, [contactId]
  );
  if (existingResult.rows.length === 0) return { updated: [], notFound: true };

  // Filter to only safe fields that were actually provided
  const setClauses: string[] = [];
  const values: (string | number | null)[] = [];
  const updatedFields: string[] = [];
  let paramIdx = 1;

  for (const [camelKey, value] of Object.entries(updates)) {
    const col = SAFE_INTAKE_FIELDS[camelKey];
    if (!col) continue; // skip non-safe fields silently
    setClauses.push(`${col} = $${paramIdx}`);
    values.push(value ?? null);
    updatedFields.push(camelKey);
    paramIdx++;
  }

  if (setClauses.length === 0) return { updated: [], notFound: false };

  setClauses.push(`synced_at = NOW()`);
  values.push(contactId);

  await pool.query(
    `UPDATE sync_contacts SET ${setClauses.join(", ")} WHERE contact_id = $${paramIdx}`,
    values
  );

  return { updated: updatedFields, notFound: false };
}

// ============================================================================
// TN V2 Scheduled Appointment (CRM-owned date/time on sync_contacts)
// ============================================================================

/**
 * Persist the staff-entered initial appointment date/time used by the V2
 * TherapyNotes workflow. Pass null to clear a field. Does NOT touch synced_at
 * (these columns are CRM-owned and excluded from the n8n sync upsert).
 * Returns notFound:true if the contact row doesn't exist.
 */
export async function updateScheduledAppointment(
  contactId: number,
  date: string | null,
  time: string | null
): Promise<{ notFound: boolean }> {
  const pool = getPool();

  const existing = await pool.query(
    `SELECT contact_id FROM sync_contacts WHERE contact_id = $1`,
    [contactId]
  );
  if (existing.rows.length === 0) return { notFound: true };

  await pool.query(
    `UPDATE sync_contacts
       SET scheduled_appointment_date = $1,
           scheduled_appointment_time = $2
     WHERE contact_id = $3`,
    [date, time, contactId]
  );

  return { notFound: false };
}

// ============================================================================
// Contact Identity Field Updates (name, email, phone)
// ============================================================================

const IDENTITY_FIELDS: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "phone",
};

export interface IdentityChangeDetail {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * Update identity fields (name, email, phone) on an existing contact.
 * Returns the list of fields that actually changed with old/new values.
 */
export async function updateContactIdentity(
  contactId: number,
  updates: Record<string, string>
): Promise<{ changes: IdentityChangeDetail[]; notFound: boolean }> {
  const pool = getPool();

  const existingResult = await pool.query(
    `SELECT name, email, phone FROM sync_contacts WHERE contact_id = $1`,
    [contactId]
  );
  if (existingResult.rows.length === 0) return { changes: [], notFound: true };

  const current = existingResult.rows[0] as { name: string; email: string | null; phone: string | null };

  const setClauses: string[] = [];
  const values: (string | null)[] = [];
  const changes: IdentityChangeDetail[] = [];
  let paramIdx = 1;

  for (const [camelKey, newValue] of Object.entries(updates)) {
    const col = IDENTITY_FIELDS[camelKey];
    if (!col) continue;
    const oldValue = (current as Record<string, string | null>)[col] ?? null;
    const trimmed = newValue?.trim() || null;
    if (trimmed === oldValue) continue;

    setClauses.push(`${col} = $${paramIdx}`);
    values.push(trimmed);
    changes.push({ field: camelKey, oldValue, newValue: trimmed });
    paramIdx++;
  }

  if (setClauses.length === 0) return { changes: [], notFound: false };

  setClauses.push(`synced_at = NOW()`);
  values.push(contactId as any);

  await pool.query(
    `UPDATE sync_contacts SET ${setClauses.join(", ")} WHERE contact_id = $${paramIdx}`,
    values
  );

  return { changes, notFound: false };
}

// ============================================================================
// Delete Contact (full cascade)
// ============================================================================

/**
 * Permanently delete a contact and all related records.
 * Activity log entries are preserved for audit trail.
 */
export async function deleteSyncContact(contactId: number): Promise<{ deleted: boolean; name: string | null }> {
  const pool = getPool();

  const existing = await pool.query(
    `SELECT name FROM sync_contacts WHERE contact_id = $1`,
    [contactId]
  );
  if (existing.rows.length === 0) return { deleted: false, name: null };

  const name = (existing.rows[0] as { name: string }).name;

  const relatedTables = [
    "form_submissions",
    "contact_provider_assignments",
    "reminders",
    "intake_comments",
    "attention_flags",
    "email_snapshots",
    "therapy_notes_records",
  ];

  for (const table of relatedTables) {
    try {
      await pool.query(`DELETE FROM ${table} WHERE contact_id = $1`, [contactId]);
    } catch (e) {
      console.warn(`[delete-contact] Failed to clean ${table} for ${contactId}:`, e);
    }
  }

  await pool.query(`DELETE FROM sync_contacts WHERE contact_id = $1`, [contactId]);

  return { deleted: true, name };
}
