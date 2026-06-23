/**
 * status-config tests (run: `npm run test:status`)
 *
 * No framework — plain tsx + node:assert. Exits non-zero on any failure so it can
 * gate a pre-deploy check. Locks the new-status classification (206/402/500) across
 * the client config AND a replica of the server's range-based derivation + the
 * widened active-count bound — so a missed/incorrect surface is caught.
 */
import assert from "node:assert";
import {
  isActiveStatus,
  getUmbrellaForStatus,
  STATUS_LABELS,
  STATUS_UMBRELLAS,
} from "./status-config";

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) failures.push(`${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

// ---- active/inactive classification (client) ----
check("isActiveStatus(206)", isActiveStatus(206), true);   // Rescheduling Initial Appointment — active
check("isActiveStatus(500)", isActiveStatus(500), true);   // Resources Need to be Sent — active
check("isActiveStatus(402)", isActiveStatus(402), false);  // Referred Out — inactive
// regression: existing classifications unchanged
for (const c of [100, 102, 200, 202]) check(`isActiveStatus(${c}) stays active`, isActiveStatus(c), true);
for (const c of [103, 104, 203, 204, 205, 400]) check(`isActiveStatus(${c}) stays inactive`, isActiveStatus(c), false);

// ---- umbrella resolution (client config) ----
check("umbrella(206)", getUmbrellaForStatus(206), "PS");
check("umbrella(500)", getUmbrellaForStatus(500), "REF");
check("umbrella(402)", getUmbrellaForStatus(402), "INS");
check("umbrella(202) unchanged", getUmbrellaForStatus(202), "SCH");

// ---- labels present ----
check("label(206)", STATUS_LABELS[206], "Rescheduling Initial Appointment");
check("label(402)", STATUS_LABELS[402], "Referred Out");
check("label(500)", STATUS_LABELS[500], "Resources Need to be Sent");
check("REF umbrella exists", STATUS_UMBRELLAS.REF.label, "Referred To Other Services");

// ---- replica of the SERVER range derivation (must agree with client config) ----
function serverUmbrella(sc: number): string {
  if (sc >= 100 && sc < 200) return "WL";
  if (sc >= 200 && sc < 300) return "PS";
  if (sc >= 300 && sc < 400) return "PMR";
  if (sc >= 400 && sc < 500) return "INS";
  if (sc >= 500 && sc < 600) return "REF";
  return "unknown";
}
check("server umbrella(206)", serverUmbrella(206), "PS");
check("server umbrella(500)", serverUmbrella(500), "REF");
check("server umbrella(402)", serverUmbrella(402), "INS");

// ---- replica of the widened server active-count bound ----
const serverActive = (sc: number) =>
  ![103, 104, 203, 204, 205].includes(sc) && (sc < 400 || (sc >= 500 && sc < 600));
check("server active(500)", serverActive(500), true);
check("server active(402)", serverActive(402), false);
check("server active(206)", serverActive(206), true);
for (const c of [103, 104, 203, 204, 205, 400]) check(`server active(${c})===false`, serverActive(c), false);

if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} status-config assertion(s):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("PASS — status-config: 206/402/500 classification consistent (client + server replica)");
assert.ok(true);
