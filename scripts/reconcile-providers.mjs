#!/usr/bin/env node
/**
 * Phase 2 provider reconcile — Stage B execution.
 *
 * Two-environment split (Fly Postgres isn't reachable from a laptop; the Fly
 * machine has `xlsx` pruned):
 *   --prepare   : LOCAL. Parse PROVIDER_LIST + roster xlsx + insurance snapshot
 *                 into prepared.json (no DB). Run where xlsx is installed.
 *   (default)   : DRY-RUN. Read prepared.json + DB (overrides, crm), build the
 *                 canonical 28 + apply the 7 locked decisions, PRINT, no writes.
 *   --execute   : Apply the writes in one transaction (idempotent).
 *
 * Locked decisions (Stage A approved):
 *   1) "ty jones" roster -> Tyra Jones (tjones@)         carry roster skills
 *   2) "neuhart jessica" roster -> Jessica Neuhart       carry roster skills
 *   3) Laura Garcia-Rosecrans (lgarcia-rosecrans@)       import is_active=false
 *   4) Ginger Rippey -> UPDATE existing crm id=8 in place (email+cred LMHC; keep
 *      her existing skills/insurances). NOT delete+reinsert.
 *   5) Stale Ginger provider_overrides row (suppressed)  DELETE
 *   6) Insurances = snapshot (provider-insurance-data.ts) ⊕ existing crm (Ginger)
 *   7) Credential = PROVIDER_LIST
 * Retire: crm_providers ids 1..7 (junk). NEVER id=8.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MODE = process.argv.includes("--execute") ? "execute"
  : process.argv.includes("--prepare") ? "prepare" : "dryrun";
const ROOT = process.cwd();
const PREPARED = process.env.PREPARED_JSON || "/tmp/prepared.json";
const norm = (n) => (n || "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ");

const LAURA_EMAIL = "lgarcia-rosecrans@tfc.health";
const GINGER_EMAIL = "grippey@tfc.health";
const JUNK_IDS = [1, 2, 3, 4, 5, 6, 7];
// roster-name -> PROVIDER_LIST-name aliases (decisions 1,2)
const ROSTER_ALIASES = { "ty jones": "tyra jones", "neuhart jessica": "jessica neuhart" };

const AGE_GROUPS = [
  { label: "Adults (18+)", base: 3, specs: ["Anger Issues","Anxiety","Couples","Depression","Family","Grief","Trauma","Stress Management"] },
  { label: "Adolescents (12-17)", base: 11, specs: ["Anger Issues","Anxiety","Depression","Family","Grief","Trauma","Stress Management"] },
  { label: "Children (6-11)", base: 18, specs: ["Anger Issues","Anxiety","Depression","Family","Grief","Trauma","Stress Management"] },
  { label: "Children (0-5)", base: 25, specs: ["Anxiety","Depression","Family","Grief","Trauma"] },
];

// ---------- PREPARE (local, files only) ----------
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
  const rows = XLSX.utils.sheet_to_json(
    XLSX.readFile(path.join(ROOT, "data/Provider Skills Spreadsheet.xlsx")).Sheets["Current"],
    { header: 1, defval: "" });
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][0] || "").toString().trim();
    if (!name) continue;
    // Build the raw-cell age_groups matrix exactly like server/routes.ts.
    const ageGroups = {}; const specialties = new Set();
    for (const g of AGE_GROUPS) {
      ageGroups[g.label] = {};
      g.specs.forEach((skill, j) => {
        const v = (rows[i][g.base + j] || "").toString().trim();
        if (v) { ageGroups[g.label][skill] = v; specialties.add(skill); }
      });
    }
    out.push({ name, norm: ROSTER_ALIASES[norm(name)] || norm(name),
      loc: (rows[i][1] || "").toString().trim(), notes: (rows[i][30] || "").toString().trim(),
      ageGroups, specialties: [...specialties] });
  }
  return out;
}
function parseInsuranceSnapshot() {
  const s = readFileSync(path.join(ROOT, "client/src/lib/provider-insurance-data.ts"), "utf8");
  const re = /"([^"]+)":\s*\[([^\]]*)\]/g; const out = {}; let m;
  while ((m = re.exec(s))) out[norm(m[1])] = m[2].split(",").map(x => x.replace(/['"]/g, "").trim()).filter(Boolean);
  return out;
}

// ---------- CANONICAL BUILD (shared by dryrun + execute) ----------
function buildCanonical(prepared, crmRows) {
  const rosterBy = new Map(prepared.roster.map(r => [r.norm, r]));
  const ins = prepared.insuranceSnapshot;
  const crmGinger = crmRows.find(c => norm(c.name) === "ginger rippey" && c.is_active);
  return prepared.providerList.map(p => {
    const nn = norm(p.name);
    if (p.email === GINGER_EMAIL) {
      // Decision 4: UPDATE existing id=8 in place; keep skills/insurances.
      return { kind: "update-ginger", id: crmGinger?.id, email: p.email, name: p.name,
        credential: "LMHC", note: "keep existing skills/insurances; add email+cred" };
    }
    const r = rosterBy.get(nn);
    return {
      kind: "upsert", email: p.email, name: p.name, credential: p.credential,
      location: r ? r.loc : "", is_active: p.email === LAURA_EMAIL ? false : true,
      ageGroups: r ? r.ageGroups : {}, specialties: r ? r.specialties : [],
      insurances: ins[nn] || [], notes: r ? r.notes : "",
      rosterMatched: !!r,
    };
  });
}

async function getDb() {
  const { Pool } = await import("pg");
  return new Pool({ connectionString: process.env.DATABASE_URL });
}

async function main() {
  if (MODE === "prepare") {
    const prepared = { providerList: parseProviderList(), roster: await parseRoster(), insuranceSnapshot: parseInsuranceSnapshot() };
    writeFileSync(PREPARED, JSON.stringify(prepared));
    console.log(`PREPARED -> ${PREPARED} : providerList=${prepared.providerList.length} roster=${prepared.roster.length} insSnapshotKeys=${Object.keys(prepared.insuranceSnapshot).length}`);
    console.log("alias remaps applied:", JSON.stringify(ROSTER_ALIASES));
    return;
  }

  const prepared = JSON.parse(readFileSync(PREPARED, "utf8"));
  const pool = await getDb();
  const crmRows = (await pool.query(`SELECT id, name, lower(email) email, is_active FROM crm_providers ORDER BY id`)).rows;
  const overrides = (await pool.query(`SELECT provider_name, suppressed FROM provider_overrides`)).rows;
  const canonical = buildCanonical(prepared, crmRows);

  console.log(`\n=== CONFIRMATORY MAPPING (mode=${MODE}) ===`);
  console.log(`crm_providers BEFORE: ${crmRows.length} rows (active=${crmRows.filter(c=>c.is_active).length})`);
  for (const c of canonical) {
    if (c.kind === "update-ginger") { console.log(`UPDATE id=${c.id} GINGER <${c.email}> cred=${c.credential} (keep skills/insurances)`); continue; }
    const skillCells = Object.values(c.ageGroups).reduce((a,g)=>a+Object.keys(g).length,0);
    console.log(`UPSERT <${c.email}> ${c.name} cred=${c.credential} active=${c.is_active} loc=${c.location||"-"} skills=${skillCells} ins=${c.insurances.length} roster=${c.rosterMatched}`);
  }
  console.log(`RETIRE crm ids: ${JUNK_IDS.join(",")}`);
  console.log(`DELETE stale override: provider_name ILIKE 'ginger rippey' (suppressed)`);
  // sanity: collisions
  const emails = canonical.map(c=>c.email); const dup = emails.filter((e,i)=>emails.indexOf(e)!==i);
  console.log(`email collisions: ${JSON.stringify([...new Set(dup)])}`);
  console.log(`Laura active flag: ${canonical.find(c=>c.email===LAURA_EMAIL)?.is_active}  (expect false)`);

  if (MODE !== "execute") {
    console.log("\nDRY-RUN — no writes. Re-run with --execute to apply.");
    await pool.end(); return;
  }

  // ---------- EXECUTE (single transaction) ----------
  const client = await pool.connect();
  let ops = { del_junk: 0, upd_ginger: 0, inserted: 0, updated: 0, del_override: 0 };
  try {
    await client.query("BEGIN");
    const d1 = await client.query(`DELETE FROM crm_providers WHERE id = ANY($1::int[])`, [JUNK_IDS]); ops.del_junk = d1.rowCount;
    const g = canonical.find(c => c.kind === "update-ginger");
    if (g?.id) { const r = await client.query(
      `UPDATE crm_providers SET email=$1, credentials=$2, name=$3, is_active=true, updated_at=NOW() WHERE id=$4`,
      [g.email, g.credential, g.name, g.id]); ops.upd_ginger = r.rowCount; }
    for (const c of canonical) {
      if (c.kind !== "upsert") continue;
      const ex = await client.query(`SELECT id FROM crm_providers WHERE lower(email)=lower($1)`, [c.email]);
      const vals = [c.name, c.credential, c.location, c.email,
        JSON.stringify(c.specialties), JSON.stringify(c.ageGroups), JSON.stringify(c.insurances), c.notes, c.is_active];
      if (ex.rows[0]) {
        await client.query(`UPDATE crm_providers SET name=$1,credentials=$2,location=$3,email=$4,specialties=$5,age_groups=$6,insurances=$7,notes=$8,is_active=$9,updated_at=NOW() WHERE id=$10`,
          [...vals, ex.rows[0].id]); ops.updated++;
      } else {
        await client.query(`INSERT INTO crm_providers (name,credentials,location,email,specialties,age_groups,insurances,notes,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, vals); ops.inserted++;
      }
    }
    const o = await client.query(`DELETE FROM provider_overrides WHERE lower(provider_name)='ginger rippey'`); ops.del_override = o.rowCount;
    await client.query("COMMIT");
    console.log("\nEXECUTED:", JSON.stringify(ops));
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("ROLLBACK —", e.message); process.exit(1);
  } finally { client.release(); await pool.end(); }
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
