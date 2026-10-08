-- Corp-only providers' surveys count under Corp, past ones included (2026-10-07).
--
-- The practice asked that every survey for Sandra Rivera and Amanda Davison,
-- not only those after their move to Corp, count under CORP. A survey's office
-- is read from its stored therapist label "Name (CODE)"
-- (shared/survey-locations.ts), so this rewrites that label to "Name (CORP)"
-- wherever it names either provider with any other office, an unknown code, or
-- none. One activity_log line per changed row: submission id and offices only,
-- never the client's name.
--
-- Idempotent: a row already labelled CORP (in any case) is never selected, so a
-- second run changes nothing and logs nothing. Also applied on boot by
-- applyCorpSurveyLabelBackfill (server/survey/corp-labels.ts), which carries
-- this statement verbatim; scripts/test-survey-corp-labels-db.ts fails if the
-- two differ.
WITH corp(name) AS (
  VALUES ('Sandra Rivera'), ('Amanda Davison')
),
surveys AS MATERIALIZED (
  SELECT id, payload::jsonb AS doc
  FROM form_submissions
  WHERE form_type = 'survey'
),
targets AS (
  SELECT s.id, s.doc, c.name,
         upper(trim(substring(s.doc->'answers'->>'therapist' from '\(([^()]*)\)\s*$'))) AS old_office
  FROM surveys s
  JOIN corp c
    ON lower(regexp_replace(trim(regexp_replace(s.doc->'answers'->>'therapist', '\s*\([^()]*\)\s*$', '')), '\s+', ' ', 'g'))
     = lower(c.name)
  WHERE jsonb_typeof(s.doc->'answers'->'therapist') = 'string'
),
changed AS (
  UPDATE form_submissions f
     SET payload = jsonb_set(t.doc, '{answers,therapist}', to_jsonb(t.name || ' (CORP)'))::text
    FROM targets t
   WHERE f.id = t.id
     AND t.old_office IS DISTINCT FROM 'CORP'
  RETURNING f.id, t.name, t.old_office
)
INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
SELECT 'survey_relabelled', 'system', 'submission', id::text, 'Client survey',
       json_build_object(
         'submissionId', id,
         'provider', name,
         'from', COALESCE(old_office, ''),
         'to', 'CORP',
         'reason', 'corp-only-backfill-2026-10-07'
       )::text
FROM changed
RETURNING entity_id;
