-- ============================================================================
-- contact_documents — files kept against a contact
-- ============================================================================
--
-- Custody orders, VA referrals and the fax referral a contact was created from.
-- Bytes live in `content` (BYTEA). The app never lists that column; only the
-- serving route and the scheduling-flow helper read it
-- (server/documents/db.ts).
--
-- A NEW TABLE, touching nothing that exists: no ALTER on sync_contacts, no
-- lock on any live table. Soft delete only (deleted_at / deleted_by_email);
-- `deleted_at IS NULL` means active.
--
-- The app ALSO creates this table on every boot with the same idempotent
-- statements (initContactDocumentsTable, server/index.ts). That is not gated
-- by RUN_MIGRATIONS — same as every other CRM table — so deploying without
-- running this file is safe. Run it first only if you want the table in place
-- before the image lands.
--
-- HOW TO RUN (prod): through the app's own connection, as for
-- add-custody-docs-and-hold.sql — `fly postgres connect -a tfc-crm-db` fails
-- while the cluster has no leader (2026-09-28).
--
-- REVERSIBLE: the previous image never reads this table. To roll back, deploy
-- the previous image and leave the table; dropping it destroys staff uploads:
--   DROP TABLE IF EXISTS contact_documents;
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS contact_documents (
  id                 SERIAL PRIMARY KEY,
  contact_id         INTEGER NOT NULL,
  display_name       TEXT NOT NULL,
  original_filename  TEXT NOT NULL,
  mime_type          TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  sha256             TEXT NOT NULL,
  content            BYTEA NOT NULL,
  source             TEXT NOT NULL,
  uploaded_by_email  TEXT NOT NULL,
  uploaded_by_name   TEXT,
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at         TIMESTAMPTZ,
  deleted_by_email   TEXT
);

CREATE INDEX IF NOT EXISTS idx_contact_documents_active
  ON contact_documents (contact_id, uploaded_at, id)
  WHERE deleted_at IS NULL;

-- Verification: the table's columns
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'contact_documents' ORDER BY ordinal_position;

COMMIT;
