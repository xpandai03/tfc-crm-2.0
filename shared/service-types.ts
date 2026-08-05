/**
 * Canonical "requesting services for" values (shared).
 *
 * Who the request is for. Stored in sync_contacts.requesting_for and used as
 * the Service Type axis in referral reports and Insights.
 *
 * Promoted to shared/ because this exact list was maintained by hand in two
 * places — the staff referral review form and the reporting agent's filter enum
 * — with no link between them. That is the same drift that produced five
 * divergent modality normalizers and the non-canonical "Virtual"/"Either"
 * modality options. One list, imported everywhere.
 *
 * Values are stored VERBATIM (no normalization layer), so changing a string
 * here orphans existing rows. Add, don't rename.
 */
export const SERVICE_TYPES = [
  "Myself",
  "My Child",
  "My Partner & Myself",
  "My Family",
  "Other",
] as const;

export type ServiceType = typeof SERVICE_TYPES[number];
