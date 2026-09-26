/**
 * POST /api/intake, minus the database: validate a body and build the record.
 * ============================================================================
 *
 * EXTRACTED VERBATIM from the route on 2026-09-25 so the decisions an intake
 * makes — what is rejected, what is stored, what the timeline note says — can
 * be replayed against fixtures without a database. The route now calls this
 * and then does the writes; nothing it decides lives anywhere else.
 *
 * Pure apart from console.warn on the staff path, which the route always did.
 * `now` is injected so a replay is reproducible.
 */

import { normalizeReasonForTherapy } from "@shared/reason-canonicals";
import { childDeclaration, storedRequestingFor } from "@shared/age-bands";
import { guardiansFromPayload } from "@shared/intake-guardians";
import {
  MODALITIES,
  normalizeModality,
  normalizeModalityTokens,
  joinModalityPriorities,
} from "@shared/modality-utils";

/** Every column the route writes for an intake, except the generated ids. */
export interface IntakeRecordFields {
  name: string;
  email: string | null;
  phone: string | null;
  lastNote: string;
  intakeSource: "uploaded_referral" | "website_form";
  referralAuth: string | null;
  serviceRequested: string | null;
  requestingFor: string | null;
  reasonForSeeking: string | null;
  reasonForTherapy: string | null;
  detailedReason: string | null;
  formCompletedBy: string | null;
  modality: string | null;
  modalityP1: string | null;
  modalityP2: string | null;
  modalityP3: string | null;
  modalityP4: string | null;
  referralSource: string | null;
  priorServices: string | null;
  priorProvider: string | null;
  preferredContact: string | null;
  custody: string | null;
  flags: string | null;
  priority: string | null;
  insurancePayer: string | null;
  insurancePlan: string | null;
  insuranceId: string | null;
  patientDob: string | null;
  gender: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  county: string | null;
  language: string | null;
}

export type IntakeBuild =
  | { ok: false; status: 400; body: Record<string, unknown> }
  | {
      ok: true;
      isUploadedReferral: boolean;
      /** form_submissions.source for the audit row. */
      submissionSource: "uploaded_referral" | "rfs_v2";
      fields: IntakeRecordFields;
    };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildIntakeRecord(b: any, now: string): IntakeBuild {
  if (!b || !b.name || typeof b.name !== "string" || !b.name.trim()) {
    return { ok: false, status: 400, body: { error: "name is required" } };
  }

  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  // Optional intake source flag — default preserves existing public RFS behavior
  const rawSource = typeof b.source === "string" ? b.source.trim() : "";
  const isUploadedReferral = rawSource === "uploaded_referral";
  const intakeSource = isUploadedReferral ? "uploaded_referral" : "website_form";
  const submissionSource = isUploadedReferral ? "uploaded_referral" : "rfs_v2";

  // Validate + normalize reasonForTherapy against the canonical list.
  // Per locked decision D-A6: staff (uploaded_referral) path normalizes
  // and warns on unknowns; website (RFS / Jotform) path hard-validates
  // and rejects. The website Jotform's MCQ already sends only canonical
  // values, so an unknown there is a real bug.
  const { normalized: reasonForTherapyNormalized, unknown: unknownReasons } =
    normalizeReasonForTherapy(b.reasonForTherapy);
  if (unknownReasons.length > 0) {
    if (isUploadedReferral) {
      console.warn(
        `[intake] Staff submission for "${b.name?.trim?.() ?? "(no name)"}" contained ` +
          `${unknownReasons.length} non-canonical reasonForTherapy values that were dropped: ` +
          JSON.stringify(unknownReasons)
      );
    } else {
      return {
        ok: false,
        status: 400,
        body: {
          error: "validation_error",
          field: "reasonForTherapy",
          message: "non-canonical reasonForTherapy values from website submission",
          unknownValues: unknownReasons,
        },
      };
    }
  }
  const reasonForTherapy = reasonForTherapyNormalized || null;
  const referralAuth = s(b.referralAuth) || s(b.referralNumber);

  // ----------------------------------------------------------------------
  // Modality priorities
  //
  // BOTH SHAPES ARE SUPPORTED INDEFINITELY. The public RFS form is an
  // external Jotform that still posts a single `modality` string; it will
  // start sending modalityP1..P4 only once that form is updated, and older
  // integrations may never be. So:
  //   - new shape (modalityP1..P4) -> stored as given, order preserved
  //   - legacy shape (modality only) -> p1 derived from the normalized
  //     string so the contact still counts in reports on day one
  //
  // Priority order as submitted is AUTHORITATIVE and is never reordered.
  // (The zip-distance rule was a one-time backfill device for historical
  // rows that never stated a preference.)
  //
  // Validation mirrors reasonForTherapy above (locked decision D-A6):
  // website submissions are hard-rejected on a non-canonical value, staff
  // submissions warn and drop, because an unknown value from the website
  // form is a real bug worth surfacing loudly.
  // ----------------------------------------------------------------------
  const rawPriorities = [b.modalityP1, b.modalityP2, b.modalityP3, b.modalityP4]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);

  const badModalities = rawPriorities.filter(
    (v) => !(MODALITIES as readonly string[]).includes(v)
  );
  if (badModalities.length > 0) {
    if (isUploadedReferral) {
      console.warn(
        `[intake] Staff submission contained ${badModalities.length} non-canonical ` +
          `modality values that were dropped: ${JSON.stringify(badModalities)}`
      );
    } else {
      return {
        ok: false,
        status: 400,
        body: {
          error: "validation_error",
          field: "modalityP1..P4",
          message: "non-canonical modality values from website submission",
          unknownValues: badModalities,
          allowedValues: MODALITIES,
        },
      };
    }
  }

  // De-dupe while preserving the submitted order — a repeated selection is
  // a form slip, not a second preference.
  const priorities: string[] = [];
  for (const v of rawPriorities) {
    if ((MODALITIES as readonly string[]).includes(v) && !priorities.includes(v)) {
      priorities.push(v);
    }
  }

  const legacyModality = s(b.modality);
  const usedLegacyShape = priorities.length === 0 && !!legacyModality;
  if (usedLegacyShape) {
    // Legacy shape — and note it is frequently MULTI-valued: the Jotform
    // comma-joins its modality checkboxes, which is how ~130 existing
    // contacts ended up with several. So derive the whole list, not just a
    // single value, or the extra selections are silently lost.
    //
    // p1 is the same bucket the read-time fallback would have produced
    // (in-person first), so a contact counts identically whether or not
    // this derivation ran. The remaining selections follow in submitted
    // order. Unresolvable values (a fax referral) leave the p-columns NULL
    // and fall back at read time, exactly like the rows the backfill
    // skipped.
    const tokens = normalizeModalityTokens(legacyModality!);
    if (tokens.length > 0) {
      const primary = normalizeModality(legacyModality!);
      priorities.push(primary, ...tokens.filter((t) => t !== primary));
    }
  }

  // Keep the legacy string coherent with the priorities, so pre-priority
  // consumers (exports, the Sheet's "Desired Modality") stay correct.
  //
  // A legacy submission keeps its string EXACTLY as sent — rewriting it to
  // canonical bucket names would discard the submitter's own wording for no
  // benefit, since the priorities already carry the structured version.
  const modalityString = usedLegacyShape
    ? legacyModality
    : joinModalityPriorities(priorities) ?? legacyModality ?? null;

  // WHO THE REQUEST IS FOR. "minor_child" / "adolescent" (the form, from
  // 2026-09-25) are the requester's DECLARATION: stored as "My Child", the
  // service type every count bands by date of birth, with the declaration kept
  // in the raw payload and named in the note. Every other value is stored
  // exactly as before — see storedRequestingFor.
  const requestingFor = storedRequestingFor(b.requestingFor);
  const declared = childDeclaration(b.requestingFor);

  // Guardians are stored in the raw payload as sent (see
  // @shared/intake-guardians). Never validated here and never a reason to
  // reject: the form owns the rule, the CRM stores what arrives. The note
  // carries the COUNT only.
  const guardianCount = guardiansFromPayload(b).length;

  // Build readable last_note for timeline display
  const lines: string[] = [`Intake ${now}`];
  if (requestingFor) {
    lines.push(`Requesting For: ${requestingFor}${declared ? ` (declared: ${declared})` : ""}`);
  }
  if (s(b.reasonForSeeking)) lines.push(`Reason: ${s(b.reasonForSeeking)}`);
  if (reasonForTherapy) lines.push(`Therapy Type: ${reasonForTherapy}`);
  if (modalityString) lines.push(`Modality: ${modalityString}`);
  if (s(b.insurancePayer)) lines.push(`Insurance: ${s(b.insurancePayer)}`);
  if (s(b.referralSource)) lines.push(`Referral: ${s(b.referralSource)}`);
  if (referralAuth) lines.push(`Referral #: ${referralAuth}`);
  if (s(b.notes)) lines.push(`Notes: ${s(b.notes)}`);
  if (guardianCount > 0) lines.push(`Guardians: ${guardianCount}`);
  const lastNote = lines.join("\n");

  return {
    ok: true,
    isUploadedReferral,
    submissionSource,
    fields: {
      name: b.name.trim(),
      email: s(b.email),
      phone: s(b.phone),
      lastNote,
      intakeSource,
      referralAuth,

      serviceRequested: s(b.serviceRequested) || reasonForTherapy,
      requestingFor,
      reasonForSeeking: s(b.reasonForSeeking),
      reasonForTherapy,
      detailedReason: s(b.detailedReason),
      formCompletedBy: s(b.formCompletedBy),
      modality: modalityString,
      modalityP1: priorities[0] ?? null,
      modalityP2: priorities[1] ?? null,
      modalityP3: priorities[2] ?? null,
      modalityP4: priorities[3] ?? null,
      referralSource: s(b.referralSource),
      priorServices: s(b.priorServices),
      priorProvider: s(b.priorProvider),
      preferredContact: s(b.preferredContact),
      custody: s(b.custody),
      flags: s(b.flags),
      priority: s(b.priority),

      insurancePayer: s(b.insurancePayer),
      insurancePlan: s(b.insurancePlan),
      insuranceId: s(b.insuranceId),

      patientDob: s(b.patientDob),
      gender: s(b.gender),

      streetAddress: s(b.streetAddress),
      city: s(b.city),
      state: s(b.state),
      zipCode: s(b.zipCode),
      county: s(b.county),

      // Preferred service language (e.g. "English" / "Spanish"). Stored
      // as-is; the RFS form is responsible for sending the display string.
      // Absent today → s(undefined) → null → column stays NULL (inert).
      language: s(b.language),
    },
  };
}
