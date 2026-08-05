/**
 * Modality priority backfill — classification + dry-run artifact
 * ============================================================================
 *
 * Assigns modality_p1..p4 for existing contacts from the legacy free-text
 * `modality` column. Splits into two separately-invoked halves on purpose:
 *
 *   1. DRY RUN  — reads, classifies, writes a reviewable CSV. Touches nothing.
 *   2. WRITE    — consumes an APPROVED CSV byte-for-byte and UPDATEs only
 *                 modality_p1..p4. It does NOT reclassify: whatever was
 *                 reviewed is exactly what gets written.
 *
 * That separation is the whole point. The reviewer approves a concrete artifact,
 * not a description of an algorithm, and the CSV doubles as the rollback source
 * (every p-column was NULL before this ran, so rollback = NULL the written set).
 *
 * PHI: the CSV carries contactId, the raw modality string, and a coarse zip
 * BUCKET (ABQ/RR/LL/...). Never names, never addresses, never raw zips.
 *
 * USAGE
 *   Dry run from a DB:        tsx scripts/backfill-modality-priorities.ts --dry-run --out out.csv
 *   Dry run from a snapshot:  tsx scripts/backfill-modality-priorities.ts --dry-run --from-json rows.json --out out.csv
 *   Write an approved CSV:    tsx scripts/backfill-modality-priorities.ts --write --csv approved.csv
 *
 * --from-json takes [{contact_id, modality, zip_code, status_code}, ...] and
 * exists so the dry run can be produced from a read-only snapshot pulled off
 * prod without this machine holding a production DB credential. The
 * classification code path is identical either way.
 */

import { readFileSync, writeFileSync } from "fs";
import {
  normalizeModalityTokens,
  isInPersonModality,
} from "../shared/modality-utils";

// ============================================================================
// Office / zip table  (locked decision: 5-digit zip lookup, no Maps API)
// ============================================================================
//
// A Maps API was rejected deliberately: it needs a new vendor key AND Google
// Maps Platform carries no HIPAA BAA, so geocoding patient addresses would be a
// PHI disclosure. Offices are ~20 minutes apart and the client expects to edit
// some rows, so a coarse lookup is the right precision.
//
// NOTE: ABQ and Rio Rancho SHARE the 871 prefix, so a 3-digit heuristic cannot
// separate them — these must be full 5-digit codes.

const RR_ZIPS = new Set([
  "87124", "87144", "87174", // Rio Rancho
  "87048",                   // Corrales
  "87004",                   // Bernalillo
  "87043",                   // Placitas
]);

const LL_ZIPS = new Set([
  "87031",  // Los Lunas
  "87002",  // Belen
  "87068",  // Bosque Farms
  "87042",  // Peralta
  "87060",  // Tomé
]);

export type ZipBucket = "ABQ" | "RR" | "LL" | "other_NM" | "out_of_state" | "no_zip";

export function zipBucket(zip: string | null | undefined): ZipBucket {
  if (!zip) return "no_zip";
  const t = String(zip).trim().slice(0, 5);
  if (!/^\d{5}$/.test(t)) return "no_zip";
  if (RR_ZIPS.has(t)) return "RR";
  if (LL_ZIPS.has(t)) return "LL";
  if (/^87[01]/.test(t)) return "ABQ";   // 870xx/871xx metro, minus the sets above
  if (/^87/.test(t)) return "other_NM";
  return "out_of_state";
}

/**
 * Office preference order from each zip bucket, nearest first.
 * Rio Rancho and Albuquerque are adjacent; Los Lunas sits south of Albuquerque,
 * so RR<->LL is the longest hop from either end.
 */
const OFFICE_PREFERENCE: Record<string, string[]> = {
  ABQ: ["In Person ABQ", "In Person RR", "In Person LL"],
  RR: ["In Person RR", "In Person ABQ", "In Person LL"],
  LL: ["In Person LL", "In Person ABQ", "In Person RR"],
};

const SPECIFIC_OFFICES = new Set(["In Person ABQ", "In Person RR", "In Person LL"]);

// ============================================================================
// Classification
// ============================================================================

export type Confidence = "high" | "medium" | "manual";

export interface ClassifiedRow {
  contactId: number;
  oldModalityRaw: string;
  parsedTokens: string[];
  p1: string | null;
  p2: string | null;
  p3: string | null;
  p4: string | null;
  ruleApplied: string;
  confidence: Confidence;
  zipBucket: ZipBucket;
}

export interface SourceRow {
  contact_id: number;
  modality: string | null;
  zip_code: string | null;
  status_code: number | null;
}

/**
 * Locked classification rules. Anything not confidently derivable is left for a
 * human — an unassigned row is recoverable, a silently wrong priority is not.
 */
export function classifyContact(row: SourceRow): ClassifiedRow {
  const raw = row.modality == null ? "" : String(row.modality);
  const tokens = normalizeModalityTokens(raw);
  const bucket = zipBucket(row.zip_code);

  const base = {
    contactId: row.contact_id,
    oldModalityRaw: raw,
    parsedTokens: tokens,
    zipBucket: bucket,
  };
  const manual = (rule: string): ClassifiedRow => ({
    ...base, p1: null, p2: null, p3: null, p4: null,
    ruleApplied: rule, confidence: "manual",
  });
  const assign = (order: string[], rule: string, confidence: Confidence): ClassifiedRow => ({
    ...base,
    p1: order[0] ?? null, p2: order[1] ?? null, p3: order[2] ?? null, p4: order[3] ?? null,
    ruleApplied: rule, confidence,
  });

  // Flex — Lane reassigns these by hand (locked exclusion).
  if (tokens.includes("Flex")) return manual("flex_manual");

  // Nothing resolved. Fax Referral is an intake CHANNEL, not a modality, so
  // there is no correct target to map it to.
  if (tokens.length === 0) {
    return manual(/fax/i.test(raw) ? "fax_referral_manual" : "unmapped_manual");
  }

  const offices = tokens.filter((t) => SPECIFIC_OFFICES.has(t));
  const inPerson = tokens.filter(isInPersonModality);
  const hasTele = tokens.includes("Telehealth");
  const genericInPerson = tokens.includes("In Person");

  // Single selection — the modality IS the priority.
  if (tokens.length === 1) return assign(tokens, "single", "high");

  // Exactly one in-person + Telehealth: the office is the scarce resource and
  // wins P1; Telehealth is the fallback.
  if (inPerson.length === 1 && hasTele && tokens.length === 2) {
    return assign([inPerson[0], "Telehealth"], "auto_inperson_plus_th", "high");
  }

  // Multiple specific offices (± Telehealth): rank by distance from the
  // contact's zip. A generic "In Person" mixed in cannot be ranked, so those
  // go to a human instead of being guessed at.
  if (offices.length > 1) {
    if (genericInPerson) return manual("mixed_generic_and_specific_manual");
    const pref = OFFICE_PREFERENCE[bucket];
    if (!pref) return manual("distance_no_usable_zip_manual");
    const ordered = [...offices].sort((a, b) => pref.indexOf(a) - pref.indexOf(b));
    if (hasTele) ordered.push("Telehealth");
    return assign(ordered, "distance_zip", "medium");
  }

  // Everything else (Hybrid combined with others, generic + Telehealth
  // variants that aren't the clean two-token case, etc.).
  if (inPerson.length === 1 && hasTele) {
    return assign([inPerson[0], "Telehealth"], "auto_inperson_plus_th", "high");
  }
  return manual("mixed_other_manual");
}

// ============================================================================
// CSV
// ============================================================================

const CSV_COLUMNS = [
  "contactId", "oldModalityRaw", "parsedTokens",
  "p1", "p2", "p3", "p4",
  "ruleApplied", "confidence", "zipBucket",
] as const;

function esc(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows: ClassifiedRow[]): string {
  const head = CSV_COLUMNS.join(",");
  const body = rows.map((r) =>
    [
      r.contactId, r.oldModalityRaw, r.parsedTokens.join(" | "),
      r.p1, r.p2, r.p3, r.p4,
      r.ruleApplied, r.confidence, r.zipBucket,
    ].map(esc).join(",")
  );
  return head + "\r\n" + body.join("\r\n") + "\r\n";
}

/** Minimal RFC4180-ish parser — enough for the CSV this script emits. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { cur.push(field); field = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
    else field += c;
  }
  if (field !== "" || cur.length) { cur.push(field); rows.push(cur); }
  const [head, ...rest] = rows.filter((r) => r.length > 1 || (r[0] ?? "") !== "");
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// ============================================================================
// Reporting
// ============================================================================

export function summarize(rows: ClassifiedRow[]): string {
  const byRule = new Map<string, { n: number; conf: Confidence }>();
  for (const r of rows) {
    const e = byRule.get(r.ruleApplied) ?? { n: 0, conf: r.confidence };
    e.n++; byRule.set(r.ruleApplied, e);
  }
  const lines = [
    `Total contacts:        ${rows.length}`,
    `Will be assigned:      ${rows.filter((r) => r.p1).length}`,
    `Left for manual:       ${rows.filter((r) => !r.p1).length}`,
    ``,
    `${"rule".padEnd(38)}${"conf".padEnd(8)}count`,
    "-".repeat(54),
  ];
  for (const [rule, e] of [...byRule.entries()].sort((a, b) => b[1].n - a[1].n)) {
    lines.push(`${rule.padEnd(38)}${e.conf.padEnd(8)}${e.n}`);
  }
  const byConf = (c: Confidence) => rows.filter((r) => r.confidence === c).length;
  lines.push("-".repeat(54));
  lines.push(`high=${byConf("high")}  medium=${byConf("medium")}  manual=${byConf("manual")}`);
  return lines.join("\n");
}

// ============================================================================
// CLI
// ============================================================================

async function loadFromDb(): Promise<SourceRow[]> {
  const { getPool } = await import("../server/db/pool");
  const res = await getPool().query(
    `SELECT contact_id, modality, zip_code, status_code
       FROM sync_contacts ORDER BY contact_id`
  );
  return res.rows as SourceRow[];
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const val = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

  if (flag("--dry-run")) {
    const fromJson = val("--from-json");
    const src: SourceRow[] = fromJson
      ? JSON.parse(readFileSync(fromJson, "utf8"))
      : await loadFromDb();
    const classified = src.map(classifyContact);
    const out = val("--out") ?? "modality-backfill-dryrun.csv";
    writeFileSync(out, toCsv(classified));
    console.log(summarize(classified));
    console.log(`\nCSV written: ${out}`);
    process.exit(0);
  }

  if (flag("--write")) {
    const csvPath = val("--csv");
    if (!csvPath) { console.error("--write requires --csv <approved.csv>"); process.exit(1); }
    const rows = parseCsv(readFileSync(csvPath, "utf8"));
    // Only rows the reviewer approved AND that carry an assignment.
    const toWrite = rows.filter((r) => (r.p1 ?? "").trim() !== "");
    console.log(`Parsed ${rows.length} CSV rows; ${toWrite.length} carry a p1 assignment.`);

    const { getPool } = await import("../server/db/pool");
    const client = await getPool().connect();
    let updated = 0;
    try {
      await client.query("BEGIN");
      for (const r of toWrite) {
        const res = await client.query(
          // ONLY the p-columns. `modality` is never written by the backfill.
          `UPDATE sync_contacts
              SET modality_p1 = $2,
                  modality_p2 = $3,
                  modality_p3 = $4,
                  modality_p4 = $5
            WHERE contact_id = $1`,
          [
            Number(r.contactId),
            r.p1 || null, r.p2 || null, r.p3 || null, r.p4 || null,
          ]
        );
        updated += res.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("ROLLBACK —", (e as Error).message);
      process.exit(1);
    } finally {
      client.release();
    }
    console.log(`Committed. Rows updated: ${updated}`);
    process.exit(0);
  }

  console.error("Specify --dry-run or --write. See the header comment for usage.");
  process.exit(1);
}

// Only run the CLI when invoked directly, so the pure functions above stay
// importable by tests.
if (process.argv[1] && /backfill-modality-priorities/.test(process.argv[1])) {
  void main();
}
