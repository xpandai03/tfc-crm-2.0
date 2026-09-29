-- ============================================================================
-- contact_documents: when a document was filed to TherapyNotes, and by which run
-- ============================================================================
--
-- tn_uploaded_at    TIMESTAMPTZ  NULL = not on the chart yet. Set when the TN
--                                agent confirms the document on the chart.
--                                Only NULL documents are sent on the next Add to
--                                Schedule run.
-- tn_upload_run_id  TEXT         The run (runId) that filed it.
--
-- Two nullable columns, no default, no index: a metadata-only change.
--
-- ALSO APPLIED ON BOOT. initContactDocumentsTable (server/documents/db.ts)
-- runs the same ADD COLUMN IF NOT EXISTS on every start, unconditionally (not
-- gated by RUN_MIGRATIONS), exactly as it creates the table. Deploying the
-- image is enough; this file is for applying it ahead of the image.
--
-- HOW TO RUN (prod), if wanted ahead of the deploy: through the app's own
-- connection, as for add-custody-docs-and-hold.sql — `fly postgres connect
-- -a tfc-crm-db` fails while the cluster has no leader.
--
-- REVERSIBLE: the previous image never reads these columns. Leave them; or
--   ALTER TABLE contact_documents DROP COLUMN IF EXISTS tn_uploaded_at,
--                                 DROP COLUMN IF EXISTS tn_upload_run_id;
-- which forgets which documents are already in TherapyNotes (the agent's
-- exact-name check would still stop a second copy).
--
-- Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE contact_documents
  ADD COLUMN IF NOT EXISTS tn_uploaded_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tn_upload_run_id TEXT;

SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'contact_documents' AND column_name IN ('tn_uploaded_at', 'tn_upload_run_id')
 ORDER BY column_name;

COMMIT;
