-- ============================================================================
-- Modality priorities — four additive nullable columns on sync_contacts
-- ============================================================================
--
-- Adds modality_p1..modality_p4 to sync_contacts to hold a contact's modality
-- selections as an ORDERED priority list (up to 4), replacing the single
-- free-text `modality` column as the basis for counting.
--
-- WHY FOUR COLUMNS (not an array or a join table): every write path in
-- server/sync/db.ts enumerates its columns explicitly, which is what makes
-- column ownership legible and is how CRM-owned columns stay safe from the n8n
-- sync. Four plain TEXT columns match that convention exactly; an array or a
-- child table would not, and modality_p1 needs to be cheaply indexable because
-- it becomes the counting key for reports and Insights.
--
-- DUAL SEMANTICS these columns exist to serve:
--   - Pipeline / list filter: a contact appears under EVERY modality they
--     selected  -> match against the SET {p1..p4}
--   - Referral reports + Insights: each contact counts ONCE, under their top
--     choice                      -> count by p1 only
-- Hence the index on p1 and not on the others.
--
-- Values are the canonical buckets from shared/modality-utils.ts MODALITIES
-- ("Telehealth", "In Person ABQ", "In Person RR", "In Person LL", "In Person",
-- "Hybrid", "Flex"). NOT the raw form strings — the raw text stays in
-- `modality`, which is retained unchanged for display and for pre-priority
-- consumers.
--
-- Column shape: TEXT, nullable, no default (NULL for all existing rows).
--   NULL p1 means "not yet prioritized" and every read path falls back to
--   normalizing the legacy `modality` string, so rows this migration and the
--   backfill do not cover keep working exactly as they do today.
--
-- SAFETY: the n8n sync upserts (syncContacts / upsertSingleContact) enumerate
-- their DO UPDATE SET columns explicitly, so these CRM-owned columns are NEVER
-- clobbered by a sync. They are deliberately kept out of those lists (same rule
-- as scheduled_appointment_* and language). This migration touches no
-- application logic.
--
-- Per locked decision C16 (schema-before-code): run this on prod BEFORE the
-- code that reads/writes the columns is deployed. No RUN_MIGRATIONS dependency.
--
-- HOW TO RUN (prod)
--   fly postgres connect -a tfc-crm-db
--   \i migrations/add-modality-priorities.sql
--   -- then verify:
--   \d sync_contacts
--
-- Idempotent: safe to run repeatedly (ADD COLUMN / CREATE INDEX IF NOT EXISTS).
-- Additive-only and non-blocking on a table this size — safe to run in hours.
-- ============================================================================

BEGIN;

ALTER TABLE sync_contacts
  ADD COLUMN IF NOT EXISTS modality_p1 TEXT,
  ADD COLUMN IF NOT EXISTS modality_p2 TEXT,
  ADD COLUMN IF NOT EXISTS modality_p3 TEXT,
  ADD COLUMN IF NOT EXISTS modality_p4 TEXT;

-- p1 is the counting key for referral reports and the Insights breakdown.
CREATE INDEX IF NOT EXISTS idx_sync_contacts_modality_p1
  ON sync_contacts(modality_p1);

-- Verification (prints the four new columns if the ALTER succeeded)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sync_contacts'
  AND column_name LIKE 'modality_p%'
ORDER BY column_name;

COMMIT;
