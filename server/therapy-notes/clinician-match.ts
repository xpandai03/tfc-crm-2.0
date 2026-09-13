/**
 * A TherapyNotes clinician option label → a CRM provider.
 * ============================================================================
 *
 * The reverse of server/providers/tn-clinician-name.ts, and built ON it rather
 * than beside it. That file owns the one fact that matters here — that the CRM
 * displays "Tyra Jones" where TherapyNotes renders "Ty Jones" — and a second
 * copy of that knowledge is precisely what broke scheduling for a morning.
 *
 * So: every provider's TN-FACING name comes from toTherapyNotesClinicianName(),
 * and the comparison uses nameTokens() from the same module. Nothing about
 * naming is decided here.
 *
 * THE COMPARISON IS THE AGENT'S OWN RULE. The agent accepts a clinician when
 * the name it sent is a token SUBSET of a rendered option
 * (tn_executor_v2.py::_select_clinician). The same rule run backwards is what
 * this does: a provider matches a label when the provider's TN-facing tokens are
 * a subset of the label's. That handles "Jones, Ty, LMHC" carrying a credential
 * the provider's name does not, and correctly REFUSES {tyra, jones}, which is
 * the failure the correction map exists to prevent.
 *
 * A WRONG MATCH IS WORSE THAN NO MATCH. This number becomes the denominator of
 * a percentage the practice reads as fact, so an ambiguous label resolves to
 * nobody rather than to a guess, and is recorded as ambiguous so it is visible.
 */

import {
  nameTokens,
  toTherapyNotesClinicianName,
} from "../providers/tn-clinician-name";

export type MatchStatus = "matched" | "unmatched" | "ambiguous" | "aggregate";

export interface MatchableProvider {
  id: number;
  name: string;
}

export interface ClinicianMatch {
  status: MatchStatus;
  providerId: number | null;
  /** Every provider that matched, so an ambiguity can be reported by name. */
  candidates: MatchableProvider[];
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  let ok = true;
  a.forEach((t) => { if (!b.has(t)) ok = false; });
  return ok && a.size > 0;
}

/**
 * Resolve one option label against the roster.
 *
 * `isAggregate` short-circuits: the "Any Clinician" option is a practice-wide
 * total, not a person. Matching it would attach the whole practice's count to
 * whichever provider's tokens happened to fit, so it never reaches the matcher.
 */
export function matchClinicianLabel(
  label: string,
  isAggregate: boolean,
  providers: MatchableProvider[],
): ClinicianMatch {
  if (isAggregate) return { status: "aggregate", providerId: null, candidates: [] };

  const labelTokens = nameTokens(label ?? "");
  if (labelTokens.size === 0) return { status: "unmatched", providerId: null, candidates: [] };

  const candidates = providers.filter((p) =>
    isSubset(nameTokens(toTherapyNotesClinicianName(p.name)), labelTokens),
  );

  if (candidates.length === 1) {
    return { status: "matched", providerId: candidates[0].id, candidates };
  }
  if (candidates.length > 1) {
    return { status: "ambiguous", providerId: null, candidates };
  }
  return { status: "unmatched", providerId: null, candidates: [] };
}
