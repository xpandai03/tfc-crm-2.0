/**
 * Which row of the client's portal-documents table a contact falls under.
 * ============================================================================
 *
 * After the TherapyNotes agent books a new client it shares a set of intake
 * documents on the patient portal. The set depends on the service type and on
 * whether the payer is VACCN (the table itself lives in the agent:
 * services/api/portal_documents.py). This decides the SERVICE TYPE the CRM
 * sends, from what the CRM stores:
 *
 *   requesting_for          date of birth (at scheduling)   -> row
 *   ---------------------   ------------------------------     -----------------
 *   My Child                13 or under                      Minor
 *   My Child                14 to 17                         Adolescent
 *   My Child                18+, or unreadable               SKIP child_age_unresolved
 *   Myself                  under 18                         SKIP self_requested_under_18
 *   Myself                  18+ or unreadable                Individual
 *   My Partner & Myself     any                              My Partner & Myself
 *   My Family               any                              My Family
 *   anything else / blank   —                                SKIP service_type_unmapped
 *
 * Approved by the practice 2026-10-07. Values are matched case- and
 * separator-insensitively ("My-Child", "My family" are the same categories).
 * A skip is never a guess: the agent leaves the portal alone and the reason is
 * recorded on the contact, so staff share the documents by hand.
 */
import { AGE_BAND_ADOLESCENT, AGE_BAND_MINOR, ageBandAsOf } from "./age-bands";

export const PORTAL_SERVICE_TYPES = [
  "Minor",
  "Adolescent",
  "Individual",
  "My Partner & Myself",
  "My Family",
] as const;
export type PortalServiceType = (typeof PORTAL_SERVICE_TYPES)[number];

export const PORTAL_SKIP_REASONS = [
  "child_age_unresolved",
  "self_requested_under_18",
  "service_type_unmapped",
] as const;
export type PortalSkipReason = (typeof PORTAL_SKIP_REASONS)[number];

export type PortalServiceDecision =
  | { serviceType: PortalServiceType; skip: null }
  | { serviceType: null; skip: PortalSkipReason };

function canon(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function portalServiceType(
  requestingFor: string | null | undefined,
  dob: unknown,
  at?: Date,
): PortalServiceDecision {
  const v = canon(requestingFor);
  const band = ageBandAsOf(dob, at);
  const under18 = band === AGE_BAND_MINOR || band === AGE_BAND_ADOLESCENT;
  if (v === "my child") {
    if (band === AGE_BAND_MINOR) return { serviceType: "Minor", skip: null };
    if (band === AGE_BAND_ADOLESCENT) return { serviceType: "Adolescent", skip: null };
    return { serviceType: null, skip: "child_age_unresolved" };
  }
  if (v === "myself") {
    return under18
      ? { serviceType: null, skip: "self_requested_under_18" }
      : { serviceType: "Individual", skip: null };
  }
  if (v === "my partner & myself" || v === "my partner and myself") {
    return { serviceType: "My Partner & Myself", skip: null };
  }
  if (v === "my family") return { serviceType: "My Family", skip: null };
  return { serviceType: null, skip: "service_type_unmapped" };
}

/** Portal outcome as the contact stores it (set from the agent's verdict). */
export const PORTAL_STATUSES = ["done", "dry_run", "failed", "skipped"] as const;
export type PortalStatus = (typeof PORTAL_STATUSES)[number];
