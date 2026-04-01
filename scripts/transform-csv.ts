/**
 * CSV → JSON Transform Script for TFC CRM Migration
 *
 * Reads the Excel CSV export and produces migration.json
 * matching the /api/migrate input format exactly.
 *
 * Usage:
 *   npx tsx scripts/transform-csv.ts path/to/Agent-Master.csv
 *
 * Output:
 *   migration.json in project root
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// CSV Parser (handles quoted fields with embedded newlines/commas)
// ---------------------------------------------------------------------------
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        current.push(field);
        field = "";
      } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
        current.push(field);
        field = "";
        if (current.length > 1) rows.push(current);
        current = [];
        if (ch === "\r") i++; // skip \r in \r\n
      } else {
        field += ch;
      }
    }
  }
  // Last field / last row
  if (field || current.length > 0) {
    current.push(field);
    if (current.length > 1) rows.push(current);
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = (row[i] ?? "").trim();
    }
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function emptyToNull(val: string | undefined): string | null {
  if (!val || val.trim() === "") return null;
  return val.trim();
}

function toInt(val: string | undefined): number | null {
  if (!val || val.trim() === "") return null;
  const n = parseInt(val.trim(), 10);
  return isNaN(n) ? null : n;
}

/**
 * Build "prior services" summary from Prior Counseling + When + Who
 */
function buildPriorServices(prior: string | undefined, whenWho: string | undefined): string | null {
  const p = emptyToNull(prior);
  const w = emptyToNull(whenWho);
  if (!p) return null;
  if (p.toLowerCase() === "no") return "No";
  // "Yes" + detail
  if (w) return `${p} — ${w}`;
  return p;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: npx tsx scripts/transform-csv.ts <path-to-csv>");
  process.exit(1);
}

const absolutePath = path.resolve(csvPath);
if (!fs.existsSync(absolutePath)) {
  console.error(`File not found: ${absolutePath}`);
  process.exit(1);
}

console.log(`Reading CSV: ${absolutePath}`);
const raw = fs.readFileSync(absolutePath, "latin1"); // Windows-1252 encoding
const rows = parseCSV(raw);
console.log(`Parsed ${rows.length} rows`);

// Map each row to MigrationContact format
const contacts = rows.map((r) => {
  const contactId = toInt(r["ContactId"]);
  if (contactId === null) return null;

  // Name: prefer "Full name", fall back to First + Last
  let name = emptyToNull(r["Full name"]);
  if (!name) {
    const first = emptyToNull(r["First Name"]) || "";
    const last = emptyToNull(r["Last Name"]) || "";
    name = `${first} ${last}`.trim() || null;
  }
  if (!name) return null;

  const statusCode = toInt(r["Status"]);

  return {
    contactId,
    name,
    email: emptyToNull(r["Email"]),
    phone: emptyToNull(r["Mobile Phone"]) || emptyToNull(r["Home Phone"]),
    statusCode,
    // serviceRequested is derived — build from requestingFor + reasonForTherapy
    serviceRequested: emptyToNull(r["Reason for Therapy MCQ"]) || emptyToNull(r["Detailed Reason"]) || null,
    daysOnWaitlist: toInt(r["days on waitlist"]),
    dateAdded: emptyToNull(r["Date added to waitlist cleaned"]),
    assignedTo: emptyToNull(r["Admin Assigned to Contact"]),
    requestingFor: emptyToNull(r["Requesting Services For"]),
    reasonForSeeking: emptyToNull(r["Detailed Reason"]),
    reasonForTherapy: emptyToNull(r["Reason for Therapy MCQ"]),
    detailedReason: emptyToNull(r["Detailed Reason"]),
    formCompletedBy: emptyToNull(r["Form Completed By"]),
    modality: emptyToNull(r["Desired Modality"]),
    priorServices: buildPriorServices(r["Prior Counseling"], r["When + Who"]),
    priorProvider: emptyToNull(r["When + Who"]),
    insurancePayer: emptyToNull(r["Primary Insurance Provider"]),
    insurancePlan: emptyToNull(r["Insurance Type"]),
    insuranceId: emptyToNull(r["Insurance ID Number"]),
    patientDob: emptyToNull(r["Patient DOB"]),
    gender: emptyToNull(r["Sex"]) || emptyToNull(r["Gender Identity"]),
    streetAddress: emptyToNull(r["Street Address"]),
    city: emptyToNull(r["City"]),
    state: emptyToNull(r["State"]),
    zipCode: emptyToNull(r["Zip Code"]),
    rfsLink: emptyToNull(r["RFS LINK"]),
    lastNote: r["Notes added by agent"] || null, // preserve notes exactly — no trim
    flags: emptyToNull(r["Attention Required"]),
  };
}).filter((c): c is NonNullable<typeof c> => c !== null);

console.log(`\nTransformed ${contacts.length} valid contacts (${rows.length - contacts.length} skipped — missing contactId or name)`);

// Stats
const statusDist: Record<number, number> = {};
for (const c of contacts) {
  if (c.statusCode !== null) {
    statusDist[c.statusCode] = (statusDist[c.statusCode] || 0) + 1;
  }
}
console.log("\nStatus distribution:");
for (const [code, count] of Object.entries(statusDist).sort(([a], [b]) => Number(a) - Number(b))) {
  console.log(`  ${code}: ${count}`);
}

// Sample output
console.log("\n--- Sample (first 2 contacts) ---");
console.log(JSON.stringify(contacts.slice(0, 2), null, 2));

// Write output
const outputPath = path.resolve(process.cwd(), "migration.json");
const payload = { contacts };
fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");
console.log(`\nWrote ${outputPath} (${contacts.length} contacts)`);
