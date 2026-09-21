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
  /**
   * The CRM contact. NULL for a TherapyNotes-only patient, who has no CRM row
   * — which is the entire population this build exists to make matchable.
   */
  contactId: number | null;
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
  /**
   * The TherapyNotes chart. Set on a TherapyNotes patient, and on a CRM contact
   * that has been linked to one. It is the ONLY thing that links the two
   * populations, and it is what collapseIdentities() collapses on.
   */
  chartId?: string | null;
  /**
   * For a TherapyNotes patient, every clinician they are assigned to. A patient
   * under two clinicians is ONE row with two values, never two rows — the
   * survey names one therapist and it has to be enough that it is one of
   * theirs. Empty for a CRM contact, which uses assignedProvider instead.
   */
  clinicians?: string[];
  /** Where this identity came from. Reported so a match can say which. */
  source?: "crm" | "therapynotes";
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
  /** Set only when status is "matched", and only for a CRM contact. */
  contactId: number | null;
  /**
   * The TherapyNotes chart, when the matched identity has one. This is the
   * point of the build: an attach can then go straight to the right record
   * instead of searching for it.
   */
  chartId: string | null;
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
    // A PARENTHESISED SEGMENT IS NOT PART OF THE NAME. 136 of the 1,011
    // TherapyNotes rows carry one — a preferred or shortened name the chart
    // records alongside the legal one — and it is the most likely reason a
    // results-table name does not equal the chart name. Stripped for BOTH
    // populations, because one person has to key the same in each.
    //
    // THIS IS ONE READING OF A NAME, AND IT IS NOT THE MATCHING RULE. Stripping
    // assumes the parenthetical adds nothing — true of a trailing "(dad)", and
    // WRONG of the shape TherapyNotes actually renders, "Preferred (Legal)
    // Last", where stripping deletes the legal first name and keeps the
    // preferred one. nameKeys() below emits every reading and is what
    // matchSubmission compares. nameKey is unchanged on purpose: many callers
    // depend on "what does this name reduce to", and it still answers that.
    .replace(/\([^)]*\)/g, " ")
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

// ---------------------------------------------------------------------------
// Every reading of a name
// ---------------------------------------------------------------------------

/** The fold nameKey applies, factored out so the two cannot drift. */
function nameTokens(raw: string): string[] {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * EVERY reading of a name, in a stable order, without duplicates.
 *
 * WHY THIS EXISTS. TherapyNotes renders a patient who has a preferred name as
 * "Preferred (Legal) Last", identically in the Patients results table and in
 * the chart header. The practice sets "Minor" as the preferred name on
 * children's records, so a child's row reads "Minor (<Legal>) <Last>" while the
 * survey carries "<Legal> <Last>". nameKey strips the parenthetical and keys
 * that row as "minor <last>", which the survey can never equal. On 21 September
 * a survey that agreed with its chart character for character went to review
 * with "no contact on record carries this name".
 *
 *   "X (Y) Z"          -> ["x z", "y z"]   preferred AND legal, both
 *   "X Y (annotation)" -> ["x y"]          a trailing group annotates only
 *   "X Y"              -> ["x y"]          exactly nameKey()
 *
 * NOTHING HERE DECIDES WHICH TOKEN IS LEGAL, and nothing may be added that
 * does. The results table gives nothing to decide with: "Minor" parses as an
 * ordinary given name and is also a real surname, and the convention that makes
 * it a flag lives in the practice's heads, not in the markup. Emitting both
 * readings costs one extra key and is always right; guessing is sometimes
 * confidently wrong, which is the failure this function exists to end.
 *
 * The first element is always nameKey(raw), so a caller wanting one
 * representative key can take [0] — which is what tn_patients.name_key stores.
 *
 * HOW A READING IS PRODUCED. The string is cut into WORD runs and GROUP runs in
 * source order. The words alone are one reading. Then every non-empty group
 * that has at least one word AFTER it yields a further reading — that group's
 * tokens followed by the words after it — because a group in that position
 * stands in for the run before it. A group with nothing after it is TRAILING,
 * and a trailing group annotates rather than replaces.
 *
 * Ported character for character to shared/name_keys.py in the browser agent,
 * which makes the same comparison against the same rows. scripts/test-name-keys.ts
 * and tests/test_name_keys.py assert the same table of cases in both places.
 */
export function nameKeys(raw: string | null | undefined): string[] {
  const s = String(raw ?? "");
  if (!s.trim()) return [];

  const segments: { kind: "w" | "g"; toks: string[] }[] = [];
  const re = /\(([^)]*)\)/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > pos) segments.push({ kind: "w", toks: nameTokens(s.slice(pos, m.index)) });
    segments.push({ kind: "g", toks: nameTokens(m[1]) });
    pos = m.index + m[0].length;
  }
  if (pos < s.length) segments.push({ kind: "w", toks: nameTokens(s.slice(pos)) });

  const readings: string[][] = [];
  const outside = segments.filter((x) => x.kind === "w").flatMap((x) => x.toks);
  if (outside.length) readings.push(outside);

  segments.forEach((seg, i) => {
    if (seg.kind !== "g" || seg.toks.length === 0) return;
    const after = segments.slice(i + 1).filter((x) => x.kind === "w").flatMap((x) => x.toks);
    if (after.length === 0) return;      // trailing group: an annotation
    readings.push([...seg.toks, ...after]);
  });

  const out: string[] = [];
  for (const r of readings) {
    const k = [...r].sort().join(" ");
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * Two names agree when their reading sets INTERSECT.
 *
 * Deliberately an equality on a reading rather than a subset: a middle name on
 * one side only is a real difference, and "Thistlewood" must not satisfy
 * "Thistlewood-Smith". The bar has not moved — it has stopped being applied to the
 * wrong string.
 */
export function namesAgree(
  a: string | null | undefined, b: string | null | undefined,
): boolean {
  const left = nameKeys(a);
  if (left.length === 0) return false;
  const right = new Set(nameKeys(b));
  return left.some((k) => right.has(k));
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
/**
 * A stable key for one identity, across both populations.
 *
 * NOT contactId. A TherapyNotes-only patient has none, so keying on it made
 * EVERY such patient compare equal to every other — and corroboration() asks
 * "does any candidate own this phone", which then answered yes for a number
 * belonging to a different person entirely. That is the precise failure this
 * design exists to prevent, and it was introduced by widening the population
 * without widening the key.
 */
function identityKey(c: ContactIdentity): string {
  return c.contactId !== null ? `c:${c.contactId}` : `t:${c.chartId ?? ""}`;
}

function corroboration(
  candidates: ContactIdentity[],
  contacts: ContactIdentity[],
  submittedKey: string | null,
  keyOf: (c: ContactIdentity) => string | null,
): { verdict: "unknown" | "corroborates" | "contradicts"; owners: ContactIdentity[] } {
  if (!submittedKey) return { verdict: "unknown", owners: [] };
  const owners = ownersOf(contacts, submittedKey, keyOf);
  if (owners.length === 0) return { verdict: "unknown", owners: [] };
  const ids = new Set(owners.map(identityKey));
  const corroborates = candidates.some((c) => ids.has(identityKey(c)));
  return { verdict: corroborates ? "corroborates" : "contradicts", owners };
}

/**
 * One identity per person, across both populations.
 *
 * THE LINK IS THE CHART ID, AND IT IS THE ONLY LINK. A CRM contact that carries
 * one is the same person as the TherapyNotes patient with that chart; a contact
 * without one cannot be linked and stays separate. There is no name-based
 * merging here — that would be a second, fuzzier matcher hiding inside this one.
 *
 * The CRM row WINS the merge and absorbs the TherapyNotes fields. That order is
 * deliberate: the contact id is what the review queue, the attach flow and every
 * existing consumer key on, so a linked person must keep it. What it gains is
 * the chart id and the clinician list.
 *
 * Without this, a person in both systems would arrive as two identities agreeing
 * on name and date of birth, and the matcher would correctly call that
 * ambiguous — turning a well-known patient into a review item, which is the
 * opposite of the point.
 */
export function collapseIdentities(
  crm: ContactIdentity[],
  tn: ContactIdentity[],
): ContactIdentity[] {
  const byChart = new Map<string, ContactIdentity>();
  crm.forEach((c) => {
    const id = (c.chartId ?? "").trim();
    if (id) byChart.set(id, c);
  });

  const out: ContactIdentity[] = crm.map((c) => ({ ...c, source: "crm" as const }));
  for (const t of tn) {
    const id = (t.chartId ?? "").trim();
    const linked = id ? byChart.get(id) : undefined;
    if (linked) {
      // Same person. Fold the TherapyNotes fields onto the CRM row rather than
      // adding a second candidate. The contact's own name, date of birth and
      // phone are left alone: they are what staff maintain, and the EHR copy is
      // here to make the person FINDABLE, not to overwrite them.
      const merged = out.find((c) => c.contactId === linked.contactId);
      if (merged) {
        merged.chartId = id;
        merged.clinicians = t.clinicians ?? [];
        merged.source = "crm";
      }
      continue;
    }
    out.push({ ...t, source: "therapynotes" as const });
  }
  return out;
}

/**
 * Does the therapist a survey named match this identity?
 *
 * A CRM contact has ONE assigned provider. A TherapyNotes patient has every
 * clinician they are assigned to, and the survey names one of them — so for that
 * population this is membership, not equality. Zero patients are shared-care
 * today; the shape is here because one will be, and discovering that through a
 * wrong match is not the way to find out.
 */
function providerMatches(c: ContactIdentity, wanted: string): boolean {
  if (!wanted) return false;
  if (providerKey(c.assignedProvider) === wanted && providerKey(c.assignedProvider) !== "") {
    return true;
  }
  return (c.clinicians ?? []).some((cl) => {
    const k = providerKey(cl);
    return k !== "" && k === wanted;
  });
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Decide whether a submitted identity resolves to exactly one contact.
 *
 * THE BAR, all of which must hold:
 *   1. the typed date of birth is readable
 *   2. the typed name and a contact's name share at least one READING (see
 *      nameKeys — "Minor (Rowan) Thistlewood" reads as both "minor thistlewood" and
 *      "rowan thistlewood"), and that contact's date of birth equals the typed one
 *      exactly, after canonicalisation
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
    return { status: "review", reason: "unparseable_dob", contactId: null, chartId: null, candidateIds: [] };
  }

  // EVERY READING OF THE TYPED NAME, not one key. A survey carrying a legal
  // name has one reading; a chart rendering "Preferred (Legal) Last" has two.
  // They meet on the legal one.
  const keys = new Set(nameKeys(submitted.name));
  if (keys.size === 0) {
    return { status: "review", reason: "no_name", contactId: null, chartId: null, candidateIds: [] };
  }

  // --- 1. Candidates: name AND date of birth, both exact after normalisation.
  const dobOnly: ContactIdentity[] = [];
  const nameOnly: ContactIdentity[] = [];
  const candidates: ContactIdentity[] = [];

  for (const c of contacts) {
    const cDob = canonicalDob(c.patientDob);
    // BOTH POPULATIONS, ONE RULE. A CRM contact has no preferred-name
    // convention, but a contact record can still carry a parenthetical, and a
    // contact and the TherapyNotes patient who are the same person have to key
    // the same way or they arrive as two candidates instead of one.
    const cKeys = nameKeys(c.name);
    const dobOk = cDob !== null && cDob === dob;
    const nameOk = cKeys.some((k) => keys.has(k));
    if (dobOk && nameOk) candidates.push(c);
    else if (dobOk) dobOnly.push(c);
    else if (nameOk) nameOnly.push(c);
  }

  // Candidates offered to a human when we decline to decide. Name agreement is
  // listed first because a shared date of birth alone is weak evidence.
  // CRM ids only. A TherapyNotes-only identity has none, and the review queue
  // renders contacts — so it is excluded here rather than represented by a
  // placeholder the UI would have to learn about.
  const partialCandidates = dedupeIds([...nameOnly, ...dobOnly]);

  if (candidates.length === 0) {
    // Say WHICH criterion failed, which is what the client asked for. "The name
    // is on record but not with this date of birth" and "no contact carries
    // this name" send a staff member to two different places, and a single
    // "no candidates" told them neither.
    const reason: MatchReason = nameOnly.length > 0 ? "dob_mismatch" : "no_candidates";
    return { status: "review", reason, contactId: null, chartId: null, candidateIds: partialCandidates };
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
      chartId: null,
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
      chartId: null,
      candidateIds: dedupeIds([...candidates, ...email.owners]),
    };
  }

  // --- 4. One survivor, or the provider separates them.
  if (candidates.length === 1) {
    return {
      status: "matched",
      reason: matchedReasonFor(phone.verdict === "corroborates", email.verdict === "corroborates"),
      contactId: candidates[0].contactId,
      chartId: candidates[0].chartId ?? null,
      candidateIds: dedupeIds([candidates[0]]),
    };
  }

  // More than one contact agrees on everything checkable. 126 contacts share
  // both a name and a date of birth with another contact — largely duplicate
  // records — and a couple recorded under one TherapyNotes account shares every
  // field above as well. This is the ONE place a tie is broken, and only the
  // provider breaks it.
  const wanted = providerKey(submitted.provider);
  const allIds = dedupeIds(candidates);

  if (!wanted) {
    return { status: "review", reason: "multiple_candidates", contactId: null, chartId: null, candidateIds: allIds };
  }

  const withProvider = candidates.filter((c) => providerMatches(c, wanted));

  if (withProvider.length === 1) {
    return {
      status: "matched",
      reason: "name_dob_provider",
      contactId: withProvider[0].contactId,
      chartId: withProvider[0].chartId ?? null,
      candidateIds: dedupeIds([withProvider[0]]),
    };
  }

  // Named a therapist none of them sees, or one that several of them see.
  // Either way the tie stands, and a tie that stands is a human's to settle.
  return {
    status: "review",
    reason: withProvider.length === 0 ? "provider_no_match" : "provider_ambiguous",
    contactId: null,
    chartId: null,
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
    // A TherapyNotes-only identity has no contact id. Skipped rather than
    // coerced, so nothing downstream ever sees a 0 or a -1 standing in for one.
    if (r.contactId === null || seen.has(r.contactId)) continue;
    seen.add(r.contactId);
    out.push(r.contactId);
    if (out.length >= 10) break;
  }
  return out;
}
