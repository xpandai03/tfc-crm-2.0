-- ============================================================================
-- Paperwork Status — one additive nullable column on sync_contacts
-- ============================================================================
--
-- Tracks whether intake paperwork has been sent to a contact and received back.
-- Allowed values come from shared/paperwork-status.ts (currently 'Sent' and
-- 'Received'); NULL means "not tracked yet" and is the default for every
-- existing row.
--
-- THIS IS NOT A STATUS CODE. It does not participate in the status-code /
-- umbrella cluster system, does not move a contact through the pipeline, and
-- nothing keys off it. It is a plain CRM-owned field.
--
-- NO CHECK CONSTRAINT ON PURPOSE. The clinic expects to add options, and the
-- allowed set lives in shared/paperwork-status.ts where the UI and the API
-- validation both read it. A DB-level constraint would mean a migration every
-- time a value is added, and would reject rows the application already
-- considers valid. Validation is enforced server-side in the PATCH route.
--
-- SAFETY / SYNC OWNERSHIP: the n8n sync upserts (syncContacts,
-- upsertSingleContact, fullSyncMigrationContacts) enumerate their DO UPDATE SET
-- columns explicitly, so a column they do not name can never be written or
-- nulled by a sync. paperwork_status is deliberately absent from all three, and
-- from enrichSyncContact's fieldMap. `npm run test:modality` asserts this at the
-- source level so it cannot silently regress — the same guard added after the
-- July incident where a sync clobbered a CRM-owned column.
--
-- Per locked decision C16 (schema-before-code): run this on prod BEFORE the
-- code that reads/writes the column is deployed.
--
-- HOW TO RUN (prod)
--   fly postgres connect -a tfc-crm-db
--   \i migrations/add-paperwork-status.sql
--   -- then verify:
--   \d sync_contacts
--
-- REVERSIBLE: this column is additive and carries no constraint, no index and
-- no default, so nothing depends on it. To roll back, deploy the previous image
-- (which never reads the column) and then, only if you want the column gone:
--   ALTER TABLE sync_contacts DROP COLUMN IF EXISTS paperwork_status;
-- Dropping is destructive of any staff-entered values; leaving the column in
-- place is inert and is the safer rollback.
--
-- Idempotent: safe to run repeatedly (ADD COLUMN IF NOT EXISTS).
-- Additive-only and non-blocking on a table this size — safe to run in hours.
-- ============================================================================

BEGIN;

ALTER TABLE sync_contacts
  ADD COLUMN IF NOT EXISTS paperwork_status TEXT;

-- Verification (prints the new column if the ALTER succeeded)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sync_contacts'
  AND column_name = 'paperwork_status';

COMMIT;
