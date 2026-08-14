/**
 * Modality regression tests — run with `npm run test:modality`.
 *
 * Two halves:
 *   1. Behavior of the shared normalizer + priority accessors.
 *   2. OWNERSHIP guards: source-level assertions that the sync write paths
 *      cannot silently start clobbering modality again.
 *
 * The ownership half is deliberately source-level rather than DB-backed. The
 * bug it guards against is a one-line edit in a SQL string (swapping COALESCE
 * back to EXCLUDED, or re-adding modality to the enrich fieldMap). A source
 * assertion catches exactly that, needs no database, and runs in CI.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  normalizeModality,
  normalizeModalityTokens,
  getModalityPriorities,
  getPrimaryModality,
  matchesPrimaryModality,
  isRetiredModality,
  RETIRED_MODALITY_OPTIONS,
  joinModalityPriorities,
  MODALITIES,
  MODALITY_OPTIONS,
  MODALITY_SHORT_LABELS,
} from "../shared/modality-utils";
import { PAPERWORK_STATUSES, isValidPaperworkStatus } from "../shared/paperwork-status";

let fails = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`); fails++; }
}
function ok(label: string, cond: boolean) {
  if (!cond) { console.error(`FAIL ${label}`); fails++; }
}

// ============================================================================
// 1. Normalizer — the comma-joined multi-select bug
// ============================================================================

eq("single ABQ", normalizeModality("In Person - Albuquerque"), "In Person ABQ");
eq("single TH abbrev", normalizeModality("TH"), "Telehealth");
eq("multi -> in-person primary", normalizeModality("In Person - Albuquerque, Telehealth"), "In Person ABQ");
eq("TH first still yields in-person primary",
   normalizeModality("Telehealth, In Person - Albuquerque"), "In Person ABQ");
eq("ampersand separator", normalizeModality("In Person - Albuquerque & In person- Rio Rancho"), "In Person ABQ");
eq("tokens preserve chosen order",
   normalizeModalityTokens("Telehealth, In Person - Albuquerque"), ["Telehealth", "In Person ABQ"]);
eq("tokens dedupe", normalizeModalityTokens("Telehealth, TH, Telehealth"), ["Telehealth"]);
eq("fax resolves to nothing", normalizeModalityTokens("Fax Referral (For staff use only)"), []);
eq("fax normalizes to Unknown", normalizeModality("Fax Referral (For staff use only)"), "Unknown");

// production formatting variants added alongside the token split
eq("variant In Person - LL", normalizeModality("In Person - LL"), "In Person LL");
eq("variant In-person Rio Rancho", normalizeModality("In-person Rio Rancho"), "In Person RR");
eq("variant In - Person ABQ", normalizeModality("In - Person ABQ"), "In Person ABQ");
eq("variant missing-comma LL/TH", normalizeModality("In Person - Los Lunas Telehealth"), "In Person LL");
eq("variant (Open toTelehealth)", normalizeModality("(Open toTelehealth)"), "Telehealth");

// canonical lists
// MODALITIES is the ACCEPTANCE list and must stay wide — the intake endpoint
// validates against it and the public RFS form still sends the legacy values.
eq("MODALITIES still accepts all 8", MODALITIES.length, 8);
ok("MODALITIES still accepts Flex", (MODALITIES as readonly string[]).includes("Flex"));
ok("MODALITIES still accepts Hybrid", (MODALITIES as readonly string[]).includes("Hybrid"));
ok("MODALITIES still accepts generic In Person", (MODALITIES as readonly string[]).includes("In Person"));

// MODALITY_OPTIONS is the OFFER list: canonical minus Unknown minus retired.
eq("MODALITY_OPTIONS is 4 (Telehealth + 3 locations)", MODALITY_OPTIONS.length, 4);
for (const retired of ["Flex", "Hybrid", "In Person"]) {
  ok(`${retired} is NOT selectable`, !(MODALITY_OPTIONS as readonly string[]).includes(retired));
  ok(`${retired} is flagged retired`, isRetiredModality(retired));
}
// The location-specific in-person options must survive the generic retirement.
for (const keep of ["In Person ABQ", "In Person RR", "In Person LL", "Telehealth"]) {
  ok(`${keep} is still selectable`, (MODALITY_OPTIONS as readonly string[]).includes(keep));
  ok(`${keep} is not flagged retired`, !isRetiredModality(keep));
}
eq("RETIRED list is exactly the three requested", [...RETIRED_MODALITY_OPTIONS].sort(),
   ["Flex", "Hybrid", "In Person"]);
ok("no Virtual option", !(MODALITY_OPTIONS as readonly string[]).includes("Virtual"));
ok("no Either option", !(MODALITY_OPTIONS as readonly string[]).includes("Either"));
ok("no Fax Referral option", !MODALITY_OPTIONS.some((m) => /fax/i.test(m)));
for (const m of MODALITY_OPTIONS) eq(`round-trip ${m}`, normalizeModality(m), m);
for (const m of MODALITIES) ok(`short label for ${m}`, !!MODALITY_SHORT_LABELS[m]);

// ============================================================================
// 2. Priority accessors + the dual semantics
// ============================================================================

const prioritized = {
  modalityP1: "In Person RR", modalityP2: "In Person ABQ",
  modalityP3: "Telehealth", modalityP4: null,
  modality: "In Person - Albuquerque, In Person - Rio Rancho, Telehealth",
};
eq("priorities read in order", getModalityPriorities(prioritized),
   ["In Person RR", "In Person ABQ", "Telehealth"]);
eq("primary = p1, NOT the raw string's first token", getPrimaryModality(prioritized), "In Person RR");
// FILTERING IS P1-ONLY. This contact holds RR at p1 and ABQ at p2: an RR filter
// returns them, an ABQ filter does not, even though the row displays both.
ok("filter hits p1", matchesPrimaryModality(prioritized, "In Person RR"));
ok("filter MISSES p2", !matchesPrimaryModality(prioritized, "In Person ABQ"));
ok("filter MISSES p3", !matchesPrimaryModality(prioritized, "Telehealth"));
ok("filter misses unselected", !matchesPrimaryModality(prioritized, "In Person LL"));
// ...while display still shows the whole set.
eq("display still shows all priorities", getModalityPriorities(prioritized).length, 3);

// Fallback: rows the backfill left alone must behave exactly as before.
const legacy = { modalityP1: null, modalityP2: null, modalityP3: null, modalityP4: null,
                 modality: "In Person - Los Lunas, Telehealth" };
eq("fallback priorities from raw string", getModalityPriorities(legacy), ["In Person LL", "Telehealth"]);
eq("fallback primary", getPrimaryModality(legacy), "In Person LL");
ok("fallback filter hits the primary bucket", matchesPrimaryModality(legacy, "In Person LL"));
ok("fallback filter misses a lower priority", !matchesPrimaryModality(legacy, "Telehealth"));

const unresolvable = { modalityP1: null, modality: "Fax Referral (For staff use only)" };
eq("unresolvable primary is Unknown", getPrimaryModality(unresolvable), "Unknown");
ok("unresolvable matches only Unknown", matchesPrimaryModality(unresolvable, "Unknown"));
ok("unresolvable does not match a real bucket", !matchesPrimaryModality(unresolvable, "Telehealth"));

// The counting invariant: primary is always exactly one bucket, so per-contact
// report/Insights counts sum to the contact count.
for (const c of [prioritized, legacy, unresolvable, { modality: null }]) {
  const p = getPrimaryModality(c);
  ok(`primary is a single canonical bucket (${p})`, (MODALITIES as readonly string[]).includes(p));
}

eq("join matches legacy raw format",
   joinModalityPriorities(["In Person RR", "Telehealth", null, ""]), "In Person RR, Telehealth");
eq("join of nothing is null", joinModalityPriorities([null, "", undefined]), null);

// ============================================================================
// 3. OWNERSHIP GUARDS — modality must stay CRM-owned
// ============================================================================

// ESM: resolve from the repo root via process.cwd() (npm scripts run there)
// rather than __dirname, which doesn't exist in module scope.
const dbSrc = readFileSync(join(process.cwd(), "server", "sync", "db.ts"), "utf8");

// Both n8n upserts must COALESCE (Sheet fills only when the CRM has none).
const coalesceCount = (dbSrc.match(
  /modality = COALESCE\(sync_contacts\.modality, EXCLUDED\.modality\)/g
) ?? []).length;
eq("all three sync upserts COALESCE modality", coalesceCount, 3);

// ...and none may assign it outright.
ok("no upsert sets modality = EXCLUDED.modality",
   !/\bmodality = EXCLUDED\.modality/.test(dbSrc));

// The enrich fieldMap re-fetches from n8n; modality must not be in it. This was
// the live clobber path — opening a stale contact overwrote staff edits.
const fieldMapBlock = dbSrc.slice(
  dbSrc.indexOf("const fieldMap: Array<[string, unknown]> = ["),
  dbSrc.indexOf("for (const [col, val] of fieldMap)")
);
ok("enrich fieldMap block located", fieldMapBlock.length > 0);
ok("enrich fieldMap does NOT write modality", !/\["modality",/.test(fieldMapBlock));

// CRM-OWNED COLUMNS must never appear in a sync upsert's column list. An
// unenumerated column cannot be written or nulled by a sync — that is the whole
// protection, and it only holds as long as nobody adds the column to one of the
// three upserts. This is the guard added after the July incident where a sync
// clobbered a CRM-owned column.
const CRM_OWNED_COLUMNS = [
  "modality_p1", "modality_p2", "modality_p3", "modality_p4",
  "paperwork_status",
];
for (const col of CRM_OWNED_COLUMNS) {
  ok(`${col} is not written by an ON CONFLICT DO UPDATE`,
     !new RegExp(`${col}\\s*=\\s*EXCLUDED`).test(dbSrc));
  ok(`${col} is not assigned in enrichSyncContact's fieldMap`,
     !new RegExp(`\\["${col}",`).test(fieldMapBlock));
}

// Paperwork Status is NOT a status code: it must stay out of the status-code
// machinery entirely. If it ever needs to drive the pipeline, that is a
// different feature with a different review.
ok("paperwork_status is not wired into status-code handling",
   !/paperwork/i.test(readFileSync(join(process.cwd(), "shared", "status-codes.ts"), "utf8")));

if (fails === 0) console.log("PASS — modality: normalizer, priorities, and ownership guards OK");
else { console.error(`\n${fails} FAILURES`); process.exit(1); }


// ============================================================================
// 4. Paperwork Status — a plain CRM-owned field, NOT a status code
// ============================================================================

ok("Sent is valid", isValidPaperworkStatus("Sent"));
ok("Received is valid", isValidPaperworkStatus("Received"));
ok("null is valid (clears the field)", isValidPaperworkStatus(null));
ok("empty string is valid (clears the field)", isValidPaperworkStatus(""));
ok("undefined is valid", isValidPaperworkStatus(undefined));
ok("an arbitrary string is rejected", !isValidPaperworkStatus("Partially Received"));
ok("a status-code-shaped value is rejected", !isValidPaperworkStatus("202"));
ok("wrong case is rejected", !isValidPaperworkStatus("sent"));
eq("currently two options", PAPERWORK_STATUSES.length, 2);
// Adding an option must be a one-line change to the shared constant — this
// asserts the UI/API read the list rather than hardcoding values.
eq("options are the data-driven list", [...PAPERWORK_STATUSES], ["Sent", "Received"]);

if (fails === 0) console.log("PASS — paperwork status: validation + data-driven options OK");
else { console.error(`\n${fails} FAILURES`); process.exit(1); }
