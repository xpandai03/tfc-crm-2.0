-- ============================================================================
-- Contact language — additive nullable column on sync_contacts
-- ============================================================================
--
-- Adds one nullable TEXT column to sync_contacts to hold a contact's preferred
-- service language (free text, e.g. 'English' / 'Spanish'). Two future consumers
-- will write/read it through one shared column:
--   - a manual "Language" field in the contact-level intake-details UI, and
--   - the public RFS intake form (auto-capture on submission).
--
-- This migration creates ONLY the column. No application logic, read path, write
-- path, or UI is attached in this change — existing rows hold NULL and behavior
-- is unchanged until the later build wires it up.
--
-- Column shape: TEXT, nullable, no default (NULL for all existing rows).
--   Matches the rest of sync_contacts, which stores all such fields as plain TEXT.
--
-- SAFETY: the n8n sync upsert (server/sync/db.ts syncContacts / upsertSingleContact)
-- enumerates its DO UPDATE SET columns explicitly, so a CRM-owned column like this
-- is NEVER clobbered by a sync. The later build will keep `language` out of those
-- upsert lists (same rule as scheduled_appointment_*); this migration touches no
-- sync logic.
--
-- Per locked decision C16 (schema-before-code): run this on prod BEFORE the code
-- that reads/writes the column is deployed. No RUN_MIGRATIONS dependency.
--
-- HOW TO RUN (prod)
--   fly postgres connect -a tfc-crm-db
--   \i migrations/add-language-column.sql
--   -- then verify:
--   \d sync_contacts
--
-- Idempotent: safe to run repeatedly (ADD COLUMN IF NOT EXISTS).
-- ============================================================================

BEGIN;

ALTER TABLE sync_contacts
  ADD COLUMN IF NOT EXISTS language TEXT;

-- Verification (prints the new column if the ALTER succeeded)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sync_contacts'
  AND column_name = 'language'
ORDER BY column_name;

COMMIT;
