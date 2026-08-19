/**
 * Per-user saved view preferences (columns, filters, sort).
 *
 * Keyed on (user_id, view_key) where user_id is the Azure AD `oid` — immutable,
 * unlike email. See migrations/add-user-view-preferences.sql for the full
 * rationale and the version-1 payload shape.
 *
 * CRM-ONLY TABLE. The n8n sync writes sync_contacts, sync_meta and
 * form_submissions and never touches this; `npm run test:modality` asserts it.
 */
import { getPool } from "../db/pool";

/** Surfaces that can have saved views. Adding one needs no schema change. */
export const VIEW_KEYS = ["waitlist_list"] as const;
export type ViewKey = typeof VIEW_KEYS[number];

/**
 * Per-user cap on named views. Enforced server-side so it holds regardless of
 * client; mirrored in client/src/lib/view-preferences.ts for the friendly
 * message. Keep the two in step.
 */
export const MAX_NAMED_VIEWS = 8;

export function isValidViewKey(v: string): v is ViewKey {
  return (VIEW_KEYS as readonly string[]).includes(v);
}

export async function initViewPreferencesTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_view_preferences (
      user_id     TEXT        NOT NULL,
      view_key    TEXT        NOT NULL,
      user_email  TEXT,
      prefs       JSONB       NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, view_key)
    )
  `);
  console.log("[view-prefs] Table initialized");
}

/** The caller's saved prefs for one view, or null when they've never saved. */
export async function getViewPreferences(
  userId: string,
  viewKey: string,
): Promise<unknown | null> {
  const res = await getPool().query(
    `SELECT prefs FROM user_view_preferences WHERE user_id = $1 AND view_key = $2`,
    [userId, viewKey],
  );
  return res.rows[0]?.prefs ?? null;
}

/**
 * Upsert the caller's prefs. Always scoped to one user_id — there is no code
 * path that writes another user's row.
 */
export async function saveViewPreferences(
  userId: string,
  userEmail: string | null,
  viewKey: string,
  prefs: unknown,
): Promise<void> {
  await getPool().query(
    `INSERT INTO user_view_preferences (user_id, view_key, user_email, prefs, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (user_id, view_key) DO UPDATE SET
       prefs = EXCLUDED.prefs,
       user_email = EXCLUDED.user_email,
       updated_at = NOW()`,
    [userId, viewKey, userEmail, JSON.stringify(prefs)],
  );
}

/** Reset to stock: delete the row so the client falls back to defaults. */
export async function deleteViewPreferences(userId: string, viewKey: string): Promise<boolean> {
  const res = await getPool().query(
    `DELETE FROM user_view_preferences WHERE user_id = $1 AND view_key = $2`,
    [userId, viewKey],
  );
  return (res.rowCount ?? 0) > 0;
}
