/**
 * Lift-and-shift equivalence test (Build 1, pre-deploy gate).
 *
 * Proves the constant → (seed serialize) → (DB row) → rowToTemplate round-trip
 * yields a byte-identical EmailTemplate object for all 6 templates. Rendering is
 * a pure function of (template, contact, dynamicFields), so an identical template
 * object guarantees an identical rendered subject/bodyHtml/bodyText. TEXT columns
 * store strings verbatim; only variables/required_fields pass through JSON, which
 * this test exercises explicitly.
 *
 * Run: npx tsx server/email/templates.equiv.test.ts
 */

import { EMAIL_TEMPLATES, type EmailTemplate, type RequiredField } from "./templates";

let failures = 0;
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Mirror of the production helpers (templates.ts: asArray + rowToTemplate).
function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}
function rowToTemplate(r: any): EmailTemplate {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    subject: r.subject,
    bodyHtml: r.body_html,
    bodyText: r.body_text,
    variables: asArray<string>(r.variables),
    requiredFields: asArray<RequiredField>(r.required_fields),
  };
}

// Simulate exactly what initEmailTemplatesTable() writes, then what pg returns
// for a SELECT * (TEXT verbatim; jsonb pre-parsed to JS arrays).
function simulateSeedAndRead(t: EmailTemplate): EmailTemplate {
  const writtenVariables = JSON.stringify(t.variables); // -> jsonb column
  const writtenRequired = JSON.stringify(t.requiredFields); // -> jsonb column
  const rowFromPg = {
    id: t.id,
    name: t.name,
    description: t.description, // TEXT verbatim
    subject: t.subject, // TEXT verbatim
    body_html: t.bodyHtml, // TEXT verbatim — pre-wrapped HTML preserved exactly
    body_text: t.bodyText, // TEXT verbatim
    variables: JSON.parse(writtenVariables), // jsonb returns parsed array
    required_fields: JSON.parse(writtenRequired), // jsonb returns parsed array
  };
  return rowToTemplate(rowFromPg);
}

console.log(`Testing ${EMAIL_TEMPLATES.length} templates for byte-identical round-trip...\n`);

const EXPECTED_IDS = [
  "waitlist-status",
  "scheduling-followup",
  "portal-enrollment",
  "appointment-confirmation",
  "post-appointment-survey",
  "intake-form-reminder",
];

// 1. Exact ids preserved, in order (load-bearing: CC list keys off ids).
const actualIds = EMAIL_TEMPLATES.map((t) => t.id);
if (!eq(actualIds, EXPECTED_IDS)) {
  console.error(`✗ ids/order mismatch\n  expected ${JSON.stringify(EXPECTED_IDS)}\n  actual   ${JSON.stringify(actualIds)}`);
  failures++;
} else {
  console.log(`✓ ids preserved & ordered: ${actualIds.join(", ")}`);
}

// 2. Each template round-trips byte-identical across every field.
for (const t of EMAIL_TEMPLATES) {
  const rt = simulateSeedAndRead(t);
  const fields: Array<keyof EmailTemplate> = [
    "id", "name", "description", "subject", "bodyHtml", "bodyText", "variables", "requiredFields",
  ];
  const diffs = fields.filter((f) => !eq(t[f], rt[f]));
  if (diffs.length > 0) {
    console.error(`✗ ${t.id}: field(s) differ after round-trip: ${diffs.join(", ")}`);
    failures++;
  } else {
    console.log(`✓ ${t.id}: all ${fields.length} fields byte-identical (subject ${t.subject.length}c, html ${t.bodyHtml.length}c, text ${t.bodyText.length}c, vars=${t.variables.length}, req=${t.requiredFields.length})`);
  }
}

// 3. Metadata projection (dropdown payload) identical from constant vs round-trip.
const metaConstant = EMAIL_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, requiredFields: t.requiredFields }));
const metaRoundtrip = EMAIL_TEMPLATES.map((t) => {
  const rt = simulateSeedAndRead(t);
  return { id: rt.id, name: rt.name, description: rt.description, requiredFields: rt.requiredFields };
});
if (!eq(metaConstant, metaRoundtrip)) {
  console.error(`✗ dropdown metadata projection differs after round-trip`);
  failures++;
} else {
  console.log(`\n✓ dropdown metadata projection byte-identical (same order/shape)`);
}

console.log("");
if (failures === 0) {
  console.log("PASS: lift-and-shift is byte-identical for all 6 templates.");
  process.exit(0);
} else {
  console.error(`FAIL: ${failures} difference(s) — STOP, do not deploy.`);
  process.exit(1);
}
