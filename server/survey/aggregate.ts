/**
 * Survey export — the aggregation layer.
 * ============================================================================
 *
 * Turns stored survey submissions into every number and every row the client's
 * export workbook needs. PURE: it takes submissions and a roster, and returns a
 * result. No database, no Excel, no file, no endpoint. The workbook builder
 * that follows is layout over what this returns.
 *
 * WHAT THIS DOES NOT COMPUTE
 * --------------------------
 * The client was explicit that the workbook's own formulas are correct and
 * should be used. So the office rollups, the Total row, and the completion
 * percentage are Excel's job, not this layer's — this produces the per-provider
 * and per-office numbers those formulas operate ON, and stops there. Adding a
 * total here would mean the workbook carried two answers to the same question,
 * one of them stale the moment a cell is edited.
 *
 * Total Active Clients is not here either. It comes from TherapyNotes, nothing
 * pulls it today, and it ships blank — ProviderAggregate.totalActiveClients is
 * a declared `null` so the builder has somewhere to put it, not an invention.
 *
 * OFFICE IS A PROVIDER ATTRIBUTE
 * ------------------------------
 * It comes from crm_providers.location, carried in on the roster. This
 * deliberately does NOT use shared/dashboard-locations.ts, which derives a
 * location from the CLIENT's modality priority — a different concept that
 * answers to the same word, and the wrong one for a report about which office a
 * therapist sits in.
 *
 * THREE OFFICES, NOT FOUR. The live roster carries ABQ, LL and RR. The
 * template shows a Corp row with two providers; both are stored as ABQ, and
 * Corp cannot be entered in the CRM at all. Offices are therefore derived from
 * the roster rather than declared here, so if Corp ever comes back this layer
 * needs no edit.
 *
 * ONE DEFINITION OF THE INSTRUMENT
 * --------------------------------
 * Every question key, prompt and option comes from @shared/survey-questions,
 * which already drives the form, the server's closed schema and the PDF. There
 * is no list of questions in this file and there must never be one: a fourth
 * copy would drift, and the drift would show up as a silently miscounted column
 * in a report the practice acts on.
 *
 * The one thing this file chooses is WHICH questions belong on which sheet, and
 * it expresses that as a slot range rather than a list of keys — see
 * MODALITY_SLOT_MIN/MAX.
 */

import {
  SATISFACTION_OPTIONS,
  YES_NO_NA_OPTIONS,
  fullPromptText,
  questionsFor,
  type ChoiceQuestion,
  type ScaleQuestion,
  type SurveyModality,
  type SurveyQuestion,
  type SurveyVariant,
} from "@shared/survey-questions";

// ============================================================================
// Which questions go where
// ============================================================================

/**
 * Slots 2 through 6 are the modality-specific middle block of the instrument —
 * the five non-rating questions per variant that the "In Person and TH Ratings"
 * and "Neutrals and Below" sheets count, ten in total.
 *
 * A SLOT RANGE RATHER THAN A KEY LIST, on purpose. Listing keys here would be
 * the fourth copy of the instrument this file's header refuses. The slot
 * numbers are structural — they are what makes a question modality-specific —
 * so a reworded question keeps working and a genuinely new question in slot 3
 * is picked up without an edit here.
 *
 * This deliberately excludes slot 11 (followUpRequested), which is a choice
 * question but an action item rather than a rating, and slot 12
 * (additionalComments), which is free text. Neither appears on any sheet of the
 * client's template.
 */
export const MODALITY_SLOT_MIN = 2;
export const MODALITY_SLOT_MAX = 6;

/** The bucket key for telehealth, which has no office split. */
export const TELEHEALTH_BUCKET = "TH";

/**
 * The bucket key for a row whose office could not be determined — an
 * unresolvable therapist label, or a provider whose location is blank. Never
 * silently merged into a real office: a miscounted ABQ is worse than a visible
 * unknown.
 */
export const UNKNOWN_OFFICE = "";

/** Office display order, matching the template. Anything else sorts after. */
const OFFICE_ORDER = ["ABQ", "LL", "RR"];

/** The five modality-specific choice questions for a variant, in slot order. */
export function modalityQuestionsFor(variant: SurveyVariant): ChoiceQuestion[] {
  return questionsFor(variant).filter(
    (q): q is ChoiceQuestion =>
      q.kind === "choice" && q.slot >= MODALITY_SLOT_MIN && q.slot <= MODALITY_SLOT_MAX,
  );
}

/** The four 0–10 rating questions. Identical across variants. */
export function scaleQuestionsFor(variant: SurveyVariant): ScaleQuestion[] {
  return questionsFor(variant).filter((q): q is ScaleQuestion => q.kind === "scale");
}

/** The rating keys, in slot order — connection, goals, approach, overall. */
export const SCALE_KEYS: string[] = scaleQuestionsFor("in-person").map((q) => q.key);

function sameOptions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The responses that put a row on "Neutrals and Below", for one question.
 *
 * Both option sets in the shared definition are ordered best-first, and in both
 * the client's criteria are "everything below the acceptable band", so this
 * slices rather than transcribing strings:
 *
 *   - satisfaction: Excellent and Satisfied are fine; Neutral and below are not
 *   - yes/no/N-A:   Yes is fine; No and N/A are both tracked
 *
 * The client's note on that sheet is explicit that a response belongs in these
 * tables whether or not it carries a comment: "Even if there is no comment as
 * part of the response, we still want the response tracked in these tables if
 * the answer meets the criteria (No, Neutral, N/A , etc)".
 */
export function negativeOptionsFor(q: ChoiceQuestion): string[] {
  if (sameOptions(q.options, SATISFACTION_OPTIONS)) return SATISFACTION_OPTIONS.slice(2);
  if (sameOptions(q.options, YES_NO_NA_OPTIONS)) return YES_NO_NA_OPTIONS.slice(1);
  return [];
}

// ============================================================================
// Input
// ============================================================================

/**
 * The minimum this layer needs off a provider row. A structural subset of
 * CrmProvider rather than an import of it, so the aggregation stays testable
 * without a database type in scope.
 *
 * PASS BOTH ACTIVE AND INACTIVE PROVIDERS. A departed provider's submissions
 * still belong in their office's counts and in the negative listings; they
 * simply get no tab. Their office comes from their own (inactive) row, which is
 * why getInactiveCrmProviders() has to be part of the caller's read.
 */
export interface RosterEntry {
  id: number | null;
  name: string;
  /** crm_providers.short_name, already resolved through providerShortName(). */
  shortName: string;
  /** crm_providers.location. "" when unset. */
  office: string;
  isActive: boolean;
}

/** A stored survey row, narrowed to what this reads. */
export interface SubmissionInput {
  id: number;
  /** ISO timestamp the survey route stamped at write time. */
  submittedAt: string | null;
  /** Fallback when submittedAt is absent. */
  createdAt: string | null;
  payload: Record<string, unknown>;
}

export interface AggregateInput {
  submissions: SubmissionInput[];
  roster: RosterEntry[];
  /** Inclusive ISO calendar dates, YYYY-MM-DD. */
  period: { from: string; to: string };
}

// ============================================================================
// Output
// ============================================================================

export interface ProviderListingRow {
  submissionId: number;
  clientName: string;
  questionKey: string;
  /** Verbatim source wording, via fullPromptText(). */
  questionPrompt: string;
  /** 0–10 for a rating question; null for everything else. */
  score: number | null;
  /** The chosen option for a choice question; null for a rating. */
  answer: string | null;
  comment: string;
  modality: SurveyModality;
}

export interface ProviderAggregate {
  providerId: number | null;
  name: string;
  shortName: string;
  office: string;
  isActive: boolean;
  /** True when this provider exists only in submissions, not on the roster. */
  isUnresolved: boolean;
  surveyCount: number;
  /**
   * Keyed by rating question key. NULL means "no answers to average", which is
   * NOT the same as 0 — zero is a score a client can give. Never coerce.
   */
  averages: Record<string, number | null>;
  /** TherapyNotes. Not built, ships blank. A place, not a value. */
  totalActiveClients: null;
  /** Every response carrying a comment. The builder narrows; see the report. */
  listingRows: ProviderListingRow[];
}

export interface QuestionBreakdown {
  key: string;
  prompt: string;
  modality: SurveyModality;
  /** The question's own options, in the shared definition's order. */
  options: string[];
  /** bucket -> option -> count. Bucket is an office, or TELEHEALTH_BUCKET. */
  byBucket: Record<string, Record<string, number>>;
}

export interface NegativeRow {
  submissionId: number;
  office: string;
  providerName: string;
  providerShortName: string;
  clientName: string;
  response: string;
  /** "" when the client left no comment — the row still belongs. */
  comment: string;
}

export interface NegativeListing {
  key: string;
  prompt: string;
  modality: SurveyModality;
  /** Negative option -> count. */
  counts: Record<string, number>;
  rows: NegativeRow[];
}

export interface UnresolvedLabel {
  /** The raw therapist answer, verbatim. */
  label: string;
  reason: "unknown" | "ambiguous" | "missing";
  count: number;
  submissionIds: number[];
}

export interface AggregateWarning {
  submissionId: number;
  code: "no-variant" | "answer-outside-variant" | "non-numeric-rating";
  detail: string;
}

export interface SurveyAggregate {
  period: { from: string; to: string };
  /** Rows that fell inside the period and carried a usable variant. */
  submissionsInPeriod: number;
  /** Office buckets present, in template order, unknown last. */
  offices: string[];
  /** One per ACTIVE provider, always — including those with nothing. */
  providers: ProviderAggregate[];
  /** Providers named in submissions who are not on the active roster. */
  departed: ProviderAggregate[];
  /** Therapist answers that matched no single provider. Never dropped. */
  unresolved: UnresolvedLabel[];
  ratings: QuestionBreakdown[];
  negatives: NegativeListing[];
  warnings: AggregateWarning[];
}

// ============================================================================
// Resolution
// ============================================================================

/**
 * The provider name out of a stored therapist answer.
 *
 * Submissions store the roster LABEL, which server/survey/roster.ts:44 builds
 * as `${name} (${location})` — no credential, confirmed against production.
 * This strips one trailing parenthetical and keeps the rest.
 *
 * MATCHING ON THE NAME PORTION IS THE POINT. A submission stored while a
 * provider sat in a different office embeds that old office, so the whole label
 * would not string-match today's. The name is the stable half.
 */
export function providerNameFromLabel(label: string | null | undefined): string {
  return (label ?? "").replace(/\s*\([^()]*\)\s*$/, "").trim();
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// ============================================================================
// Aggregation
// ============================================================================

function isoDate(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (v === "") return null;
  return v.slice(0, 10);
}

function emptyAverages(): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  SCALE_KEYS.forEach((k) => { out[k] = null; });
  return out;
}

function variantOf(payload: Record<string, unknown>): SurveyVariant | null {
  const v = payload.formVariant;
  if (v === "in-person" || v === "telehealth") return v;
  // Fall back to the modality string when formVariant is absent or unrecognised.
  const m = payload.modality;
  if (m === "In Person") return "in-person";
  if (m === "Telehealth") return "telehealth";
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function commentFor(comments: Record<string, unknown>, key: string): string {
  const raw = comments[key];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * THE entry point. Pure — the only inputs are the arguments.
 */
export function aggregateSurveys(input: AggregateInput): SurveyAggregate {
  const { from, to } = input.period;

  // ---- roster indexes -------------------------------------------------
  const byName: Record<string, RosterEntry[]> = {};
  input.roster.forEach((p) => {
    const key = normalizeName(p.name);
    (byName[key] = byName[key] ?? []).push(p);
  });

  // Accumulators, keyed by a stable provider key so a departed provider and an
  // unresolved label each get exactly one aggregate.
  const providerAcc: Record<string, ProviderAggregate> = {};
  const ratingSums: Record<string, Record<string, { sum: number; n: number }>> = {};
  const unresolvedAcc: Record<string, UnresolvedLabel> = {};
  const warnings: AggregateWarning[] = [];

  function ensureProvider(key: string, seed: ProviderAggregate): ProviderAggregate {
    if (!providerAcc[key]) {
      providerAcc[key] = seed;
      ratingSums[key] = {};
      SCALE_KEYS.forEach((k) => { ratingSums[key][k] = { sum: 0, n: 0 }; });
    }
    return providerAcc[key];
  }

  // Every ACTIVE provider appears in the output whether or not they have a
  // submission — the client asked for this explicitly, and the template ships
  // 25 of its 26 tabs empty.
  input.roster.filter((p) => p.isActive).forEach((p) => {
    ensureProvider(`id:${p.id}`, {
      providerId: p.id,
      name: p.name,
      shortName: p.shortName,
      office: p.office,
      isActive: true,
      isUnresolved: false,
      surveyCount: 0,
      averages: emptyAverages(),
      totalActiveClients: null,
      listingRows: [],
    });
  });

  // ---- question tables -------------------------------------------------
  const ratings: QuestionBreakdown[] = [];
  const negatives: NegativeListing[] = [];
  const ratingIndex: Record<string, QuestionBreakdown> = {};
  const negativeIndex: Record<string, NegativeListing> = {};

  (["in-person", "telehealth"] as SurveyVariant[]).forEach((variant) => {
    const modality: SurveyModality = variant === "in-person" ? "In Person" : "Telehealth";
    modalityQuestionsFor(variant).forEach((q) => {
      const breakdown: QuestionBreakdown = {
        key: q.key,
        prompt: fullPromptText(q),
        modality,
        options: [...q.options],
        byBucket: {},
      };
      ratings.push(breakdown);
      ratingIndex[`${variant}:${q.key}`] = breakdown;

      const counts: Record<string, number> = {};
      negativeOptionsFor(q).forEach((o) => { counts[o] = 0; });
      const listing: NegativeListing = {
        key: q.key,
        prompt: fullPromptText(q),
        modality,
        counts,
        rows: [],
      };
      negatives.push(listing);
      negativeIndex[`${variant}:${q.key}`] = listing;
    });
  });

  function bump(b: QuestionBreakdown, bucket: string, option: string): void {
    const row = b.byBucket[bucket] ?? (b.byBucket[bucket] = {});
    row[option] = (row[option] ?? 0) + 1;
  }

  // ---- walk the submissions -------------------------------------------
  const officesSeen: Record<string, true> = {};
  let counted = 0;

  input.submissions.forEach((sub) => {
    const date = isoDate(sub.submittedAt) ?? isoDate(sub.createdAt);
    if (date === null || date < from || date > to) return;

    const payload = sub.payload ?? {};
    const variant = variantOf(payload);
    if (variant === null) {
      warnings.push({
        submissionId: sub.id,
        code: "no-variant",
        detail: "neither formVariant nor modality identified a survey variant",
      });
      return;
    }
    counted++;

    const modality: SurveyModality = variant === "in-person" ? "In Person" : "Telehealth";
    const answers = asRecord(payload.answers);
    const comments = asRecord(payload.comments);
    const client = asRecord(payload.client);
    const clientName = typeof client.name === "string" ? client.name : "";

    // -- resolve the provider -------------------------------------------
    const rawLabel = typeof answers.therapist === "string" ? answers.therapist : "";
    const bareName = providerNameFromLabel(rawLabel);
    const matches = bareName === "" ? [] : (byName[normalizeName(bareName)] ?? []);

    let key: string;
    let office: string;
    let providerName: string;
    let shortName: string;

    if (matches.length === 1) {
      const p = matches[0];
      key = `id:${p.id}`;
      office = p.office || UNKNOWN_OFFICE;
      providerName = p.name;
      shortName = p.shortName;
      ensureProvider(key, {
        providerId: p.id,
        name: p.name,
        shortName: p.shortName,
        office,
        isActive: p.isActive,
        isUnresolved: false,
        surveyCount: 0,
        averages: emptyAverages(),
        totalActiveClients: null,
        listingRows: [],
      });
    } else {
      // Unresolvable: no match, an ambiguous name, or an empty answer. The row
      // is NOT dropped — it keeps its office as unknown, still counts on the
      // ratings and negatives sheets, and is reported by label under
      // `unresolved` so a human can see what the workbook could not place.
      const reason: UnresolvedLabel["reason"] =
        bareName === "" ? "missing" : matches.length > 1 ? "ambiguous" : "unknown";
      const u = unresolvedAcc[rawLabel] ?? (unresolvedAcc[rawLabel] = {
        label: rawLabel,
        reason,
        count: 0,
        submissionIds: [],
      });
      u.count++;
      u.submissionIds.push(sub.id);

      key = `unresolved:${normalizeName(rawLabel)}`;
      office = UNKNOWN_OFFICE;
      providerName = bareName || rawLabel;
      shortName = bareName || rawLabel;
      ensureProvider(key, {
        providerId: null,
        name: providerName,
        shortName,
        office,
        isActive: false,
        isUnresolved: true,
        surveyCount: 0,
        averages: emptyAverages(),
        totalActiveClients: null,
        listingRows: [],
      });
    }

    const agg = providerAcc[key];
    agg.surveyCount++;

    // Telehealth is one bucket; in-person splits by the PROVIDER's office.
    const bucket = variant === "telehealth" ? TELEHEALTH_BUCKET : office;
    if (variant === "in-person") officesSeen[office] = true;

    // -- ratings ---------------------------------------------------------
    scaleQuestionsFor(variant).forEach((q) => {
      const raw = answers[q.key];
      if (raw === undefined || raw === null) return;
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!isFinite(n)) {
        warnings.push({
          submissionId: sub.id,
          code: "non-numeric-rating",
          detail: `${q.key} was not a number`,
        });
        return;
      }
      const acc = ratingSums[key][q.key];
      acc.sum += n;
      acc.n++;
    });

    // -- the ten modality questions --------------------------------------
    modalityQuestionsFor(variant).forEach((q) => {
      const raw = answers[q.key];
      if (typeof raw !== "string" || raw === "") return;

      bump(ratingIndex[`${variant}:${q.key}`], bucket, raw);

      if (negativeOptionsFor(q).indexOf(raw) !== -1) {
        const listing = negativeIndex[`${variant}:${q.key}`];
        listing.counts[raw] = (listing.counts[raw] ?? 0) + 1;
        listing.rows.push({
          submissionId: sub.id,
          office,
          providerName,
          providerShortName: shortName,
          clientName,
          response: raw,
          comment: commentFor(comments, q.key),
        });
      }
    });

    // -- provider listing rows -------------------------------------------
    // The SUPERSET: every commented response, not only the four rated ones.
    // Which of these the workbook renders is an open question with the client,
    // and narrowing here would make the answer a change to computation rather
    // than to layout.
    questionsFor(variant).forEach((q: SurveyQuestion) => {
      if (q.kind === "text" || q.kind === "therapist") return;
      const comment = commentFor(comments, q.key);
      if (comment === "") return;
      const raw = answers[q.key];
      const isScale = q.kind === "scale";
      const numeric = typeof raw === "number" ? raw : Number(raw);
      agg.listingRows.push({
        submissionId: sub.id,
        clientName,
        questionKey: q.key,
        questionPrompt: fullPromptText(q),
        score: isScale && isFinite(numeric) ? numeric : null,
        answer: !isScale && typeof raw === "string" ? raw : null,
        comment,
        modality,
      });
    });

    // Answers keyed to the OTHER variant are ignored by the loops above; say so
    // rather than letting them vanish.
    const validKeys = questionsFor(variant).map((q) => q.key);
    Object.keys(answers).forEach((k) => {
      if (validKeys.indexOf(k) === -1) {
        warnings.push({
          submissionId: sub.id,
          code: "answer-outside-variant",
          detail: `${k} is not a ${variant} question`,
        });
      }
    });
  });

  // ---- finalise averages ----------------------------------------------
  Object.keys(providerAcc).forEach((k) => {
    const agg = providerAcc[k];
    SCALE_KEYS.forEach((rk) => {
      const acc = ratingSums[k][rk];
      // n === 0 means nothing to average. NULL, never 0.
      agg.averages[rk] = acc.n === 0 ? null : acc.sum / acc.n;
    });
  });

  const all = Object.keys(providerAcc).map((k) => providerAcc[k]);
  const byNameAsc = (a: ProviderAggregate, b: ProviderAggregate) =>
    a.name.localeCompare(b.name);

  const offices = Object.keys(officesSeen).sort((a, b) => {
    const ia = OFFICE_ORDER.indexOf(a);
    const ib = OFFICE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  return {
    period: { from, to },
    submissionsInPeriod: counted,
    offices,
    providers: all.filter((p) => p.isActive).sort(byNameAsc),
    departed: all.filter((p) => !p.isActive && !p.isUnresolved).sort(byNameAsc),
    unresolved: Object.keys(unresolvedAcc).map((k) => unresolvedAcc[k]),
    ratings,
    negatives,
    warnings,
  };
}
