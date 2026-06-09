#!/usr/bin/env node
/**
 * Phase 2 provider reconcile — DRY-RUN BY DEFAULT.
 *
 * Builds the canonical crm_providers set (keyed by lower(email)) by joining:
 *   - PROVIDER_LIST           (name, credential, email)  — canonical identity
 *   - spreadsheet roster      (location + skill matrix)  — matched by normalizeProviderName
 *   - provider_overrides      (skills/insurance/notes overlay) — by normalized name
 *   - provider-insurance-data (insurances snapshot)      — by normalized name
 *   - existing crm_providers  (prefer existing CRM data, e.g. Ginger) — by normalized name
 *
 * SAFETY: writes NOTHING unless `--execute` is passed. Stage A runs WITHOUT it.
 * Idempotent on re-run via the lower(email) unique index (Stage B uses upsert).
 *
 *   node scripts/reconcile-providers.mjs            # dry-run (prints mapping)
 *   node scripts/reconcile-providers.mjs --execute  # Stage B ONLY, after approval
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const EXECUTE = process.argv.includes("--execute");
const ROOT = process.cwd();
const norm = (n) => (n || "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ");

function parseProviderList() {
  const s = readFileSync(path.join(ROOT, "server/email/provider-location-config.ts"), "utf8");
  const start = s.indexOf("PROVIDER_LIST");
  const block = s.slice(start, s.indexOf("];", start));
  const re = /name:\s*"([^"]+)",\s*credential:\s*"([^"]*)",\s*email:\s*"([^"]+)"/g;
  const out = []; let m;
  while ((m = re.exec(block))) out.push({ name: m[1], credential: m[2], email: m[3].toLowerCase() });
  return out;
}

async function parseRoster() {
  const XLSXmod = await import("xlsx");
  const XLSX = XLSXmod.default ?? XLSXmod;
  const wb = XLSX.readFile(path.join(ROOT, "data/Provider Skills Spreadsheet.xlsx"));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Current"], { header: 1, defval: "" });
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][0] || "").toString().trim();
    if (!name) continue;
    let cells = 0;
    for (let c = 3; c <= 29; c++) if ((rows[i][c] || "").toString().trim()) cells++;
    out.push({ name, norm: norm(name), loc: (rows[i][1] || "").toString().trim(), cells });
  }
  return out;
}

function parseInsuranceSnapshot() {
  const s = readFileSync(path.join(ROOT, "client/src/lib/provider-insurance-data.ts"), "utf8");
  const re = /"([^"]+)":\s*\[([^\]]*)\]/g;
  const out = {}; let m;
  while ((m = re.exec(s))) out[norm(m[1])] = m[2].split(",").map(x => x.trim()).filter(Boolean).length;
  return out;
}

async function main() {
  const hasDb = !!process.env.DATABASE_URL;
  const pool = hasDb ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
  const PL = parseProviderList();
  const roster = await parseRoster();
  const ins = parseInsuranceSnapshot();
  const ov = hasDb ? (await pool.query(`SELECT provider_name, suppressed FROM provider_overrides`)).rows : [];
  const crm = hasDb ? (await pool.query(`SELECT id, name, lower(email) email, is_active FROM crm_providers ORDER BY id`)).rows : [];
  if (!hasDb) console.log("(no DATABASE_URL — DB-sourced override/crm reconcile skipped; file-based mapping only)");

  const rosterBy = new Map(roster.map(r => [r.norm, r]));
  const ovBy = new Map(ov.map(o => [norm(o.provider_name), o]));
  const crmActiveBy = new Map(crm.filter(c => c.name && c.is_active).map(c => [norm(c.name), c]));
  const plNorms = new Set(PL.map(p => norm(p.name)));

  console.log(`\n=== INVENTORY === PROVIDER_LIST=${PL.length} roster=${roster.length} overrides=${ov.length} crm_providers=${crm.length}`);

  // collisions within PROVIDER_LIST
  const emailDup = {}, nameDup = {};
  for (const p of PL) { emailDup[p.email] = (emailDup[p.email]||0)+1; nameDup[norm(p.name)] = (nameDup[norm(p.name)]||0)+1; }
  console.log("EMAIL collisions:", Object.entries(emailDup).filter(([,c])=>c>1));
  console.log("NAME collisions :", Object.entries(nameDup).filter(([,c])=>c>1));

  console.log(`\n=== PROPOSED MAPPING (${PL.length} canonical rows; action keyed by lower(email)) ===`);
  console.log("email | name | cred(PL) | loc(roster) | rosterSkills | insSnapshot | override | existingCRM | ACTION");
  for (const p of PL) {
    const nn = norm(p.name);
    const r = rosterBy.get(nn), o = ovBy.get(nn), ex = crmActiveBy.get(nn);
    console.log([
      p.email, p.name, p.credential || "(blank)",
      r ? r.loc : "NONE", r ? `${r.cells} cells` : "NO ROSTER",
      (ins[nn] ?? 0) + " ins", o ? (o.suppressed ? "SUPPRESSED!" : "yes") : "no",
      ex ? `id=${ex.id}` : "none",
      ex ? "UPDATE in place" : "INSERT",
    ].join(" | "));
  }

  console.log(`\n=== MATCH AUDIT — roster names with NO PROVIDER_LIST email ===`);
  const unmatched = roster.filter(r => !plNorms.has(r.norm));
  unmatched.forEach(r => console.log(`  UNMATCHED roster: "${r.name}" (norm="${r.norm}") — review/alias needed`));
  console.log(`  (${unmatched.length} unmatched)`);

  console.log(`\n=== PROVIDER_LIST providers with NO roster skill overlay (import skill-less) ===`);
  PL.filter(p => !rosterBy.get(norm(p.name))).forEach(p => console.log(`  ${p.name} <${p.email}> — no roster match`));

  console.log(`\n=== RETIRE LIST (proposed; NOT deleted in dry-run) ===`);
  for (const c of crm) {
    const isCanonical = c.name && c.is_active && plNorms.has(norm(c.name));
    console.log(`  id=${c.id} name="${c.name}" active=${c.is_active} -> ${isCanonical ? "RECONCILE→canonical (update-in-place)" : "RETIRE (delete)"}`);
  }

  if (EXECUTE) {
    console.error("\n!!! --execute passed: this is Stage B. Aborting — Stage B is a SEPARATE approved prompt. No writes performed here.");
    process.exit(2);
  } else {
    console.log("\nDRY-RUN ONLY — no INSERT/UPDATE/DELETE performed. Pass --execute (Stage B, after approval) to write.");
  }
  if (pool) await pool.end();
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
