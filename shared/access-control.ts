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
  "praley@tfc.health",     // new staff (Sandra-equivalent)
  "angelicac@tfc.health",  // new staff (Sandra-equivalent)
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
  "ebenavidez@tfc.health", // Erica
  "chantel@tfc.health",    // Chantelle
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
  "praley@tfc.health",     // new staff (Sandra-equivalent)
  "angelicac@tfc.health",  // new staff (Sandra-equivalent)
];

export function canEditEmailTemplates(email: string | null | undefined): boolean {
  if (!email) return false;
  return EMAIL_TEMPLATE_EDITOR_EMAILS.includes(email.toLowerCase().trim());
}

// ============================================================================
// Custom Report Builder access (referral report exports)
//
// Manager-only gate for the referral report export endpoints
// (GET /api/export/referrals.{json,csv,xlsx}). Seeded as an exact copy of the
// 5 management editors above (Lane, Amanda, Chantelle, Sandra, Erica) + raunek
// dev access, per the locked build decision. Kept as its OWN list (not an alias
// of EMAIL_TEMPLATE_EDITOR_EMAILS) so the report roster can diverge later
// without side-effecting template-editor access.
//
// Enforcement is server-side (a 403 in server/routes.ts requireReportBuilder);
// any future UI hiding is cosmetic. Reports may contain PHI, so this list is
// the real access boundary.
// ============================================================================
export const REPORT_BUILDER_EMAILS = [
  "lsego@tfc.health",      // Lane
  "amanda@tfc.health",     // Amanda
  "chantel@tfc.health",    // Chantelle
  "sandra@tfc.health",     // Sandra
  "ebenavidez@tfc.health", // Erica Benavidez
  "raunek@tfc.health",     // dev/testing access
  "praley@tfc.health",     // new staff (Sandra-equivalent)
  "angelicac@tfc.health",  // new staff (Sandra-equivalent)
];

export function canBuildReports(email: string | null | undefined): boolean {
  if (!email) return false;
  return REPORT_BUILDER_EMAILS.includes(email.toLowerCase().trim());
}

// ============================================================================
// Waitlist staff-filter dropdown gate (managers).
//
// Managers see a staff-filter <Select> on the waitlist board (filter by any
// staff member); everyone else keeps the plain "Assigned to Me" switch.
// Deliberately its OWN list — do not merge with, alias, or import
// REPORT_BUILDER_EMAILS/other gates, so this can diverge independently.
// Same six people as the canonical manager set; lowercase, compared with
// user.email.toLowerCase() per the existing pattern.
// ============================================================================
export const WAITLIST_STAFF_FILTER_EMAILS = [
  "lsego@tfc.health",      // Lane
  "amanda@tfc.health",     // Amanda
  "chantel@tfc.health",    // Chantelle
  "sandra@tfc.health",     // Sandra
  "ebenavidez@tfc.health", // Erica Benavidez
  "raunek@tfc.health",     // dev/testing access
  "praley@tfc.health",     // new staff (Sandra-equivalent)
  "angelicac@tfc.health",  // new staff (Sandra-equivalent)
];

export function canUseWaitlistStaffFilter(email: string | null | undefined): boolean {
  if (!email) return false;
  return WAITLIST_STAFF_FILTER_EMAILS.includes(email.toLowerCase().trim());
}

// ============================================================================
// Insights AI reporting agent gate (managers).
//
// Manager-only access to the natural-language reporting agent on the Insights
// page (POST /api/insights/agent). Its OWN standalone list — do not import,
// alias, or spread REPORT_BUILDER_EMAILS — so agent access can diverge later.
// Same six people as the report-builder set today; lowercase, compared with
// user.email.toLowerCase(). Server 403 (requireReportAgent) is the real gate.
// ============================================================================
export const REPORT_AGENT_EMAILS = [
  "lsego@tfc.health",      // Lane
  "amanda@tfc.health",     // Amanda
  "chantel@tfc.health",    // Chantelle
  "sandra@tfc.health",     // Sandra
  "ebenavidez@tfc.health", // Erica Benavidez
  "raunek@tfc.health",     // dev/testing access
  "praley@tfc.health",     // new staff (Sandra-equivalent)
  "angelicac@tfc.health",  // new staff (Sandra-equivalent)
];

export function canUseReportAgent(email: string | null | undefined): boolean {
  if (!email) return false;
  return REPORT_AGENT_EMAILS.includes(email.toLowerCase().trim());
}

// ============================================================================
// Management Dashboard access (/dashboard)
//
// Same kill-switch shape as TN_V2_OPEN_TO_ALL above: a boolean constant that
// widens the gate in one line, with no migration and no list surgery.
//   Wed 2026-08-26 — DASHBOARD_OPEN_TO_MANAGEMENT = false → the 2 beta users.
//   Sat 2026-08-29 — FLIPPED to true → DASHBOARD_MANAGEMENT_EMAILS (v199).
//
// ROLLBACK IS THIS ONE LINE. Setting it back to false returns access to the two
// beta users immediately; no migration, no data change, nothing else to undo.
//
// WHY THE FRIDAY GATE IS A POSITIVE ALLOW-LIST AND NOT !isRestrictedUser()
// ------------------------------------------------------------------------
// Insights is gated by RESTRICTED_EMAILS, a THREE-PERSON DENY-LIST — so every
// authenticated user except those three can already reach it. "Insights-
// equivalent" would therefore publish per-clinic performance data to the whole
// staff. The client believes admin/scheduling staff do NOT have Insights
// access; that belief is not what the code does, and reconciling it is an open
// client question. Until it is answered this gate DEFAULTS CLOSED.
//
// DASHBOARD_MANAGEMENT_EMAILS ships empty on purpose. Friday's flip is blocked
// on the client's confirmed roster, which is the correct thing to be blocked
// on — flipping with an empty list locks everyone out loudly rather than
// leaking quietly.
// ============================================================================
export const DASHBOARD_OPEN_TO_MANAGEMENT = true;

export const DASHBOARD_BETA_EMAILS = [
  "raunek@tfc.health", // developer
  "lsego@tfc.health",  // Lane — client ops lead
];

/**
 * The Friday roster, confirmed by the client on 2026-08-26. Every address is
 * taken verbatim from the manager lists already in this file (TN_V2_BETA_EMAILS
 * / REPORT_BUILDER_EMAILS etc.) — none was guessed.
 *
 * The developer address is deliberately included so the person who has to
 * support this on Friday does not lose access the moment the gate flips.
 */
export const DASHBOARD_MANAGEMENT_EMAILS: string[] = [
  "lsego@tfc.health",      // Lane — ops lead
  "chantel@tfc.health",    // Chantelle
  "amanda@tfc.health",     // Amanda
  "sandra@tfc.health",     // Sandra
  "ebenavidez@tfc.health", // Erica Benavidez
  "raunek@tfc.health",     // developer
];

/**
 * Whether a user may see the management dashboard.
 * Server-side (server/routes.ts requireDashboard) is the real boundary; the nav
 * gate and page redirect are cosmetic.
 */
export function canAccessDashboard(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase().trim();
  if (DASHBOARD_OPEN_TO_MANAGEMENT) return DASHBOARD_MANAGEMENT_EMAILS.includes(e);
  return DASHBOARD_BETA_EMAILS.includes(e);
}
