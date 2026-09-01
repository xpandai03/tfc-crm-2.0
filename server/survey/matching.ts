/**
 * Survey → contact identity matching.
 * ============================================================================
 *
 * THE GOVERNING RULE: WHEN IN DOUBT, DO NOT MATCH.
 *
 * A survey attributed to the wrong person becomes a document filed to the wrong
 * patient's chart, which is a PHI disclosure. An unmatched row costs a staff
 * member ten seconds. Every rule below resolves in that direction: ambiguity is
 * routed to a human, never broken by a tiebreak, a precedence order, or a
 * "closest" score. There is deliberately NO fuzzy tier — no name-only match, no
 * near-miss date of birth, no edit-distance fallback. Those are exactly the
 * paths that produce a confident wrong answer.
 *
 * This module is PURE: it takes the submission's typed identity and a snapshot
 * of contact identities, and returns an outcome. No database, no I/O, no
 * logging — so every rule is directly testable and nothing here can leak a name
 * into a log line.
 *
 * WHY NOT normalizeProviderName()
 * -------------------------------
 * server/providers/normalize-name.ts is the repo's existing normaliser, and
 * this reuses its rules — trim, lowercase, collapse internal whitespace — but
 * not its first step, which takes the text before the first comma to strip a
 * ", Credential" suffix from a provider name. On a patient name entered as
 * "Last, First" that step would discard the given name entirely, which for an
 * identity decision is the opposite of what is wanted. As of 2026-09-01 zero of
 * 1,243 contacts contain a comma, so the split would be a no-op today; it is
 * omitted because it is a trap waiting for the first record that does.
 *
 * Two things are added on top, both required by the data:
 *   - diacritic folding, because a client types "Siobhán" on a phone and the
 *     contact record may hold "Siobhan"
 *   - order-independent token comparison, so "First Last" and "Last First"
 *     agree while "First M Last" deliberately does NOT agree with "First Last"
 *     (an extra token is a real difference, and the review queue exists for it)
 */

/** What the matcher needs to know about one contact. Nothing more is read. */
export interface ContactIdentity {
  contactId: number;
  name: string;
  email: string | null;
  patientDob: string | null;
}

/** The identity a client typed into the survey. */
export interface SubmittedIdentity {
  name: string;
  dateOfBirth: string;
  email?: string | null;
}

export type MatchReason =
  /** Name + date of birth agree, and the supplied email belongs to that contact. */
  | "name_dob_email"
  /** Name + date of birth agree; no email supplied, or it belongs to nobody. */
  | "name_dob"
  /** The typed date of birth is not a date we can read. */
  | "unparseable_dob"
  /** Nothing agreed on both name and date of birth. */
  | "no_candidates"
  /** More than one contact agreed on both. Ambiguity, not a tie to break. */
  | "multiple_candidates"
  /** The supplied email belongs to a different contact than name + dob chose. */
  | "email_contradiction";

export interface MatchOutcome {
  status: "matched" | "review";
  reason: MatchReason;
  /** Set only when status is "matched". */
  contactId: number | null;
  /**
   * Contacts worth showing a human, most relevant first. On a match this is the
   * single matched contact; on review it is whatever partial evidence exists,
   * which may be empty.
   */
  candidateIds: number[];
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Reduce a date of birth to YYYY-MM-DD, or null when it cannot be read.
 *
 * Contact dates of birth are stored as free TEXT and are NOT uniform: as of
 * 2026-09-01, 1,229 are YYYY-MM-DD, 11 are M/D/YYYY, 1 is M-D-YYYY and 1 is
 * unreadable. A string comparison would silently fail to match the 13 contacts
 * in the minority formats, so both sides are canonicalised before comparing.
 *
 * Deliberately strict: a two-digit year is rejected rather than guessed at,
 * because guessing the century on a date of birth is exactly the kind of
 * inference that produces a confident wrong match.
 */
export function canonicalDob(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // ISO date, optionally with a time component.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);

  // M/D/YYYY or M-D-YYYY, with or without leading zeros.
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (us) return validDate(+us[3], +us[1], +us[2]);

  return null;
}

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Reduce a person's name to a comparable key: diacritics folded, lowercased,
 * punctuation dropped, tokens sorted so word order does not matter.
 *
 *   "Rosalind Ashgrove"            -> "ashgrove rosalind"
 *   "ASHGROVE,  Rosalind"          -> "ashgrove rosalind"   (same person)
 *   "Siobhán O'Callaghan"          -> "ocallaghan siobhan"
 *   "Rosalind M Ashgrove"          -> "ashgrove m rosalind" (NOT the same key —
 *                                     an extra token is a real difference)
 */
export function nameKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw)
    // NFD splits "á" into "a" + a combining accent; the range below is the
    // combining-diacritical-marks block, written as escapes rather than literal
    // characters so it survives any re-encoding of this file.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Apostrophes are INTRA-word and are deleted, so "O'Callaghan" and
    // "OCallaghan" are the same token \u2014 the same person spelled two ways, and
    // 43 contacts carry an apostrophe or hyphen. Every other separator SPLITS,
    // so "Ashgrove-Pemberton" stays two tokens and therefore does NOT equal
    // "Ashgrove": a married or hyphenated surname is a real difference and
    // belongs in the review queue, not in an automatic match.
    .replace(/['\u2018\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** Lowercased, trimmed email, or null. Matches the lower(email) key the
 *  provider unification settled on (docs/provider-unification-plan.md §4). */
export function emailKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  return s || null;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Decide whether a submitted identity resolves to exactly one contact.
 *
 * The bar for an automatic match, all of which must hold:
 *   1. the typed date of birth is readable
 *   2. it equals the contact's date of birth exactly, after canonicalisation
 *   3. the name keys are equal after normalisation
 *   4. EXACTLY ONE contact satisfies 2 and 3
 *   5. the supplied email, if any, does not belong to some other contact
 *
 * Anything else returns "review".
 */
export function matchSubmission(
  submitted: SubmittedIdentity,
  contacts: ContactIdentity[],
): MatchOutcome {
  const dob = canonicalDob(submitted.dateOfBirth);
  if (!dob) {
    // Nothing can be trusted without a readable date of birth, and a name-only
    // search is the fuzzy tier this design refuses to have.
    return { status: "review", reason: "unparseable_dob", contactId: null, candidateIds: [] };
  }

  const key = nameKey(submitted.name);
  if (!key) {
    return { status: "review", reason: "no_candidates", contactId: null, candidateIds: [] };
  }

  const dobMatches: ContactIdentity[] = [];
  const nameMatches: ContactIdentity[] = [];
  const both: ContactIdentity[] = [];

  for (const c of contacts) {
    const cDob = canonicalDob(c.patientDob);
    const cName = nameKey(c.name);
    const dobOk = cDob !== null && cDob === dob;
    const nameOk = cName !== "" && cName === key;
    if (dobOk && nameOk) both.push(c);
    else if (dobOk) dobMatches.push(c);
    else if (nameOk) nameMatches.push(c);
  }

  // Candidates offered to a human when we decline to decide. Name agreement is
  // listed first because a shared date of birth alone is weak evidence.
  const partialCandidates = [...nameMatches, ...dobMatches].slice(0, 10).map((c) => c.contactId);

  if (both.length === 0) {
    return { status: "review", reason: "no_candidates", contactId: null, candidateIds: partialCandidates };
  }

  if (both.length > 1) {
    // 126 contacts share BOTH a name and a date of birth with another contact
    // (2026-09-01) — largely duplicate records. Picking one would be a coin
    // flip on a clinical identity.
    return {
      status: "review",
      reason: "multiple_candidates",
      contactId: null,
      candidateIds: both.map((c) => c.contactId),
    };
  }

  const candidate = both[0];
  const submittedEmail = emailKey(submitted.email);

  if (submittedEmail) {
    // Who owns this address? 290 contacts share an address with at least one
    // other (127 household groups, up to 5 contacts each), so an address maps
    // to a SET of contacts, not one. Corroboration therefore means "the
    // candidate is among the owners", and contradiction means "the address is
    // known and the candidate is not among them".
    const owners = contacts.filter((c) => emailKey(c.email) === submittedEmail);

    if (owners.length > 0) {
      const corroborates = owners.some((o) => o.contactId === candidate.contactId);
      if (!corroborates) {
        // Name + dob point one way, the email points at someone else. Resolving
        // that by precedence would be picking which evidence to ignore.
        return {
          status: "review",
          reason: "email_contradiction",
          contactId: null,
          candidateIds: [candidate.contactId, ...owners.map((o) => o.contactId)],
        };
      }
      return {
        status: "matched",
        reason: "name_dob_email",
        contactId: candidate.contactId,
        candidateIds: [candidate.contactId],
      };
    }
    // The address belongs to nobody on record — unknown, not contradictory.
    // Name + dob already met the bar, so this does not block the match.
  }

  return {
    status: "matched",
    reason: "name_dob",
    contactId: candidate.contactId,
    candidateIds: [candidate.contactId],
  };
}

/** Human-readable explanation for the review queue. Contains no identity. */
export const REASON_LABEL: Record<MatchReason, string> = {
  name_dob_email: "Matched on name, date of birth and email",
  name_dob: "Matched on name and date of birth",
  unparseable_dob: "The date of birth could not be read",
  no_candidates: "No contact matched on both name and date of birth",
  multiple_candidates: "More than one contact matched — ambiguous",
  email_contradiction: "The email belongs to a different contact",
};
