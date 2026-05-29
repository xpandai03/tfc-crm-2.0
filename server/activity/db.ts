/**
 * Activity Log
 *
 * Captures meaningful CRM events for a user-facing timeline.
 * This is NOT a debug log — only human-relevant actions are recorded.
 */

import { getPool } from "../db/pool";

// ============================================================================
// Types
// ============================================================================

export type ActivityType =
  | "submission_received"
  | "status_changed"
  | "note_added"
  | "note_deleted"
  | "contact_updated"
  | "contact_deleted"
  | "contact_assigned"
  | "assignment_deleted"
  | "provider_updated"
  | "provider_availability_submitted"
  | "email_sent"
  | "therapy_notes_started"
  | "therapy_notes_created"
  | "therapy_notes_failed"
  | "referral_uploaded"
  | "scheduled_appointment_set"
  | "tn_schedule_started"
  | "tn_schedule_phase"
  | "tn_schedule_completed"
  | "tn_schedule_failed";

export interface LogActivityParams {
  type: ActivityType;
  actorEmail: string;
  entityType: string;
  entityId?: string;
  entityName?: string;
  metadata?: Record<string, unknown>;
}

export interface Activity {
  id: number;
  type: ActivityType;
  actorEmail: string;
  entityType: string;
  entityId: string;
  entityName: string;
  metadata: Record<string, unknown>;
  summary: string;
  createdAt: string;
}

// ============================================================================
// Table
// ============================================================================

export async function initActivityTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id            SERIAL PRIMARY KEY,
      type          TEXT NOT NULL,
      actor_email   TEXT NOT NULL,
      entity_type   TEXT NOT NULL,
      entity_id     TEXT,
      entity_name   TEXT,
      metadata      TEXT NOT NULL DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Idempotent migration: pre-existing installs had created_at TEXT.
  // Convert in place if still TEXT; preserves existing ISO-string values via cast.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'activity_log'
          AND column_name = 'created_at'
          AND data_type = 'text'
      ) THEN
        ALTER TABLE activity_log
          ALTER COLUMN created_at DROP DEFAULT,
          ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
          ALTER COLUMN created_at SET DEFAULT NOW();
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_log_created
      ON activity_log(created_at DESC);
  `);

  // Supports the per-contact most-recent-status-event lookup used by /api/insights/status-durations.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_log_status_lookup
      ON activity_log(entity_id, type, created_at DESC)
      WHERE type = 'status_changed';
  `);
}

// ============================================================================
// Write
// ============================================================================

export async function logActivity(params: LogActivityParams): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(`
      INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      params.type,
      params.actorEmail,
      params.entityType,
      params.entityId ?? null,
      params.entityName ?? null,
      JSON.stringify(params.metadata ?? {}),
    ]);
  } catch (err) {
    // Activity logging must never break the primary action
    console.error("[activity] Failed to log event:", err);
  }
}

// ============================================================================
// Hardened Status-Change Logging
// ============================================================================
//
// status_changed events feed the time-in-status insights endpoint and are the
// only authoritative record of when a contact entered its current status. We
// deliberately do NOT swallow errors here — callers must decide what to do.
// Other activity types continue to use the best-effort logActivity().
//
// Schema invariant (matches the existing UI write path at routes.ts):
//   metadata = { from, fromLabel, to, toLabel }

export interface LogStatusChangeParams {
  actorEmail: string;
  contactId: number;
  contactName?: string;
  fromCode: number | null;
  fromLabel?: string | null;
  toCode: number;
  toLabel?: string | null;
}

export async function logStatusChange(p: LogStatusChangeParams): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
     VALUES ('status_changed', $1, 'contact', $2, $3, $4)`,
    [
      p.actorEmail,
      String(p.contactId),
      p.contactName ?? "",
      JSON.stringify({
        from: p.fromCode ?? "",
        fromLabel: p.fromLabel ?? "",
        to: p.toCode,
        toLabel: p.toLabel ?? "",
      }),
    ],
  );
}

// ============================================================================
// Read
// ============================================================================

export async function getRecentActivity(limit: number = 100): Promise<Activity[]> {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      id,
      type,
      actor_email   AS "actorEmail",
      entity_type   AS "entityType",
      entity_id     AS "entityId",
      entity_name   AS "entityName",
      metadata,
      created_at::text AS "createdAt"
    FROM activity_log
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);

  return (rows as Array<Omit<Activity, "metadata" | "summary"> & { metadata: string }>).map((r) => {
    const meta = JSON.parse(r.metadata || "{}");
    return {
      ...r,
      entityId: r.entityId ?? "",
      entityName: r.entityName ?? "",
      metadata: meta,
      summary: formatActivitySummary(r.type as ActivityType, r.entityName ?? "", meta),
    };
  });
}

// ============================================================================
// Contact-scoped Activity
// ============================================================================

export async function getActivityForContact(contactId: number, limit: number = 50): Promise<Activity[]> {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      id,
      type,
      actor_email   AS "actorEmail",
      entity_type   AS "entityType",
      entity_id     AS "entityId",
      entity_name   AS "entityName",
      metadata,
      created_at::text AS "createdAt"
    FROM activity_log
    WHERE entity_type = 'contact' AND entity_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [String(contactId), limit]);

  return (rows as Array<Omit<Activity, "metadata" | "summary"> & { metadata: string }>).map((r) => {
    const meta = JSON.parse(r.metadata || "{}");
    return {
      ...r,
      entityId: r.entityId ?? "",
      entityName: r.entityName ?? "",
      metadata: meta,
      summary: formatActivitySummary(r.type as ActivityType, r.entityName ?? "", meta),
    };
  });
}

// ============================================================================
// Staff Activity Summary
// ============================================================================

export interface StaffActivitySummary {
  user: string;
  count: number;
}

/** Get activity counts grouped by user for the last N days. Excludes "system". */
export async function getStaffActivitySummary(days: number = 7): Promise<StaffActivitySummary[]> {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      actor_email AS user,
      COUNT(*) AS count
    FROM activity_log
    WHERE actor_email != 'system'
      AND actor_email != 'provider_form'
      AND created_at::timestamptz >= NOW() - $1::INTERVAL
    GROUP BY actor_email
    ORDER BY count DESC
  `, [`${days} days`]);
  return rows as StaffActivitySummary[];
}

// ============================================================================
// Time-in-Status Aggregation
// ============================================================================
//
// "Time in current status" = NOW() - timestamp of the most recent
// status_changed event whose `to` equals the contact's current status_code.
//
// Returns NULL for that contact when no logged event places them on their
// current status — for example, sync-driven status mutations were not logged
// before this feature shipped, and the n8n batch sync still doesn't log.
// NULL is the honest answer; we do not synthesize a duration.

export interface ContactStatusDuration {
  contactId: number;
  statusCode: number | null;
  timeInCurrentStatusSeconds: number | null;
}

export interface StatusDurationAggregate {
  statusCode: number;
  countTotal: number;
  countWithData: number;
  avgSeconds: number | null;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface StatusDurationsResult {
  byContact: ContactStatusDuration[];
  byStatusCode: StatusDurationAggregate[];
  generatedAt: string;
}

export async function getStatusDurations(): Promise<StatusDurationsResult> {
  const pool = getPool();

  const { rows: contactRows } = await pool.query(`
    WITH last_landing AS (
      SELECT
        a.entity_id,
        (a.metadata::jsonb ->> 'to')::int AS landed_code,
        a.created_at::timestamptz AS landed_at,
        ROW_NUMBER() OVER (
          PARTITION BY a.entity_id, (a.metadata::jsonb ->> 'to')
          ORDER BY a.created_at::timestamptz DESC
        ) AS rn
      FROM activity_log a
      WHERE a.type = 'status_changed'
        AND a.entity_type = 'contact'
    )
    SELECT
      c.contact_id          AS "contactId",
      c.status_code         AS "statusCode",
      CASE
        WHEN ll.landed_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (NOW() - ll.landed_at))
        ELSE NULL
      END AS "timeInCurrentStatusSeconds"
    FROM sync_contacts c
    LEFT JOIN last_landing ll
      ON ll.entity_id   = c.contact_id::text
     AND ll.landed_code = c.status_code
     AND ll.rn          = 1
    WHERE c.contact_id IS NOT NULL
    ORDER BY "timeInCurrentStatusSeconds" DESC NULLS LAST
  `);

  const byContact: ContactStatusDuration[] = (contactRows as Array<{
    contactId: number;
    statusCode: number | null;
    timeInCurrentStatusSeconds: string | number | null;
  }>).map((r) => ({
    contactId: Number(r.contactId),
    statusCode: r.statusCode === null ? null : Number(r.statusCode),
    timeInCurrentStatusSeconds:
      r.timeInCurrentStatusSeconds === null
        ? null
        : Number(r.timeInCurrentStatusSeconds),
  }));

  const groups = new Map<number, number[]>();
  const totals = new Map<number, number>();
  for (const row of byContact) {
    if (row.statusCode === null) continue;
    totals.set(row.statusCode, (totals.get(row.statusCode) ?? 0) + 1);
    if (row.timeInCurrentStatusSeconds !== null) {
      const arr = groups.get(row.statusCode) ?? [];
      arr.push(row.timeInCurrentStatusSeconds);
      groups.set(row.statusCode, arr);
    }
  }

  const byStatusCode: StatusDurationAggregate[] = [];
  totals.forEach((countTotal, statusCode) => {
    const samples = (groups.get(statusCode) ?? []).slice().sort((a, b) => a - b);
    const countWithData = samples.length;
    const avgSeconds =
      countWithData === 0
        ? null
        : samples.reduce((s, v) => s + v, 0) / countWithData;
    const medianSeconds = countWithData === 0 ? null : percentile(samples, 0.5);
    const p90Seconds = countWithData === 0 ? null : percentile(samples, 0.9);
    byStatusCode.push({
      statusCode,
      countTotal,
      countWithData,
      avgSeconds,
      medianSeconds,
      p90Seconds,
    });
  });
  byStatusCode.sort((a, b) => a.statusCode - b.statusCode);

  return {
    byContact,
    byStatusCode,
    generatedAt: new Date().toISOString(),
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

// ============================================================================
// Summary Formatting (computed at read time, never stored)
// ============================================================================

function formatActivitySummary(
  type: ActivityType,
  entityName: string,
  metadata: Record<string, unknown>,
): string {
  const name = entityName || "Unknown";

  switch (type) {
    case "submission_received": {
      const formType = String(metadata.formType || "");
      const source = String(metadata.source || "");
      if (formType) return `New ${formType} form: ${name}`;
      if (source) return `New submission (${source}): ${name}`;
      return `New submission: ${name}`;
    }

    case "status_changed": {
      const to = metadata.toLabel || metadata.to || "";
      const from = metadata.fromLabel || metadata.from || "";
      if (from && to) return `Changed ${name}: ${from} → ${to}`;
      if (to) return `Changed ${name} → ${to}`;
      return `Updated status for ${name}`;
    }

    case "note_added": {
      const preview = String(metadata.preview || "");
      if (preview) {
        const short = preview.length > 60 ? preview.slice(0, 60) + "…" : preview;
        return `Added note to ${name}: "${short}"`;
      }
      return `Added note to ${name}`;
    }

    case "note_deleted": {
      const preview = String(metadata.preview || "");
      if (preview) {
        const short = preview.length > 60 ? preview.slice(0, 60) + "…" : preview;
        return `Deleted note from ${name}: "${short}"`;
      }
      return `Deleted note from ${name}`;
    }

    case "contact_updated": {
      const identityChanges = metadata.identityChanges as Array<{ field: string; oldValue: string | null; newValue: string | null }> | undefined;
      if (identityChanges && Array.isArray(identityChanges) && identityChanges.length > 0) {
        const parts = identityChanges.map(
          (c) => `${c.field}: ${c.oldValue || "(empty)"} → ${c.newValue || "(empty)"}`
        );
        return `Updated contact details for ${name}\n${parts.join("\n")}`;
      }
      const fields = String(metadata.fields || "");
      if (fields) return `Updated intake for ${name}: ${fields}`;
      return `Updated intake for ${name}`;
    }

    case "contact_deleted": {
      return `Deleted contact: ${name}`;
    }

    case "contact_assigned": {
      const provider = String(metadata.providerName || "");
      const assignee = String(metadata.assignedTo || "");
      if (provider) return `Assigned provider ${provider} → ${name}`;
      if (assignee) return `Assigned ${name} to ${assignee}`;
      return `Unassigned ${name}`;
    }

    case "assignment_deleted": {
      const provider = String(metadata.providerName || "");
      if (provider) return `Removed provider ${provider} from ${name}`;
      return `Removed provider assignment from ${name}`;
    }

    case "provider_updated": {
      const fieldsUpdated = metadata.fieldsUpdated;
      if (Array.isArray(fieldsUpdated) && fieldsUpdated.length > 0) {
        return `Updated provider ${name} (${fieldsUpdated.join(", ")})`;
      }
      return `Updated provider ${name}`;
    }

    case "provider_availability_submitted": {
      const count = metadata.acceptingClients;
      const hasNotes = !!metadata.specialConsiderations;
      if (typeof count === "number") {
        return `${name} submitted availability — accepting ${count} new patient${count === 1 ? "" : "s"}${hasNotes ? " (+ note)" : ""}`;
      }
      return `${name} submitted availability`;
    }

    case "email_sent": {
      const templateName = String(metadata.templateName || metadata.template || "email");
      return `Sent ${templateName} to ${name}`;
    }

    case "therapy_notes_started": {
      return `Started TherapyNotes creation for ${name}`;
    }

    case "therapy_notes_created": {
      return `Created TherapyNotes patient for ${name}`;
    }

    case "therapy_notes_failed": {
      const reason = String(metadata.failureReason || "unknown error");
      const short = reason.length > 80 ? reason.slice(0, 80) + "…" : reason;
      return `TherapyNotes creation failed for ${name}: ${short}`;
    }

    case "referral_uploaded": {
      const staff = String(metadata.staffName || "staff");
      const source = String(metadata.referralSource || "referral");
      return `Referral uploaded by ${staff} — ${source} for ${name}`;
    }

    case "scheduled_appointment_set": {
      const when = String(metadata.appointmentDatetime || "appointment");
      return `Scheduled appointment set for ${name}: ${when}`;
    }

    case "tn_schedule_started": {
      return `Add to Schedule in TN (Beta) initiated for ${name}`;
    }

    case "tn_schedule_phase": {
      const msg = String(metadata.message || metadata.phase || "progress");
      return `TN ${name}: ${msg}`;
    }

    case "tn_schedule_completed": {
      const when = String(metadata.appointmentDatetime || "scheduled appointment");
      return `Patient added to TN with appointment for ${name}: ${when}`;
    }

    case "tn_schedule_failed": {
      const reason = String(metadata.failureReason || "unknown error");
      const short = reason.length > 80 ? reason.slice(0, 80) + "…" : reason;
      return `Add to Schedule in TN failed for ${name}: ${short}`;
    }

    default:
      return `${type}: ${name}`;
  }
}
