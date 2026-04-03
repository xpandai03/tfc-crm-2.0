/**
 * Activity Log
 *
 * Captures meaningful CRM events for a user-facing timeline.
 * This is NOT a debug log — only human-relevant actions are recorded.
 */

import { getDatabase } from "../reminders/db";

// ============================================================================
// Types
// ============================================================================

export type ActivityType =
  | "submission_received"
  | "status_changed"
  | "note_added"
  | "contact_updated"
  | "contact_assigned"
  | "provider_updated";

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

export function initActivityTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      type          TEXT NOT NULL,
      actor_email   TEXT NOT NULL,
      entity_type   TEXT NOT NULL,
      entity_id     TEXT,
      entity_name   TEXT,
      metadata      TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_activity_log_created
      ON activity_log(created_at DESC);
  `);
}

// ============================================================================
// Write
// ============================================================================

export function logActivity(params: LogActivityParams): void {
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.type,
      params.actorEmail,
      params.entityType,
      params.entityId ?? null,
      params.entityName ?? null,
      JSON.stringify(params.metadata ?? {}),
    );
  } catch (err) {
    // Activity logging must never break the primary action
    console.error("[activity] Failed to log event:", err);
  }
}

// ============================================================================
// Read
// ============================================================================

export function getRecentActivity(limit: number = 100): Activity[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      id,
      type,
      actor_email   AS actorEmail,
      entity_type   AS entityType,
      entity_id     AS entityId,
      entity_name   AS entityName,
      metadata,
      created_at    AS createdAt
    FROM activity_log
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as Array<Omit<Activity, "metadata" | "summary"> & { metadata: string }>;

  return rows.map((r) => {
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
export function getStaffActivitySummary(days: number = 7): StaffActivitySummary[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT
      actor_email AS user,
      COUNT(*) AS count
    FROM activity_log
    WHERE actor_email != 'system'
      AND created_at >= datetime('now', ?)
    GROUP BY actor_email
    ORDER BY count DESC
  `).all(`-${days} days`) as StaffActivitySummary[];
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

    case "contact_updated": {
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

    case "provider_updated": {
      const fieldsUpdated = metadata.fieldsUpdated;
      if (Array.isArray(fieldsUpdated) && fieldsUpdated.length > 0) {
        return `Updated provider ${name} (${fieldsUpdated.join(", ")})`;
      }
      return `Updated provider ${name}`;
    }

    default:
      return `${type}: ${name}`;
  }
}
