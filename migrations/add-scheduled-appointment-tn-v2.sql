-- ============================================================================
-- TN V2 "Add to Schedule in TN (Beta)" — scheduled appointment columns
-- ============================================================================
--
-- Adds two nullable TEXT columns to sync_contacts to hold the staff-entered
-- initial appointment date and time that drive the V2 TherapyNotes workflow
-- (create patient + upload PDFs + schedule appointment).
--
-- Column shape decision (locked C3): TWO TEXT columns, not a single TIMESTAMPTZ.
--   - The whole sync_contacts table stores dates as TEXT (patient_dob, date_added).
--   - The widget uses separate date + time inputs.
--   - The values are sent (lightly reformatted) verbatim to the TN agent; a
--     TIMESTAMPTZ would force lossy timezone parsing on a wall-clock appt time.
--
-- Storage formats:
--   scheduled_appointment_date  — ISO 'YYYY-MM-DD' (from the <input type=date>);
--                                 reformatted to m/d/yyyy when building the V2 payload.
--   scheduled_appointment_time  — free text 'h:mm am/pm' (e.g. '2:00 pm'),
--                                 validated client-side, sent verbatim to TN.
--
-- SAFETY: the n8n sync upsert (server/sync/db.ts syncContacts) enumerates its
-- DO UPDATE SET columns explicitly, so these CRM-owned columns are NEVER
-- clobbered by a sync. Verified against server/sync/db.ts:373-416.
--
-- Per locked decision C16 (schema-before-code): run this on prod BEFORE the
-- code that reads/writes these columns is deployed. No RUN_MIGRATIONS dependency.
--
-- HOW TO RUN (prod)
--   fly postgres connect -a tfc-crm-db
--   \i migrations/add-scheduled-appointment-tn-v2.sql
--   -- then verify:
--   \d sync_contacts
--
-- Idempotent: safe to run repeatedly (ADD COLUMN IF NOT EXISTS).
-- ============================================================================

BEGIN;

ALTER TABLE sync_contacts
  ADD COLUMN IF NOT EXISTS scheduled_appointment_date TEXT;

ALTER TABLE sync_contacts
  ADD COLUMN IF NOT EXISTS scheduled_appointment_time TEXT;

-- Verification (prints the two new columns if the ALTERs succeeded)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sync_contacts'
  AND column_name IN ('scheduled_appointment_date', 'scheduled_appointment_time')
ORDER BY column_name;

COMMIT;
