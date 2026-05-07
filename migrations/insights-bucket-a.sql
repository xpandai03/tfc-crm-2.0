-- ============================================================================
-- Insights cleanup — Bucket A: reason_for_therapy taxonomy migration
-- ============================================================================
--
-- Maps 34 polluted values to canonical reasons (or "Other (legacy free-text)")
-- per the mapping table reviewed and approved by Raunek (BUCKET-A-PROD-DATA.txt
-- + chat transcript). Adds ADHD as a new canonical (D-A4); rolls Postpartum
-- depression (1 entry) into Depression (D-A3).
--
-- Strategy:
--   For each row whose reason_for_therapy contains at least one non-canonical
--   token, split the comma-separated value, apply a CASE-mapping per token
--   (with explicit pass-through for the 26 canonicals + "Other:..." preserves),
--   dedupe within the cell, alphabetize, and re-aggregate. Idempotent.
--
-- HOW TO RUN
--   fly postgres connect -a tfc-crm-db
--   \i migrations/insights-bucket-a.sql
--
-- The script wraps the UPDATE in a transaction with verification SELECTs
-- before/after. To dry-run, change the final COMMIT to ROLLBACK.
--
-- ROLLBACK STRATEGY
--   The migration loses information by design — many polluted values
--   collapse into a single "Other" bucket. Per-row inverse cannot be
--   reconstructed from the migrated data alone. To roll back: restore
--   from the form_submissions audit-trail (each contact's original
--   submission payload preserves the pre-normalization values), or
--   restore from a Postgres backup. Rollback fidelity is "best effort"
--   from form_submissions; ~30 contacts touched, manual restore is
--   feasible if needed.
--
-- Per dry-run: 15 rows touched (14 fully-polluted + 1 mixed cell).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- BEFORE snapshot — distinct reason tokens with counts
-- ----------------------------------------------------------------------------
SELECT 'BEFORE' AS phase, token, count(*)::int AS n
FROM (
  SELECT trim(part) AS token
  FROM sync_contacts,
       LATERAL unnest(string_to_array(reason_for_therapy, ',')) AS part
  WHERE reason_for_therapy IS NOT NULL
    AND length(trim(reason_for_therapy)) > 0
) sub
WHERE token <> ''
GROUP BY token
ORDER BY n DESC;

-- ----------------------------------------------------------------------------
-- The migration
-- ----------------------------------------------------------------------------
UPDATE sync_contacts
SET reason_for_therapy = (
  SELECT string_agg(DISTINCT canon, ', ' ORDER BY canon)
  FROM (
    SELECT
      CASE
        -- Group 1: synonyms, abbreviations, casing variants
        WHEN trim(part) = 'MDD' THEN 'Depression'
        WHEN trim(part) = 'Postpartum depression' THEN 'Depression'
        WHEN trim(part) = 'anxiety disorder' THEN 'Anxiety'
        WHEN trim(part) = 'bipolar disorder' THEN 'Bipolar Disorder'
        WHEN trim(part) = 'suicidal ideations' THEN 'Suicidal Thoughts'
        WHEN trim(part) = 'insomnia' THEN 'Sleep Problems'
        WHEN trim(part) = 'no sleep' THEN 'Sleep Problems'

        -- Group 2: ADHD (new canonical) + judgment-call symptom mapping
        WHEN trim(part) = 'hyperactive' THEN 'ADHD'

        -- Group 3: judgment-call synonyms (mapping table approved)
        WHEN trim(part) = 'change in family dynamic' THEN 'Family Conflict'
        WHEN trim(part) = 'Couples/family problems' THEN 'Family Conflict'
        WHEN trim(part) = 'Couples/family problems - Veteran requesting Christian Based family therapy' THEN 'Family Conflict'
        WHEN trim(part) = 'Veteran interested in couple''s therapy' THEN 'Relationship Issues'
        WHEN trim(part) = 'irritability/anger requesting couples therapy' THEN 'Anger Management'
        WHEN trim(part) = 'chronic depression currently exacerbated as she is also dealing with a lot of grief.' THEN 'Depression'
        WHEN trim(part) = 'Counseling for concern about behavior of biological child' THEN 'Parenting Issues'
        WHEN trim(part) = 'primary treatment goal is to improve communication with spouse' THEN 'Communication Problems'
        WHEN trim(part) = '70%SC for ptsd Veteran' THEN 'PTSD'
        WHEN trim(part) = 'Behavioral Health evaluation following emergency department visit for suicidal ideation and alcohol intoxication' THEN 'Suicidal Thoughts'

        -- Preserve future "Other: <text>" tokens from staff form (idempotency)
        WHEN trim(part) LIKE 'Other:%' THEN trim(part)
        WHEN trim(part) IN ('Other (legacy free-text)', 'Other') THEN 'Other (legacy free-text)'

        -- Pass-through for the 26 canonicals
        WHEN trim(part) IN (
          'Addiction', 'ADHD', 'Anger Management', 'Anxiety', 'Bipolar Disorder',
          'Career Challenges', 'Chronic Pain', 'Communication Problems', 'Depression',
          'Eating Disorders', 'Family Conflict', 'Financial Stress', 'Grief/Loss',
          'Identity Issues', 'Life Transitions', 'OCD', 'Parenting Issues', 'PTSD',
          'Relationship Issues', 'Self-esteem', 'Sexual Problems', 'Sleep Problems',
          'Stress', 'Suicidal Thoughts', 'Trauma', 'Work Stress'
        ) THEN trim(part)

        -- Group 4 + 5: clinical-rare, sentence fragments, multi-paragraph notes
        ELSE 'Other (legacy free-text)'
      END AS canon
    FROM unnest(string_to_array(reason_for_therapy, ',')) AS part
  ) mapped
  WHERE canon IS NOT NULL AND canon <> ''
)
WHERE reason_for_therapy IS NOT NULL
  AND length(trim(reason_for_therapy)) > 0
  -- Idempotency filter: skip rows whose tokens are all already canonical
  -- or already "Other (legacy free-text)" or already "Other:..." — running
  -- the migration twice is a no-op on those rows.
  AND EXISTS (
    SELECT 1
    FROM unnest(string_to_array(reason_for_therapy, ',')) AS part
    WHERE trim(part) <> ''
      AND trim(part) NOT IN (
        'Addiction', 'ADHD', 'Anger Management', 'Anxiety', 'Bipolar Disorder',
        'Career Challenges', 'Chronic Pain', 'Communication Problems', 'Depression',
        'Eating Disorders', 'Family Conflict', 'Financial Stress', 'Grief/Loss',
        'Identity Issues', 'Life Transitions', 'OCD', 'Parenting Issues', 'PTSD',
        'Relationship Issues', 'Self-esteem', 'Sexual Problems', 'Sleep Problems',
        'Stress', 'Suicidal Thoughts', 'Trauma', 'Work Stress',
        'Other (legacy free-text)', 'Other'
      )
      AND trim(part) NOT LIKE 'Other:%'
  );

-- ----------------------------------------------------------------------------
-- AFTER snapshot — distinct reason tokens post-migration
-- ----------------------------------------------------------------------------
SELECT 'AFTER' AS phase, token, count(*)::int AS n
FROM (
  SELECT trim(part) AS token
  FROM sync_contacts,
       LATERAL unnest(string_to_array(reason_for_therapy, ',')) AS part
  WHERE reason_for_therapy IS NOT NULL
    AND length(trim(reason_for_therapy)) > 0
) sub
WHERE token <> ''
GROUP BY token
ORDER BY n DESC;

-- Dry-run results (transaction-rolled-back, May 7 2026):
--   - UPDATE rowCount: 14 rows
--   - Distinct token count: 59 → 27 (26 canonicals + "Other (legacy free-text)")
--   - "Other (legacy free-text)" post-migration: 10 contacts
--   - ADHD post-migration: 3 contacts (2 literal "ADHD" + 1 from the mixed cell's
--     "hyperactive" token; the 2 ADHD-literal rows aren't touched by the UPDATE
--     because ADHD is now in REASON_CANONICALS — they pass the WHERE EXISTS filter)
--   - All 25 prior canonicals retain their counts, with small bumps from
--     judgment-call mappings (Depression 191→194, Family Conflict 125→128,
--     Suicidal Thoughts 40→42, etc.)
--   - 1 mixed-cell contact's reason_for_therapy rewritten to:
--     "ADHD, Family Conflict, Other (legacy free-text), PTSD, Sleep Problems"

COMMIT;
-- To dry-run instead, replace the COMMIT above with: ROLLBACK;
