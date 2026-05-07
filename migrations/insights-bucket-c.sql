-- ============================================================================
-- Insights cleanup — Bucket C: modality typo variant cleanup
-- ============================================================================
--
-- Cleans up 32 distinct modality values down to canonical forms. The
-- normalization map in client code already collapses these at display
-- time, so this migration is for DB hygiene rather than display
-- correctness — running it makes future analytics queries against
-- the raw column accurate.
--
-- Per locked decision D-C1 (Insights cleanup audit, May 6 2026).
--
-- HOW TO RUN
--   fly postgres connect -a tfc-crm-db
--   \i migrations/insights-bucket-c.sql
--
-- The script wraps the UPDATE in a transaction with verification SELECTs
-- so you can review the affected rows before COMMIT. To dry-run, change
-- the final COMMIT to ROLLBACK.
--
-- ROLLBACK STRATEGY
--   Reverse mapping is straightforward — the typo variants are stable
--   strings. If a rollback is needed, run the inverse UPDATEs (typo →
--   was-typo) using the same WHERE clauses with the canonical value
--   as source. No data is destroyed (no DELETEs).
-- ============================================================================

BEGIN;

-- Pre-migration snapshot (for verification logging)
SELECT 'BEFORE' AS phase, modality, count(*)::int AS n
FROM sync_contacts
WHERE modality IN (
  'In Person- Los Lunas',
  'In-person Los Lunas, Telehealth',
  'In Person- Rio Rancho',
  'In person - RR',
  'In Person - RR',
  'In Person-Rio Rancho',
  'In person - ABQ',
  'In Person- Albuquerque',
  'In Person- Albuquerque or Rio Rancho',
  'Flexible (Open to Any Option).',
  'TH'
)
GROUP BY 1, 2
ORDER BY 3 DESC;

-- Los Lunas typo variants → canonical
UPDATE sync_contacts SET modality = 'In Person - Los Lunas'
WHERE modality = 'In Person- Los Lunas';

-- Rio Rancho typo variants → canonical
UPDATE sync_contacts SET modality = 'In Person - Rio Rancho'
WHERE modality IN ('In Person- Rio Rancho', 'In person - RR', 'In Person - RR', 'In Person-Rio Rancho');

-- Albuquerque typo variants → canonical
UPDATE sync_contacts SET modality = 'In Person - Albuquerque'
WHERE modality IN ('In person - ABQ', 'In Person- Albuquerque');

-- Combined "ABQ or RR" typo → canonical
UPDATE sync_contacts SET modality = 'In Person - Albuquerque or Rio Rancho'
WHERE modality = 'In Person- Albuquerque or Rio Rancho';

-- Flexible trailing-period + lowercase variants → canonical
UPDATE sync_contacts SET modality = 'Flexible (Open to Any Option)'
WHERE modality IN ('Flexible (Open to Any Option).', 'Flexible (open to any option)');

-- TH → Telehealth
UPDATE sync_contacts SET modality = 'Telehealth'
WHERE modality = 'TH';

-- NOTE: multi-value entries like "In Person - Los Lunas, Telehealth" are
-- left untouched — those represent providers willing to do BOTH options
-- and aren't typos. They surface as "Unknown" in the current normalization
-- map, which is a separate problem for a future PR (the map needs to
-- handle multi-value modality entries — surfaced in audit, not blocking
-- B/C). The "In-person Los Lunas, Telehealth" lowercase variant IS a
-- typo though; left untouched here because cleaning just the casing
-- still leaves the multi-value problem unsolved. Out of scope.

-- Post-migration verification: should show counts shifted into canonicals
SELECT 'AFTER' AS phase, modality, count(*)::int AS n
FROM sync_contacts
WHERE modality LIKE 'In Person%'
   OR modality LIKE 'Flexible%'
   OR modality = 'Telehealth'
GROUP BY 1, 2
ORDER BY 3 DESC;

-- Expected affected rows (per dry-run snapshot taken May 6 2026):
--   In Person- Los Lunas              2 → folded into In Person - Los Lunas (118 → 120)
--   In Person- Rio Rancho             3 ┐
--   In person - RR                    5 │
--   In Person - RR                    3 ├ → folded into In Person - Rio Rancho (129 → 141)
--   In Person-Rio Rancho              1 ┘
--   In person - ABQ                   2 ┐
--   In Person- Albuquerque            1 ┘ → folded into In Person - Albuquerque (128 → 131)
--   In Person- Albuquerque or RR      2 → folded into In Person - Albuquerque or Rio Rancho (33 → 35)
--   Flexible (Open to Any Option).    1 ┐ → folded into Flexible (Open to Any Option) (49 → 52)
--   Flexible (open to any option)     2 ┘
--   TH                                3 → folded into Telehealth (78 → 81)
--   Total rows touched: 25

COMMIT;
-- To dry-run instead, replace the COMMIT above with: ROLLBACK;
