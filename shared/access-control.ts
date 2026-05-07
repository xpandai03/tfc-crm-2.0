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
