/**
 * Age bands for the service-type axis, defined once.
 * ============================================================================
 *
 * The client, 26 August 2026:
 *
 *   "Rather than just 'My Child', we'd want minor and adolescent."
 *   Minor: 13 and under. Adolescent: 14 to 17.
 *   "It's 14 until they turn 18. 18-year-olds are individuals."
 *
 * DERIVED, NEVER STORED. Nothing writes a band to a record. The stored fact
 * stays `requesting_for = "My Child"`, and the band is computed from
 * `patient_dob` wherever it is shown.
 *
 * That decision was settled by this database rather than by argument. A stored
 * age column already exists — computed once during the Excel import — and of
 * the 192 "My Child" rows carrying one, 84 (44%) now disagree with the date of
 * birth on the same row. Storing this label would repeat exactly that, and
 * would leave a sixth legacy value in a field whose own documentation warns
 * that renaming orphans rows (shared/service-types.ts). Date-of-birth coverage
 * on those records is 100%, so deriving costs nothing and is never unavailable.
 *
 * THE REFERENCE DATE IS A PARAMETER, AND THAT IS THE WHOLE DESIGN.
 * "Accurate" and "reproducible" want different reference dates, not different
 * storage:
 *
 *   REPORTS (monthly report, referral CSV, dashboard export) band a child by
 *   their age ON THE REFERRAL DATE. August's report says a child was 13 in
 *   August, and says so again when re-run in December. Numbers never move
 *   under a reader.
 *
 *   OPERATIONAL SCREENS (waitlist, contact record) band by age TODAY, because
 *   someone looking for a therapist needs to know how old the child is now.
 *
 * A child who has just had a birthday is therefore Adolescent on August's
 * report and 18+ on today's waitlist. Both are correct; they answer different
 * questions. Every surface labels which one it is asking — see AGE_BASIS_NOTE.
 *
 * IMPORTS: none. Read by the server, the CRM client and the shared schema.
 */

export const AGE_BAND_MINOR = "Minor";
export const AGE_BAND_ADOLESCENT = "Adolescent";
export const AGE_BAND_ADULT = "18+";
export const AGE_BAND_UNKNOWN = "Age unknown";

export const AGE_BANDS = [
  AGE_BAND_MINOR,
  AGE_BAND_ADOLESCENT,
  AGE_BAND_ADULT,
] as const;

export type AgeBand = typeof AGE_BANDS[number] | typeof AGE_BAND_UNKNOWN;

/**
 * The boundaries, named so a reader does not have to infer them from a
 * comparison. Inclusive on both sides.
 */
export const MINOR_MAX_AGE = 13;
export const ADOLESCENT_MIN_AGE = 14;
export const ADOLESCENT_MAX_AGE = 17;
export const ADULT_MIN_AGE = 18;

/**
 * Reduce a stored date of birth to YYYY-MM-DD, or null.
 *
 * Handles the formats `patient_dob` actually holds: ISO (optionally with a
 * time), YYYY/MM/DD, M/D/YYYY and M-D-YYYY. Deliberately narrower than
 * normalizeDateValue() in server/sync/db.ts, which is the INGESTION normaliser
 * and also accepts written months and Excel serials — a value that reached
 * storage has already been through it. Deliberately strict about two-digit
 * years: guessing the century on a date of birth is how a confident wrong
 * answer gets made.
 */
export function canonicalDobIso(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);

  const slashIso = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashIso) return validDate(+slashIso[1], +slashIso[2], +slashIso[3]);

  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (us) return validDate(+us[3], +us[1], +us[2]);

  return null;
}

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A Date, an ISO string, or null for "today". Accepted anywhere a reference date is. */
export type ReferenceDate = Date | string | number | null | undefined;

/**
 * The reference date as YYYY-MM-DD.
 *
 * Compared as CALENDAR DATES, not timestamps: a birthday is a date, and
 * subtracting instants would make a child's band depend on the reader's
 * timezone. A referral row's created_at is a timestamp, so it is truncated to
 * its date here rather than at each call site.
 */
function referenceIso(at: ReferenceDate): string | null {
  if (at === null || at === undefined) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
  if (at instanceof Date) {
    if (Number.isNaN(at.getTime())) return null;
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  }
  const s = String(at).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Completed years between a date of birth and a reference date, or null when
 * either cannot be read or the result is not a plausible human age.
 *
 * `at` omitted means today. Pass a referral date for a report.
 */
export function ageAsOf(dob: unknown, at?: ReferenceDate): number | null {
  const born = canonicalDobIso(dob);
  const ref = referenceIso(at);
  if (!born || !ref) return null;

  const [by, bm, bd] = born.split("-").map(Number);
  const [ry, rm, rd] = ref.split("-").map(Number);

  let age = ry - by;
  // Not yet had this year's birthday. Equality means the birthday IS today, and
  // the year counts — a child turning 14 on their referral date is 14 on it.
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;

  if (age < 0 || age > 130) return null;
  return age;
}

/**
 * The band an age falls in. Boundaries are inclusive on both sides:
 * 13 is a Minor, 14 is an Adolescent, 17 is an Adolescent, 18 is 18+.
 */
export function bandForAge(age: number | null): AgeBand {
  if (age === null) return AGE_BAND_UNKNOWN;
  if (age <= MINOR_MAX_AGE) return AGE_BAND_MINOR;
  if (age <= ADOLESCENT_MAX_AGE) return AGE_BAND_ADOLESCENT;
  return AGE_BAND_ADULT;
}

/** The band for a date of birth as at a reference date. `at` omitted means today. */
export function ageBandAsOf(dob: unknown, at?: ReferenceDate): AgeBand {
  return bandForAge(ageAsOf(dob, at));
}

/**
 * The service-type value a surface should show, with "My Child" banded.
 *
 * Every other service type is returned UNCHANGED and untouched — Myself,
 * My Partner & Myself, My Family and Other are not age-banded, and a value
 * this function does not recognise passes through so a legacy string still
 * lands where it always did.
 *
 * Matching is deliberately tolerant of the two stray spellings already in the
 * data ("My-Child", and case variants), because they are the same category and
 * cleaning them up is a separate job.
 */
export function bandedServiceType(
  serviceType: string | null | undefined,
  dob: unknown,
  at?: ReferenceDate,
): string {
  const raw = (serviceType ?? "").trim();
  if (!isChildServiceType(raw)) return raw;
  const band = ageBandAsOf(dob, at);
  // A child record with no readable date of birth stays under its stored value
  // rather than becoming "Age unknown" — the row is still a child referral, and
  // inventing a fourth band for it would break the totals it belongs to.
  return band === AGE_BAND_UNKNOWN ? raw : band;
}

/** Is this stored service type the one that gets banded? */
export function isChildServiceType(serviceType: string | null | undefined): boolean {
  return (serviceType ?? "").trim().toLowerCase().replace(/[-_\s]+/g, " ") === "my child";
}

/**
 * The one-line note each surface carries so its basis is visible.
 *
 * A report and the waitlist can legitimately disagree about a child who has
 * just had a birthday. Unlabelled that reads as a bug, and someone reports it.
 */
export const AGE_BASIS_NOTE = {
  referral: "Minor / Adolescent are worked out from each child's age on the date they were referred, so these numbers do not change when this is re-run.",
  today: "Minor / Adolescent are worked out from each child's age today.",
} as const;
