-- ============================================================================
-- Custody document status + manual account hold — four additive columns on
-- sync_contacts
-- ============================================================================
--
-- custody_doc_status  TEXT     NULL = not tracked. Allowed values in
--                              shared/custody-doc-status.ts ('Not needed',
--                              'Requested', 'Received'). Validated in the PATCH
--                              route, not by a CHECK — same reasoning as
--                              add-paperwork-status.sql.
-- hold_active         BOOLEAN  NOT NULL DEFAULT FALSE. Every existing row is
--                              "not on hold", which is true: nobody has set one.
-- hold_reason         TEXT     One of shared/account-hold.ts HOLD_REASONS while
--                              on hold; NULL otherwise.
-- hold_note           TEXT     Only for the 'Other (see notes)' reason.
--
-- The contacts table in this codebase is sync_contacts (there is no separate
-- "contacts" table). No existing column fits: `custody` and `flags` look close
-- but are written by the n8n sync from the intake form, so a sync would
-- overwrite anything staff put there.
--
-- MANUAL ONLY. Nothing in this migration or the code derives a hold from any
-- other column. Every row starts not-on-hold and stays that way until a person
-- sets one.
--
-- SAFETY / SYNC OWNERSHIP: the n8n sync upserts (syncContacts,
-- upsertSingleContact, fullSyncMigrationContacts) enumerate their DO UPDATE SET
-- columns explicitly, so a column they do not name can never be written or
-- nulled by a sync. None of these four is named there or in enrichSyncContact's
-- fieldMap; `npm run test:modality` asserts that at the source level.
--
-- Per locked decision C16 (schema-before-code): run this on prod BEFORE the
-- code that reads/writes the columns is deployed. The new code SELECTs these
-- columns, so the contact page and the waitlist would fail on a database that
-- does not have them.
--
-- HOW TO RUN (prod)
--   fly postgres connect -a tfc-crm-db
--   \i migrations/add-custody-docs-and-hold.sql
--   -- then verify:
--   \d sync_contacts
--
-- REVERSIBLE: additive, no index, no constraint beyond hold_active's NOT NULL
-- DEFAULT FALSE. To roll back, deploy the previous image (which never reads
-- these columns). Leaving them in place is inert and is the safer rollback;
-- dropping them destroys staff-entered values:
--   ALTER TABLE sync_contacts
--     DROP COLUMN IF EXISTS custody_doc_status,
--     DROP COLUMN IF EXISTS hold_active,
--     DROP COLUMN IF EXISTS hold_reason,
--     DROP COLUMN IF EXISTS hold_note;
--
-- Idempotent: safe to run repeatedly (ADD COLUMN IF NOT EXISTS).
-- On PostgreSQL 11+, ADD COLUMN with a constant DEFAULT is a metadata-only
-- change: no table rewrite, a brief lock only. Safe to run in hours.
-- ============================================================================

BEGIN;

ALTER TABLE sync_contacts
  ADD COLUMN IF NOT EXISTS custody_doc_status TEXT,
  ADD COLUMN IF NOT EXISTS hold_active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS hold_note TEXT;

-- Verification (prints the four columns if the ALTER succeeded)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'sync_contacts'
  AND column_name IN ('custody_doc_status', 'hold_active', 'hold_reason', 'hold_note')
ORDER BY column_name;

COMMIT;
