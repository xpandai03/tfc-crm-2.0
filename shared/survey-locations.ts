/**
 * Survey offices — where a provider appears on the client survey and its reports.
 * ============================================================================
 *
 * A SEPARATE AXIS FROM crm_providers.location. That column is what scheduling's
 * provider matcher reads, and its dropdown is deliberately ABQ / LL / RR. The
 * survey answers a different question — "which office did this client see this
 * therapist at" — and the practice now needs it to say things matching must
 * not: Corp, and two offices for one therapist.
 *
 * crm_providers.survey_locations holds the codes. NULL or empty means "the same
 * as location", so every provider who was not deliberately changed keeps exactly
 * the behaviour they had.
 *
 * THE STORED LABEL IS THE HISTORY. A survey stores its therapist answer as the
 * roster rendered it, "Name (CODE)", and stores no other location. So the office
 * a past survey counts under is read back from that label (officeFromLabel), not
 * from where the provider sits today — moving a provider never moves their old
 * surveys.
 *
 * ONE EXCEPTION, at the practice's request (2026-10-07): a provider whose survey
 * offices are exactly {CORP} has every survey stored "Name (CORP)", whatever the
 * form offered, and Sandra Rivera's and Amanda Davison's earlier surveys were
 * relabelled to match. See server/survey/corp-labels.ts.
 */

/** Display and sort order. Matches the client's template: Corp first. */
export const SURVEY_OFFICE_ORDER = ["CORP", "ABQ", "LL", "RR"] as const;
export type SurveyOfficeCode = (typeof SURVEY_OFFICE_ORDER)[number];

export const SURVEY_OFFICE_LABELS: Record<SurveyOfficeCode, string> = {
  CORP: "Corp",
  ABQ: "Albuquerque",
  LL: "Los Lunas",
  RR: "Rio Rancho",
};

export function isSurveyOffice(code: string | null | undefined): code is SurveyOfficeCode {
  return (SURVEY_OFFICE_ORDER as readonly string[]).includes((code ?? "").trim().toUpperCase());
}

/** Rank for sorting: known offices in template order, then others, then blank. */
export function surveyOfficeRank(office: string): number {
  const i = (SURVEY_OFFICE_ORDER as readonly string[]).indexOf(office);
  if (i !== -1) return i;
  return office === "" ? SURVEY_OFFICE_ORDER.length + 1 : SURVEY_OFFICE_ORDER.length;
}

/**
 * The offices a provider is offered under on the survey, in their stored order.
 * survey_locations when it names at least one known office; otherwise the
 * provider's location (whatever it is, so an unknown code is not silently lost).
 */
export function surveyOfficesFor(location: string | null | undefined, surveyLocations: readonly string[] | null | undefined): string[] {
  const picked: string[] = [];
  for (const raw of surveyLocations ?? []) {
    const code = (raw ?? "").trim().toUpperCase();
    if (isSurveyOffice(code) && !picked.includes(code)) picked.push(code);
  }
  if (picked.length > 0) return picked;
  const loc = (location ?? "").trim();
  return loc ? [loc] : [];
}

/**
 * The office whose active-client count belongs to this provider. A therapist
 * seen at two offices has ONE caseload in TherapyNotes, so exactly one of their
 * rows carries it: their matching location if it is one of their survey
 * offices, else the first survey office.
 */
export function primarySurveyOffice(location: string | null | undefined, surveyLocations: readonly string[] | null | undefined): string {
  const offices = surveyOfficesFor(location, surveyLocations);
  const loc = (location ?? "").trim();
  return offices.includes(loc) ? loc : offices[0] ?? "";
}

/** "Amanda Plotner (LL)" → "LL". Only a known office code counts; anything else → null. */
export function officeFromLabel(label: string | null | undefined): SurveyOfficeCode | null {
  const m = /\(([^()]*)\)\s*$/.exec((label ?? "").trim());
  if (!m) return null;
  const code = m[1].trim().toUpperCase();
  return isSurveyOffice(code) ? code : null;
}

/** The label the survey shows and stores: "Name (CODE)", or the bare name. */
export function surveyProviderLabel(name: string, office: string): string {
  return office ? `${name} (${office})` : name;
}
