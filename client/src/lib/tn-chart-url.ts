/**
 * The TherapyNotes chart URL, built from a chart id — in ONE place.
 * ============================================================================
 *
 * WHY THIS EXISTS. Until now the CRM never built a chart URL: the contact page
 * opens a URL the AGENT returned and the CRM stored verbatim
 * (`tnRecord.tnPatientUrl`, pages/contact-detail.tsx). That works for a patient
 * the CRM created and for nobody else — about half the active caseload predates
 * the CRM and has no such record.
 *
 * A matched survey carries something better: the chart id the nightly pull read
 * off the Patients-page result anchor. This turns that id into the same URL the
 * agent produces, so both routes land on the same page.
 *
 * The shape is the one recon verified and the one the create flow produces
 * (docs/selectors/tn_v2_phases.md, "Chart header selectors"):
 *
 *     https://www.therapynotes.com/app/patients/edit/<PATIENT_ID>/
 *
 * THE TRAILING SLASH IS PART OF IT. Every observed chart URL carries one.
 *
 * ⚠️ IT ONLY OPENS FOR AN ALREADY-SIGNED-IN SESSION. Recon verified that
 * `goto("/app/patients/edit/<id>/")` in a FRESH session is redirected to
 * `/app/patients/` with no chart rendered. That is exactly the behaviour the
 * contact page's control has always had and staff use daily — a signed-in tab
 * lands on the chart, a signed-out one lands on the patients list. This is not
 * a new caveat and there is nothing to do about it from here.
 *
 * ONE BUILDER, ON PURPOSE. If a second call site ever needs a chart URL it
 * imports this. The id is opaque (e.g. "1L4JcJ5qscGPg3KTuHS86A", 16 or 22
 * characters, never numeric), so nothing here parses or validates its shape
 * beyond "is there anything at all" — a length or charset rule written here
 * would reject a real id the day TherapyNotes widens the space.
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
