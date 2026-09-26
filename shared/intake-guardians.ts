/**
 * Guardians on a Request for Services submission.
 * ============================================================================
 *
 * The form sends `guardians: [{ firstName, lastName, phone, email,
 * relationship }]` (2026-09-25). They are the adults responsible for a child
 * client — NOT the people in therapy, which is what `participants` holds — so
 * they are kept apart from participants everywhere, including the intake PDF
 * the TherapyNotes agent files.
 *
 * STORED AS SENT, READ THROUGH HERE. The intake route already writes the whole
 * body to form_submissions.payload, so guardians need no column. Every surface
 * reads them through this one function, which keeps only the five fields and
 * never throws on a malformed entry.
 *
 * LENIENT BY DESIGN. The form enforces its own rules (two guardians under joint
 * custody); the CRM stores what arrives. An absent, empty or malformed
 * `guardians` reads as an empty list, never an error.
 *
 * IMPORTS: none. Read by the server and by the CRM client.
 */

export interface IntakeGuardian {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  relationship: string;
}

/** Most guardians shown for one submission. A cap on rendering, not a rule. */
export const MAX_GUARDIANS = 6;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The guardians on a raw intake payload, cleaned. Empty when there are none. */
export function guardiansFromPayload(payload: unknown): IntakeGuardian[] {
  const raw = (payload as { guardians?: unknown } | null | undefined)?.guardians;
  if (!Array.isArray(raw)) return [];
  const out: IntakeGuardian[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const r = g as Record<string, unknown>;
    const guardian: IntakeGuardian = {
      firstName: str(r.firstName),
      lastName: str(r.lastName),
      phone: str(r.phone),
      email: str(r.email),
      relationship: str(r.relationship),
    };
    // An entry with nothing in it is a blank form row, not a guardian.
    if (Object.values(guardian).every((v) => v === "")) continue;
    out.push(guardian);
    if (out.length === MAX_GUARDIANS) break;
  }
  return out;
}

/** "First Last", or whichever part exists. */
export function guardianName(g: IntakeGuardian): string {
  return [g.firstName, g.lastName].filter(Boolean).join(" ");
}
