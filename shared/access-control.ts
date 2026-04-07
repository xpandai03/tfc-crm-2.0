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
