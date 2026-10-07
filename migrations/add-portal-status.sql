-- Patient-portal step outcome on the contact (2026-10-07). Also applied on boot
-- by initPortalColumns (server/therapy-notes/portal.ts); idempotent.
ALTER TABLE sync_contacts
  ADD COLUMN IF NOT EXISTS portal_status TEXT,
  ADD COLUMN IF NOT EXISTS portal_documents TEXT,
  ADD COLUMN IF NOT EXISTS portal_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS portal_detail TEXT;
