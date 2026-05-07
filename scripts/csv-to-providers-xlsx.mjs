#!/usr/bin/env node
/**
 * Convert Sandra's provider skills CSV to the xlsx the CRM parser expects.
 *
 *   Usage: node scripts/csv-to-providers-xlsx.mjs <input.csv> [output.xlsx]
 *
 * Defaults output to data/Provider Skills Spreadsheet.xlsx (sheet name "Current"),
 * which is what PROVIDER_SPREADSHEET_PATH points to and what the parser at
 * server/routes.ts:2818 reads. Re-run whenever Sandra delivers a fresh CSV.
 */
import * as XLSX from "xlsx/xlsx.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// xlsx/xlsx.mjs is the ESM build but doesn't bundle the node fs adapter.
// Wire it up so XLSX.readFile / XLSX.writeFile work.
import * as cpexcel from "xlsx/dist/cpexcel.full.mjs";
XLSX.set_cptable(cpexcel);
import * as fs from "node:fs";
XLSX.set_fs(fs);

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/csv-to-providers-xlsx.mjs <input.csv> [output.xlsx]");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultOutput = path.join(repoRoot, "data", "Provider Skills Spreadsheet.xlsx");
const outputPath = process.argv[3] || defaultOutput;

console.log(`[csv→xlsx] Reading ${inputPath}`);
const wb = XLSX.readFile(inputPath, { type: "file", cellDates: false, raw: true });

// CSV opens as a single sheet with a default name. Rename it to "Current"
// (the parser keys on this exact name).
const firstSheetName = wb.SheetNames[0];
const sheet = wb.Sheets[firstSheetName];
delete wb.Sheets[firstSheetName];
wb.Sheets["Current"] = sheet;
wb.SheetNames = ["Current"];

console.log(`[csv→xlsx] Writing ${outputPath} (sheet "Current")`);
XLSX.writeFile(wb, outputPath, { bookType: "xlsx" });

// Smoke test — read it back the way the server parser will.
const verify = XLSX.readFile(outputPath);
const verifySheet = verify.Sheets["Current"];
if (!verifySheet) {
  console.error(`[csv→xlsx] ERROR: round-trip lost the "Current" sheet`);
  process.exit(1);
}
const rows = XLSX.utils.sheet_to_json(verifySheet, { header: 1, defval: "" });
const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
const dataRows = rows.length - 2; // header rows 0 & 1 are not provider data
console.log(`[csv→xlsx] Verified: sheet "Current" — ${rows.length} rows total, ${dataRows} provider data rows, max ${maxCols} columns`);
console.log(`[csv→xlsx] Header row 0: ${JSON.stringify(rows[0]?.slice(0, 4))}...`);
console.log(`[csv→xlsx] Header row 1 (col 2): ${JSON.stringify(rows[1]?.[2])} (expect "Accepting Client")`);
console.log(`[csv→xlsx] Done.`);
