-- Amanda Plotner's surveys count under Los Lunas "for now" (2026-10-15).
--
-- The practice asked that every survey of hers labelled ABQ be relabelled LL.
-- Runs only while her survey office set is exactly {LL}; once ABQ is added back
-- it selects nothing, so a genuine ABQ survey keeps its label. One
-- survey_relabelled activity row per changed survey: submission id and offices
-- only, never the client's name. Idempotent: an LL row is never selected.
-- Also applied on boot by applyPlotnerLosLunas (server/survey/plotner-ll.ts),
-- which carries this statement verbatim; scripts/test-survey-plotner-ll-db.ts
-- fails if the two differ.
WITH plotner AS (
  SELECT 'Amanda Plotner'::text AS name
),
surveys AS MATERIALIZED (
  SELECT id, payload::jsonb AS doc
  FROM form_submissions
  WHERE form_type = 'survey'
),
targets AS (
  SELECT s.id, s.doc, p.name,
         upper(trim(substring(s.doc->'answers'->>'therapist' from '\(([^()]*)\)\s*$'))) AS old_office
  FROM surveys s
  JOIN plotner p
    ON lower(regexp_replace(trim(regexp_replace(s.doc->'answers'->>'therapist', '\s*\([^()]*\)\s*$', '')), '\s+', ' ', 'g'))
     = lower(p.name)
  WHERE jsonb_typeof(s.doc->'answers'->'therapist') = 'string'
),
ll_only AS (
  SELECT 1 FROM crm_providers
   WHERE lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = 'amanda plotner'
     AND survey_locations = ARRAY['LL']::text[]
),
changed AS (
  UPDATE form_submissions f
     SET payload = jsonb_set(t.doc, '{answers,therapist}', to_jsonb(t.name || ' (LL)'))::text
    FROM targets t
   WHERE f.id = t.id
     AND t.old_office = 'ABQ'
     AND EXISTS (SELECT 1 FROM ll_only)
  RETURNING f.id, t.name, t.old_office
)
INSERT INTO activity_log (type, actor_email, entity_type, entity_id, entity_name, metadata)
SELECT 'survey_relabelled', 'system', 'submission', id::text, 'Client survey',
       json_build_object(
         'submissionId', id,
         'provider', name,
         'from', old_office,
         'to', 'LL',
         'reason', 'plotner-ll-only-2026-10-15'
       )::text
FROM changed
RETURNING entity_id;
