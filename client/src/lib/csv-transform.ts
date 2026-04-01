/**
 * Browser-safe CSV → MigrationContact[] transform
 *
 * Ported from scripts/transform-csv.ts with no Node.js dependencies.
 * Parses CSV text (with quoted fields / embedded newlines) and maps
 * Excel columns to the /api/migrate input format.
 */

export interface MigrationContact {
  contactId: number;
  name: string;
  email: string | null;
  phone: string | null;
  statusCode: number | null;
  serviceRequested: string | null;
  daysOnWaitlist: number | null;
  dateAdded: string | null;
  assignedTo: string | null;
  requestingFor: string | null;
  reasonForSeeking: string | null;
  reasonForTherapy: string | null;
  detailedReason: string | null;
  formCompletedBy: string | null;
  modality: string | null;
  priorServices: string | null;
  priorProvider: string | null;
  insurancePayer: string | null;
  insurancePlan: string | null;
  insuranceId: string | null;
  patientDob: string | null;
  gender: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  rfsLink: string | null;
  lastNote: string | null;
  flags: string | null;
}

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
          i++;
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
        if (ch === "\r") i++;
      } else {
        field += ch;
      }
    }
  }
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

function emptyToNull(val: string | undefined): string | null {
  if (!val || val.trim() === "") return null;
  return val.trim();
}

function toInt(val: string | undefined): number | null {
  if (!val || val.trim() === "") return null;
  const n = parseInt(val.trim(), 10);
  return isNaN(n) ? null : n;
}

function buildPriorServices(prior: string | undefined, whenWho: string | undefined): string | null {
  const p = emptyToNull(prior);
  const w = emptyToNull(whenWho);
  if (!p) return null;
  if (p.toLowerCase() === "no") return "No";
  if (w) return `${p} — ${w}`;
  return p;
}

export interface TransformResult {
  contacts: MigrationContact[];
  totalRows: number;
  skippedRows: number;
  statusDistribution: Record<number, number>;
}

export function transformCSV(csvText: string): TransformResult {
  const rows = parseCSV(csvText);

  const contacts: MigrationContact[] = [];
  let skippedRows = 0;

  for (const r of rows) {
    const contactId = toInt(r["ContactId"]);
    if (contactId === null) { skippedRows++; continue; }

    let name = emptyToNull(r["Full name"]);
    if (!name) {
      const first = emptyToNull(r["First Name"]) || "";
      const last = emptyToNull(r["Last Name"]) || "";
      name = `${first} ${last}`.trim() || null;
    }
    if (!name) { skippedRows++; continue; }

    contacts.push({
      contactId,
      name,
      email: emptyToNull(r["Email"]),
      phone: emptyToNull(r["Mobile Phone"]) || emptyToNull(r["Home Phone"]),
      statusCode: toInt(r["Status"]),
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
      lastNote: r["Notes added by agent"] || null,
      flags: emptyToNull(r["Attention Required"]),
    });
  }

  const statusDistribution: Record<number, number> = {};
  for (const c of contacts) {
    if (c.statusCode !== null) {
      statusDistribution[c.statusCode] = (statusDistribution[c.statusCode] || 0) + 1;
    }
  }

  return { contacts, totalRows: rows.length, skippedRows, statusDistribution };
}
