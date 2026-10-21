-- "Show on survey" on providers (2026-10-21).
--
-- false = the provider is left off the client survey's therapist list (both
-- forms, both languages) and out of the survey snapshot and export for periods
-- with none of their surveys; a period that has them keeps their row. Editable
-- on the provider edit dialog. Nothing else reads it: matching, scheduling,
-- the provider list and TherapyNotes are unaffected.
--
-- Also applied on every boot by initRemindersTable (server/reminders/db.ts).
ALTER TABLE crm_providers ADD COLUMN IF NOT EXISTS show_on_survey BOOLEAN NOT NULL DEFAULT true;

-- Angelica Villicana hidden, once (client request 2026-10-21). Applied on boot
-- by applyVillicanaHidden (server/survey/villicana-hidden.ts), guarded by a
-- marker activity row so a later re-tick in the UI is never undone.
WITH target AS (
  SELECT id, name, show_on_survey FROM crm_providers
   WHERE lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = 'angelica villicana'
     AND NOT EXISTS (
       SELECT 1 FROM activity_log
        WHERE type = 'provider_survey_visibility_set'
          AND metadata::jsonb->>'reason' = 'villicana-hidden-2026-10-21'
     )
),
changed AS (
  UPDATE crm_providers c SET show_on_survey = false, updated_at = NOW()
    FROM target t WHERE c.id = t.id AND (SELECT COUNT(*) FROM target) = 1
  RETURNING c.id, c.name, t.show_on_survey AS before
)
INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
SELECT 'provider_survey_visibility_set', 'system', 'provider', id::text, name,
       json_build_object('from', before, 'to', false, 'reason', 'villicana-hidden-2026-10-21')::text
FROM changed;
