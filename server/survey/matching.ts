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
 *
 * PREFERRED NAMES ARE NOT CONSIDERED, ANYWHERE. The form asks for the legal
 * name and says so on the label, and this compares that against the name on the
 * record. There is no nickname table, no given-name expansion, no "Bob for
 * Robert". A transgender or non-binary client may go by a name that is not on
 * their insurance, and inferring one from the other in either direction is a
 * guess about a person's identity that this module is not entitled to make.
 *
 * ADDED 2026-09-03 (client review), TWO CRITERIA:
 *
 *   PHONE — a corroborator, exactly like email, with the same household rule.
 *   315 contacts share a phone number across 139 groups, so a number maps to a
 *   SET of contacts. Corroboration means "a candidate is among the owners";
 *   contradiction means "the number is on record and no candidate owns it".
 *   Phone does NOT narrow a candidate set — see the provider note below.
 *
 *   PROVIDER — the tiebreaker, and ONLY the tiebreaker. TherapyNotes records a
 *   couple under one account, so a partner seen individually and the same
 *   couple seen together carry the same legal name, date of birth, phone,
 *   email and address; the only thing that separates the two records is which
 *   provider each sits under. The survey already asks which therapist the
 *   client saw, so that answer is the discriminator.
 *
 *   PROVIDER CANNOT RESCUE A NEAR-MISS. It is consulted at exactly one point —
 *   after a candidate set of two or more has already satisfied name, date of
 *   birth and both contradiction gates — and it can only choose among that set.
 *   There is no path from a name mismatch, a date-of-birth mismatch or a
 *   contradiction to the provider step; those return before it. Adding
 *   criteria makes a match more certain, never more permissive, so neither new
 *   field can turn a review into a match by itself.
 */

import { normalizeProviderName } from "../providers/normalize-name";
import {
  REASON_LABEL,
  type MatchReason,
} from "@shared/survey-match-reasons";

export type { MatchReason };
export { REASON_LABEL };

/** What the matcher needs to know about one contact. Nothing more is read. */
export interface ContactIdentity {
  contactId: number;
  name: string;
  email: string | null;
  phone: string | null;
  patientDob: string | null;
  /**
   * The provider on this contact's most recent assignment, or null. 595 of
   * 1,272 contacts have one, which is fine: it is only ever read to separate
   * candidates that are otherwise identical.
   */
  assignedProvider?: string | null;
}

/** The identity a client typed into the survey. */
export interface SubmittedIdentity {
  name: string;
  dateOfBirth: string;
  phone?: string | null;
  email?: string | null;
  /** The therapist answer, as the roster rendered it: "Name (LOCATION)". */
  provider?: string | null;
}

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

/**
 * Reduce a phone number to comparable digits, or null when there is nothing
 * usable to compare.
 *
 * DIGITS, NOT FORMATTING. The form accepts "(505) 555-0142", "505.555.0142",
 * "+1 505 555 0142" and "5055550142" as the same number, and contact records
 * hold whichever shape was typed at intake. Comparing the strings would fail on
 * punctuation alone.
 *
 * The LAST TEN digits are the key. Of 1,271 contacts with a phone, 1,264 hold
 * ten digits and 4 hold eleven — a US number with the country code — and those
 * two forms are the same number. Taking the last ten makes them agree without
 * needing to know which country a number is from.
 *
 * Fewer than ten digits returns null rather than a short key: 3 contacts hold
 * an unusable fragment (3 and 9 digits, and one 20-digit run), and letting a
 * fragment participate would make it "match" every number ending the same way.
 * Null means "no phone evidence", which costs nothing — phone only ever
 * corroborates.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/**
 * Reduce a provider name to a comparable key.
 *
 * REUSES normalizeProviderName() — the repo's existing provider normaliser,
 * which already drops a ", Credential" suffix, trims, lowercases and collapses
 * whitespace. One thing is stripped first: the survey stores the therapist as
 * the roster rendered it, "Name (LOCATION)", while an assignment stores the
 * bare name, so the trailing parenthetical has to come off before the two can
 * agree. That is the only difference, and it is applied here rather than by
 * forking the normaliser.
 *
 *   "Tyra Jones (ABQ)"  -> "tyra jones"     (survey side)
 *   "Tyra Jones"        -> "tyra jones"     (assignment side)
 *   "Tyra Jones, LMHC"  -> "tyra jones"     (assignment with a credential)
 *
 * Deliberately exact after normalisation, with no fuzzy fallback. Two of the 30
 * distinct assignment values are malformed — a bare first name and a
 * misspelling — and neither will key-match a roster label. That is the right
 * outcome: an unrecognised provider simply fails to break a tie, and the
 * submission goes to a human. A provider name is never evidence FOR a match on
 * its own, so failing to read one can only ever be conservative.
 */
export function providerKey(raw: string | null | undefined): string {
  if (!raw) return "";
  const withoutLocation = String(raw).replace(/\s*\([^)]*\)\s*/g, " ");
  return normalizeProviderName(withoutLocation);
}

/**
 * Contacts that own a given contact-detail value.
 *
 * A phone number or an email address maps to a SET of contacts, not one: 315
 * contacts share a phone across 139 groups, and 290 share an email across 127.
 * A family uses one number and one address, so "this value belongs to someone
 * else" is only true when it belongs to nobody among the candidates.
 */
function ownersOf<T>(
  contacts: ContactIdentity[],
  key: T,
  keyOf: (c: ContactIdentity) => T | null,
): ContactIdentity[] {
  return contacts.filter((c) => keyOf(c) === key);
}

/**
 * Corroborate-or-contradict, shared by phone and email.
 *
 * Three outcomes, and note what is NOT here: this never NARROWS the candidate
 * set. Narrowing two candidates to one on a phone number would be using a
 * corroborator as a tiebreaker, and the client was specific that the tiebreaker
 * is the provider. So a corroborator can only leave the set alone or stop the
 * match — it can never promote one.
 *
 *   "unknown"      the value is on nobody's record; no evidence either way
 *   "corroborates" at least one candidate owns it
 *   "contradicts"  it is on record, and no candidate owns it
 */
function corroboration(
  candidates: ContactIdentity[],
  contacts: ContactIdentity[],
  submittedKey: string | null,
  keyOf: (c: ContactIdentity) => string | null,
): { verdict: "unknown" | "corroborates" | "contradicts"; owners: ContactIdentity[] } {
  if (!submittedKey) return { verdict: "unknown", owners: [] };
  const owners = ownersOf(contacts, submittedKey, keyOf);
  if (owners.length === 0) return { verdict: "unknown", owners: [] };
  const ids = new Set(owners.map((o) => o.contactId));
  const corroborates = candidates.some((c) => ids.has(c.contactId));
  return { verdict: corroborates ? "corroborates" : "contradicts", owners };
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Decide whether a submitted identity resolves to exactly one contact.
 *
 * THE BAR, all of which must hold:
 *   1. the typed date of birth is readable
 *   2. the normalised legal name equals a contact's, and that contact's date of
 *      birth equals the typed one exactly, after canonicalisation
 *   3. the typed phone, if it is on record at all, belongs to at least one of
 *      those contacts
 *   4. the typed email, if it is on record at all, belongs to at least one of
 *      those contacts
 *   5. EXACTLY ONE contact survives — or, where several do, exactly one of them
 *      is assigned to the therapist the survey named
 *
 * Anything else returns "review", with a reason naming the criterion that
 * decided it.
 *
 * The order matters and is not arbitrary. Every gate that can REFUSE runs
 * before the only step that can CHOOSE, so the provider step is unreachable
 * except from a set that has already cleared name, date of birth and both
 * contradiction checks.
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
    return { status: "review", reason: "no_name", contactId: null, candidateIds: [] };
  }

  // --- 1. Candidates: name AND date of birth, both exact after normalisation.
  const dobOnly: ContactIdentity[] = [];
  const nameOnly: ContactIdentity[] = [];
  const candidates: ContactIdentity[] = [];

  for (const c of contacts) {
    const cDob = canonicalDob(c.patientDob);
    const cName = nameKey(c.name);
    const dobOk = cDob !== null && cDob === dob;
    const nameOk = cName !== "" && cName === key;
    if (dobOk && nameOk) candidates.push(c);
    else if (dobOk) dobOnly.push(c);
    else if (nameOk) nameOnly.push(c);
  }

  // Candidates offered to a human when we decline to decide. Name agreement is
  // listed first because a shared date of birth alone is weak evidence.
  const partialCandidates = [...nameOnly, ...dobOnly].slice(0, 10).map((c) => c.contactId);

  if (candidates.length === 0) {
    // Say WHICH criterion failed, which is what the client asked for. "The name
    // is on record but not with this date of birth" and "no contact carries
    // this name" send a staff member to two different places, and a single
    // "no candidates" told them neither.
    const reason: MatchReason = nameOnly.length > 0 ? "dob_mismatch" : "no_candidates";
    return { status: "review", reason, contactId: null, candidateIds: partialCandidates };
  }

  // --- 2. Phone. Corroborates or contradicts; never narrows.
  const phone = corroboration(candidates, contacts, phoneKey(submitted.phone), (c) => phoneKey(c.phone));
  if (phone.verdict === "contradicts") {
    // Name + date of birth point one way, the number points at someone else.
    // Resolving that by precedence would be choosing which evidence to ignore.
    return {
      status: "review",
      reason: "phone_contradiction",
      contactId: null,
      candidateIds: dedupeIds([...candidates, ...phone.owners]),
    };
  }

  // --- 3. Email. Identical treatment.
  const email = corroboration(candidates, contacts, emailKey(submitted.email), (c) => emailKey(c.email));
  if (email.verdict === "contradicts") {
    return {
      status: "review",
      reason: "email_contradiction",
      contactId: null,
      candidateIds: dedupeIds([...candidates, ...email.owners]),
    };
  }

  // --- 4. One survivor, or the provider separates them.
  if (candidates.length === 1) {
    return {
      status: "matched",
      reason: matchedReasonFor(phone.verdict === "corroborates", email.verdict === "corroborates"),
      contactId: candidates[0].contactId,
      candidateIds: [candidates[0].contactId],
    };
  }

  // More than one contact agrees on everything checkable. 126 contacts share
  // both a name and a date of birth with another contact — largely duplicate
  // records — and a couple recorded under one TherapyNotes account shares every
  // field above as well. This is the ONE place a tie is broken, and only the
  // provider breaks it.
  const wanted = providerKey(submitted.provider);
  const allIds = candidates.map((c) => c.contactId);

  if (!wanted) {
    return { status: "review", reason: "multiple_candidates", contactId: null, candidateIds: allIds };
  }

  const withProvider = candidates.filter((c) => {
    const k = providerKey(c.assignedProvider);
    return k !== "" && k === wanted;
  });

  if (withProvider.length === 1) {
    return {
      status: "matched",
      reason: "name_dob_provider",
      contactId: withProvider[0].contactId,
      candidateIds: [withProvider[0].contactId],
    };
  }

  // Named a therapist none of them sees, or one that several of them see.
  // Either way the tie stands, and a tie that stands is a human's to settle.
  return {
    status: "review",
    reason: withProvider.length === 0 ? "provider_no_match" : "provider_ambiguous",
    contactId: null,
    candidateIds: allIds,
  };
}

/** Which corroborators fired, recorded so a match says what it rested on. */
function matchedReasonFor(phone: boolean, email: boolean): MatchReason {
  if (phone && email) return "name_dob_phone_email";
  if (phone) return "name_dob_phone";
  if (email) return "name_dob_email";
  return "name_dob";
}

/** Contact ids, first occurrence wins, capped for a review list. */
function dedupeIds(rows: ContactIdentity[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const r of rows) {
    if (seen.has(r.contactId)) continue;
    seen.add(r.contactId);
    out.push(r.contactId);
    if (out.length >= 10) break;
  }
  return out;
}
