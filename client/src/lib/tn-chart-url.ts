/**
 * The TherapyNotes chart URL, built from a chart id — in ONE place.
 * ============================================================================
 *
 * ⚠️ UNUSED, AND IT CANNOT OPEN A CHART. Kept so the shape is recorded in one
 * place; nothing in the CRM imports it (the Submissions page's "Open in
 * TherapyNotes" control was removed on 2026-09-23).
 *
 * THE RECON FINDING, stated correctly this time. TherapyNotes does not open a
 * chart from its URL in ANY session. `goto("/app/patients/edit/<PATIENT_ID>/")`
 * in a session that has just authenticated — signed in, not signed out — is
 * redirected to `/app/patients/` with no chart rendered
 * (axiom-browser-agent-clone docs/selectors/tn_v2_phases.md, "a chart cannot be
 * deep-linked in a fresh session"). The agent reaches a chart only by clicking
 * the result anchor on the Patients page, and its code says so. Staff pressing
 * the Submissions control landed on the patients list, which is that redirect.
 *
 * An earlier version of this comment read "fresh session" as "signed out" and
 * concluded that a signed-in tab would land on the chart. It does not.
 *
 * The URL SHAPE below is still correct — it is what the page shows once a chart
 * is open, and the chart id is the one the nightly pull reads off the result
 * anchor — it simply is not an entry point.
 *
 *     https://www.therapynotes.com/app/patients/edit/<PATIENT_ID>/
 *
 * The contact page's inline "Open in TherapyNotes" control opens a stored URL
 * the agent returned (`tnRecord.tnPatientUrl`) and is subject to the same
 * redirect. It was left alone on purpose (out of scope on 2026-09-23).
 */

const TN_BASE = "https://www.therapynotes.com/app/patients/edit";

/**
 * The chart URL for a chart id, or null when there is no id.
 *
 * Null rather than a base URL: a caller with no id must render nothing, not a
 * control that opens the patients list. Returning something "harmless" is how a
 * dead button gets shipped.
 */
export function tnChartUrl(chartId: string | null | undefined): string | null {
  const id = String(chartId ?? "").trim();
  if (!id) return null;
  return `${TN_BASE}/${encodeURIComponent(id)}/`;
}
