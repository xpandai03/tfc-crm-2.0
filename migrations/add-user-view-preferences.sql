-- ============================================================================
-- user_view_preferences — per-user saved view state (columns, filters, sort)
-- ============================================================================
--
-- Backs "remember what I had last" for the waitlist list view: which columns are
-- visible and in what order, which filters were applied, and the sort. Saved
-- silently as the user works; there is no save button.
--
-- KEY: composite PRIMARY KEY (user_id, view_key).
--   user_id  = the Azure AD object id (`oid` claim, server/auth.ts AuthUser.id).
--              Chosen over email because it is immutable — a staff member whose
--              address changes keeps their saved views.
--   view_key = which surface ('waitlist_list' today). Composite so a second
--              customizable surface needs no schema change.
--
-- user_email is denormalized alongside for support/debugging only. It is NEVER
-- the lookup key and may go stale; do not join on it.
--
-- prefs is JSONB rather than a column per setting because the shape changes with
-- every phase of this feature (widths and frozen columns are already planned).
-- A column-per-setting design would mean a migration each time. The payload
-- carries an explicit `version` integer; the client discards a payload whose
-- version it doesn't recognise rather than trying to interpret it.
--
-- Shape (version 1):
--   { "version": 1,
--     "columns": { "visible": ["name","status",...], "order": ["name",...] },
--     "filters": { "umbrella": "all", "status": "all", "insurance": "all",
--                  "modality": "all", "language": "all", "reason": "all",
--                  "serviceType": "all", "hideInactive": true, "staff": "all" },
--     "sort":    { "field": "daysOnWaitlist", "direction": "desc" } }
--
-- searchQuery is deliberately absent: restoring a stale search would show an
-- apparently-empty waitlist with no visible cause.
--
-- THIS IS NOT PATIENT DATA. It holds no PHI — only column ids, filter values
-- and a sort. It is also structurally outside every n8n sync path: the sync
-- writes only sync_contacts, sync_meta and form_submissions, and never
-- enumerates this table. A test asserts that, same pattern as paperwork_status.
--
-- ACCESS: the API only ever reads/writes the row belonging to the authenticated
-- caller. Restored values are re-validated against current access gates on the
-- client, so a stale saved value can never widen what a user can see.
--
-- Per locked decision C16 (schema-before-code): run this on prod BEFORE the code
-- that reads/writes it is deployed.
--
-- HOW TO RUN (prod)
--   fly postgres connect -a tfc-crm-db
--   \i migrations/add-user-view-preferences.sql
--   \d user_view_preferences
--
-- REVERSIBLE: the table is new and standalone — nothing references it and no
-- existing query joins it. To roll back, deploy the previous image (which never
-- reads it); the table is then inert. Drop it only if you want the saved views
-- gone for good:
--   DROP TABLE IF EXISTS user_view_preferences;
--
-- Idempotent: safe to run repeatedly.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_view_preferences (
  user_id     TEXT        NOT NULL,
  view_key    TEXT        NOT NULL,
  user_email  TEXT,
  prefs       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, view_key)
);

-- Verification
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'user_view_preferences'
ORDER BY ordinal_position;

COMMIT;
