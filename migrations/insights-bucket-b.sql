-- ============================================================================
-- Insights cleanup — Bucket B: Service Type unification
-- ============================================================================
--
-- Collapses two terminology variants ("Couples", "My Partner") into the
-- canonical "My Partner & Myself" on sync_contacts.requesting_for. The
-- Insights breakdown reads requesting_for directly with no normalization,
-- so the migration shows up immediately in the chart once data is fixed
-- and the new code is deployed (the form-side change in this PR removes
-- the bad options going forward).
--
-- Per locked decision D-B1 (Insights cleanup audit, May 6 2026).
--
-- HOW TO RUN
--   fly postgres connect -a tfc-crm-db
--   \i migrations/insights-bucket-b.sql
--
-- ROLLBACK STRATEGY
--   The migration loses information — both "Couples" and "My Partner" map
--   to the same canonical, so a perfect inverse isn't possible without an
--   audit trail. To roll back: identify the affected rows by joining
--   form_submissions.payload (which preserves the original requesting_for
--   value before any DB normalization) on contact_id, and restore. Most
--   rows are pre-form-submissions and won't have a payload audit trail —
--   in that case, "rolling back" is impractical. Confirm with Raunek
--   before running the COMMIT below if rollback fidelity matters.
--
--   Per dry-run: 3 rows ("Couples"), 0 rows ("My Partner"). Practical
--   rollback need is low.
-- ============================================================================

BEGIN;

-- Pre-migration snapshot
SELECT 'BEFORE' AS phase, requesting_for, count(*)::int AS n
FROM sync_contacts
GROUP BY 1, 2
ORDER BY 3 DESC;

-- Couples → My Partner & Myself (3 rows per dry-run)
UPDATE sync_contacts SET requesting_for = 'My Partner & Myself'
WHERE requesting_for = 'Couples';

-- My Partner → My Partner & Myself (0 rows in current prod, but defensive)
UPDATE sync_contacts SET requesting_for = 'My Partner & Myself'
WHERE requesting_for = 'My Partner';

-- Post-migration verification
SELECT 'AFTER' AS phase, requesting_for, count(*)::int AS n
FROM sync_contacts
GROUP BY 1, 2
ORDER BY 3 DESC;

-- Expected (per dry-run snapshot, May 6 2026):
--   Couples (3)         → My Partner & Myself (100 → 103)
--   My Partner (0)      → no rows affected
--   Total rows touched: 3

COMMIT;
-- To dry-run instead, replace the COMMIT above with: ROLLBACK;
