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
  | "contact_assigned"
  | "assignment_deleted"
  | "provider_updated"
  | "email_sent"
  | "therapy_notes_started"
  | "therapy_notes_created"
  | "therapy_notes_failed";

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
      created_at    TEXT NOT NULL DEFAULT (NOW())
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_log_created
      ON activity_log(created_at DESC);
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
      created_at    AS "createdAt"
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
      created_at    AS "createdAt"
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
      AND created_at::timestamptz >= NOW() - $1::INTERVAL
    GROUP BY actor_email
    ORDER BY count DESC
  `, [`${days} days`]);
  return rows as StaffActivitySummary[];
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

    default:
      return `${type}: ${name}`;
  }
}
