/**
 * Feature-level access control
 *
 * Restricts certain users from accessing sensitive pages (Insights, Providers).
 * To update restrictions, modify RESTRICTED_EMAILS below.
 */

const RESTRICTED_EMAILS = [
  "amayac@tfc.health",
  "victoria@tfc.health",
  "nbockius@tfc.health",
];

const GATED_PATHS = ["/insights", "/providers"];

export function isRestrictedUser(email: string | null | undefined): boolean {
  if (!email) return false;
  return RESTRICTED_EMAILS.includes(email.toLowerCase().trim());
}

export function isGatedPath(path: string): boolean {
  return GATED_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

// ============================================================================
// "Add to Schedule in TN" access (Phase 1 feature, v152 → opened to all)
//
// Single, shared control honored by BOTH the client (contact-detail canUseTnV2)
// and the server (isTnV2BetaUser). The feature is proven stable, so it's now
// open to all AUTHENTICATED CRM users.
//
// KILL SWITCH: this is a widen-not-delete change. To re-restrict to the original
// beta team, flip TN_V2_OPEN_TO_ALL to false — a one-line edit in this one file
// that moves client + server in lockstep back to the TN_V2_BETA_EMAILS allow-list.
// ============================================================================
export const TN_V2_OPEN_TO_ALL = true;

export const TN_V2_BETA_EMAILS = [
  "lsego@tfc.health",
  "amanda@tfc.health",
  "sandra@tfc.health",
  "chantel@tfc.health",
  "ebenavidez@tfc.health", // Erica Benavidez
  "raunek@tfc.health",     // dev/testing access
];

/**
 * Whether a user may use "Add to Schedule in TN".
 * Authenticated users only (an email must be present). When TN_V2_OPEN_TO_ALL is
 * true, all authenticated users pass; when false, only TN_V2_BETA_EMAILS do.
 */
export function isTnV2User(email: string | null | undefined): boolean {
  if (!email) return false; // authenticated users only — never unauthenticated
  if (TN_V2_OPEN_TO_ALL) return true;
  return TN_V2_BETA_EMAILS.includes(email.toLowerCase().trim());
}

// Build-fix shim: server/routes.ts (commit 3731cdf) imports
// canAccessReferralUpload from this module, but the corresponding export
// was never committed — the actual implementation lives in the Phase 2
// WIP that's currently stashed. Re-add it here so the Phase 1 branch
// builds cleanly. Phase 2 work will reconcile the allowlist when it merges.
export const REFERRAL_UPLOAD_EMAILS = [
  "raunek@tfc.health",
  "lsego@tfc.health",
  "dawn@tfc.health",
];

export function canAccessReferralUpload(email: string | null | undefined): boolean {
  if (!email) return false;
  return REFERRAL_UPLOAD_EMAILS.includes(email.toLowerCase().trim());
}

// ============================================================================
// Email-template editor access (Build 2)
//
// The 5 management users allowed to CREATE/EDIT email templates. All staff keep
// USING templates read-only via the contact-level send-email dropdown (the GET
// endpoint is ungated); only these 5 can hit the write endpoints (server-side
// 403). Emails confirmed against the existing TN_V2_BETA_EMAILS group above —
// same domain pattern; note "chantel" (not "chantelle") and ebenavidez = Erica
// Benavidez, both matching the established lists.
//   Lane → lsego · Amanda → amanda · Chantelle → chantel · Sandra → sandra · Erica → ebenavidez
// ============================================================================
export const EMAIL_TEMPLATE_EDITOR_EMAILS = [
  "lsego@tfc.health",      // Lane
  "amanda@tfc.health",     // Amanda
  "chantel@tfc.health",    // Chantelle
  "sandra@tfc.health",     // Sandra
  "ebenavidez@tfc.health", // Erica Benavidez
  "raunek@tfc.health",     // dev/testing access (same precedent as REFERRAL_UPLOAD_EMAILS / TN_V2_BETA_EMAILS) — remove for strict 5-only
];

export function canEditEmailTemplates(email: string | null | undefined): boolean {
  if (!email) return false;
  return EMAIL_TEMPLATE_EDITOR_EMAILS.includes(email.toLowerCase().trim());
}
