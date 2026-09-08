/**
 * Self-checks — TherapyNotes-facing clinician name.
 *
 * Run: npx tsx scripts/test-tn-clinician-name.ts
 *
 * Verifies (no TherapyNotes access needed, no PHI in this file):
 *   1. the V2 payload carries the TN form for the affected provider
 *   2. a provider with no explicit TN name is byte-identical
 *   3. the CRM display name is unchanged (the correction map still produces it)
 *   4. a reorder-only correction gets NO TN-specific value (matcher is
 *      order-independent), and the agent's subset rule accepts both forms
 */
import {
  PROVIDER_NAME_CORRECTIONS,
  TN_CLINICIAN_NAMES,
  toTherapyNotesClinicianName,
} from "../server/providers/tn-clinician-name";
import { validateAgentPayload } from "../server/routes";
import type { TnV2AgentPayload } from "../server/therapy-notes";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** The agent's matcher, transcribed from tn_executor_v2.py (NOT imported/relaxed). */
const agentTokens = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
const agentMatches = (sent: string, rendered: string) =>
  [...agentTokens(sent)].every((t) => agentTokens(rendered).has(t));

/** Build the V2 payload exactly as /api/therapy-notes/create-with-schedule does. */
function buildPayload(providerFromModal: string): TnV2AgentPayload {
  return {
    first_name: "Test", last_name: "Patient", dob: "01/02/1990",
    address: "1 Example St", zip: "87101", sex: "Female",
    email: "example@example.invalid", phone: "5055550100", rfs_url: "",
    intake_pdf_url: "https://example.invalid/intake.pdf",
    snapshot_pdf_url: "https://example.invalid/snapshot.pdf",
    appointment_date: "9/15/2026", appointment_time: "2:00 pm",
    appointment_alert_text: "Example alert", appointment_modality: "In Person",
    clinician_name: toTherapyNotesClinicianName(providerFromModal),
    contact_id: 1, run_id: "test-run", callback_url: "https://example.invalid/cb",
  };
}

// ---------------------------------------------------------------------------
console.log("\n[1] Affected provider — payload carries the TherapyNotes form");
// TN renders 'Last, First, Credential'. This is the option that was on screen
// when the two runs failed today (from the agent's own failure message shape).
const TN_RENDERS_JONES = "Jones, Ty, LMHC";
for (const fromModal of ["Tyra Jones", "Tyra Jones, LMHC", "  tyra jones  "]) {
  const p = buildPayload(fromModal);
  check(`"${fromModal}" -> clinician_name is "Ty Jones"`, p.clinician_name === "Ty Jones", p.clinician_name);
  check(`"${fromModal}" would match ${JSON.stringify(TN_RENDERS_JONES)}`, agentMatches(p.clinician_name, TN_RENDERS_JONES));
  check(`the OLD value "${fromModal}" would NOT have matched (regression guard)`,
    !agentMatches(fromModal, TN_RENDERS_JONES));
}
check("payload still passes the agent-schema pre-validation",
  validateAgentPayload(buildPayload("Tyra Jones")).length === 0);

// ---------------------------------------------------------------------------
console.log("\n[2] Providers with no explicit TN name — byte-identical passthrough");
const untouched = [
  "Anna Aldridge", "Amanda Davison, LMFT", "Debra Dederich-Elsner",
  "Laura Garcia-Rosecrans, LMHC", "Angelica Villicana, LCSW (spanish)",
  "Renee Singletary, LMSW (Bilingual-Spanish)", "Ginger Rippey", "Ivory Kahler",
  "Abena Marfowaa Owusu-Nkwantabisah", "Amanda Plotner", "Danya Estrada",
  "", "   ",
];
for (const n of untouched) {
  check(`"${n}" unchanged`, buildPayload(n).clinician_name === n, buildPayload(n).clinician_name);
}
check("exactly one provider has a TN-specific name today",
  Object.keys(TN_CLINICIAN_NAMES).length === 1, JSON.stringify(TN_CLINICIAN_NAMES));

// ---------------------------------------------------------------------------
console.log("\n[3] Display name unchanged — the correction map still produces it");
check('sheet "Ty Jones" still displays as "Tyra Jones"',
  PROVIDER_NAME_CORRECTIONS["Ty Jones"] === "Tyra Jones");
check('sheet "Neuhart Jessica" still displays as "Jessica Neuhart"',
  PROVIDER_NAME_CORRECTIONS["Neuhart Jessica"] === "Jessica Neuhart");
check("the correction map has exactly the two entries it had before",
  Object.keys(PROVIDER_NAME_CORRECTIONS).length === 2);

// ---------------------------------------------------------------------------
console.log("\n[4] Reorder-only correction needs no TN-specific value");
check('"Jessica Neuhart" is sent unchanged',
  toTherapyNotesClinicianName("Jessica Neuhart") === "Jessica Neuhart");
check('"Jessica Neuhart" already matches TN\'s "Neuhart, Jessica, Intern"',
  agentMatches("Jessica Neuhart", "Neuhart, Jessica, Intern"));

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
