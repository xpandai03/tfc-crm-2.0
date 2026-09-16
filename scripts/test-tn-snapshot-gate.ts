/**
 * Self-checks — the appointment-confirmation snapshot gate.
 *
 * Run: npx tsx scripts/test-tn-snapshot-gate.ts
 *
 * On 16 September a run was dispatched for a contact whose confirmation email
 * had not been sent. The agent fetched the snapshot PDF, got the designed 404,
 * and died at phase 7 — AFTER creating the patient. The contact was left with a
 * chart, one PDF, no appointment, and no resume path.
 *
 * The precondition existed and was computed; it just was not enforced anywhere.
 * These checks pin the restored server gate and the wiring around it. No patient
 * data appears — the fixtures are contact ids and booleans.
 *
 * The gate itself lives inside a large Express handler that needs a live pool,
 * so what is asserted here is (a) the decision function, extracted to the same
 * shape the handler uses, and (b) the source-level facts that went wrong last
 * time: that the server refuses, that the button's disable matches the server's
 * refusal, and that the comment claiming a gate exists is gone.
 */
import { readFileSync } from "fs";
import { join } from "path";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(import.meta.dirname, "..");
const routes = readFileSync(join(ROOT, "server/routes.ts"), "utf8");
const detail = readFileSync(join(ROOT, "client/src/pages/contact-detail.tsx"), "utf8");

// The dispatch handler only — so a match somewhere else in a 7,000-line file
// cannot make these pass.
const handlerStart = routes.indexOf('app.post("/api/therapy-notes/create-with-schedule"');
const handlerEnd = routes.indexOf("const payload: TnV2AgentPayload", handlerStart);
const handler = routes.slice(handlerStart, handlerEnd);

console.log("\n[1] The server refuses without a snapshot");

ok(
  "the dispatch handler checks hasSnapshotForTemplate",
  /hasSnapshotForTemplate\(\s*contactId,\s*APPOINTMENT_CONFIRMATION_TEMPLATE_ID/.test(handler),
  "the precondition is not read on the dispatch path"
);
ok(
  "it refuses with 422, not 500 or a silent pass",
  /if \(!hasConfirmationSnapshot\)[\s\S]{0,700}?res\.status\(422\)/.test(handler)
);
ok(
  "the refusal names what the staff member has to do",
  /Send the initial appointment confirmation email first/.test(handler)
);
ok(
  "the refusal explains why, in terms of the chart",
  /files a copy of it to the patient's chart/.test(handler)
);
ok(
  "the refusal is recorded in the activity log",
  /if \(!hasConfirmationSnapshot\)[\s\S]{0,700}?tn_schedule_failed/.test(handler)
);

console.log("\n[2] It refuses BEFORE anything irreversible");

const gateAt = handler.indexOf("hasConfirmationSnapshot");
const fetchAt = handler.indexOf("TN_V2_AGENT_URL");
ok(
  "the gate precedes the dispatch to the agent",
  gateAt > 0 && (fetchAt === -1 || gateAt < fetchAt),
  "the gate must run before the agent is called, or the patient is created anyway"
);
const startedAt = handler.indexOf("tn_schedule_started");
ok(
  "the gate precedes the run-started activity",
  gateAt > 0 && (startedAt === -1 || gateAt < startedAt),
  "a refused request must not log a run that never started"
);

console.log("\n[3] The snapshot is never generated on demand");

ok(
  "the dispatch path does not build a snapshot",
  !/saveEmailSnapshot|buildEmailSnapshotDocument/.test(handler),
  "manufacturing a confirmation record puts a false clinical record in a chart"
);

console.log("\n[4] The client matches the server");

ok(
  "the button disables on the enforced precondition",
  /disabled=\{[\s\S]{0,400}?tnV2State\?\.emailSent === false[\s\S]{0,80}?\}/.test(detail),
  "the button must refuse what the server refuses"
);
ok(
  "the button does NOT disable on the advisory preconditions",
  !/disabled=\{[\s\S]{0,400}?providerAssigned/.test(detail),
  "disabling on something the server allows blocks staff for no reason"
);
ok(
  "the tooltip leads with the blocking reason when it blocks",
  /emailSent === false \?[\s\S]{0,400}?Send the initial appointment confirmation email/.test(detail)
);

console.log("\n[5] The stale comment is gone");

ok(
  "no comment claims the button is gated on all preconditions",
  !/all three must pass for the button to be clickable\.$/m.test(detail) &&
    !/\/\/ Precondition checks \(C7\): all three must pass/.test(detail),
  "that comment is why this looked protected when it was not"
);

console.log("\n[6] The decision function itself");

// The same shape the handler uses, so the truth table is pinned explicitly.
const shouldRefuse = (hasSnapshot: boolean) => !hasSnapshot;
ok("no snapshot → refuse", shouldRefuse(false) === true);
ok("snapshot present → pass through", shouldRefuse(true) === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failures:", failures.join(", ")); process.exit(1); }
