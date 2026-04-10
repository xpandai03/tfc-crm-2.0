/**
 * Intake PDF Template
 *
 * Builds a pdfmake document definition from a SyncContact row.
 * Uses Helvetica (PDF built-in) — no custom font files needed.
 */

import type { SyncContact, FormSubmission } from "../sync/db";

type Content = Record<string, unknown>;

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const monthIdx = parseInt(m[2], 10) - 1;
  return `${months[monthIdx]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

function formatDob(iso: string | null): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function cleanValue(val: string | null | undefined): string | null {
  if (!val || !val.trim()) return null;
  let s = val.trim();
  // Unwrap JSON arrays like '["Commercial Insurance"]' → "Commercial Insurance"
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        s = arr.filter((v: unknown) => typeof v === "string" && v.trim()).join(", ");
      }
    } catch {
      // not JSON, keep as-is
    }
  }
  // Normalize boolean-ish strings
  if (s === "True" || s === "true") return "Yes";
  if (s === "False" || s === "false") return "No";
  return s || null;
}

interface FieldRow {
  label: string;
  value: string;
}

function buildSection(title: string, fields: FieldRow[]): Content[] {
  if (fields.length === 0) return [];
  return [
    { text: title, style: "sectionHeader", margin: [0, 14, 0, 4] },
    {
      canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#CBD5E1" }],
      margin: [0, 0, 0, 8],
    },
    ...fields.map((f): Content => ({
      columns: [
        { text: f.label, style: "fieldLabel", width: 160 },
        { text: f.value, style: "fieldValue", width: "*" },
      ],
      margin: [0, 0, 0, 5],
    })),
  ];
}

function row(label: string, raw: string | number | null | undefined): FieldRow | null {
  if (raw === null || raw === undefined) return null;
  const val = typeof raw === "number" ? String(raw) : cleanValue(raw);
  if (!val) return null;
  return { label, value: val };
}

function buildAddressValue(contact: SyncContact): string | null {
  const parts: string[] = [];
  if (contact.streetAddress?.trim()) parts.push(contact.streetAddress.trim());
  const cityLine = [contact.city, contact.state, contact.zipCode]
    .filter((v) => v?.trim())
    .join(", ");
  if (cityLine) parts.push(cityLine);
  if (contact.county?.trim()) parts.push(`${contact.county.trim()} County`);
  return parts.length > 0 ? parts.join("\n") : null;
}

export function buildIntakeDocument(contact: SyncContact): Record<string, unknown> {
  const generatedAt = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  // --- Header ---
  const header: Content[] = [
    { text: "THE FAMILY CONNECTION", style: "orgName", margin: [0, 0, 0, 2] },
    { text: "Intake Submission", style: "docTitle", margin: [0, 0, 0, 12] },
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: contact.name, style: "contactName" },
            ...(contact.email ? [{ text: contact.email, style: "contactMeta" }] : []),
            ...(contact.phone ? [{ text: contact.phone, style: "contactMeta" }] : []),
          ],
        },
        {
          width: "auto",
          alignment: "right" as const,
          stack: [
            { text: `Contact ID: ${contact.contactId}`, style: "contactMeta" },
            ...(contact.dateAdded ? [{ text: `Date Submitted: ${formatDate(contact.dateAdded)}`, style: "contactMeta" }] : []),
            ...(contact.formCompletedBy ? [{ text: `Completed By: ${contact.formCompletedBy}`, style: "contactMeta" }] : []),
          ],
        },
      ],
      margin: [0, 0, 0, 6],
    },
    {
      canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: "#7C3AED" }],
      margin: [0, 4, 0, 0],
    },
  ];

  // --- Section: Intake Details ---
  const intakeFields = [
    row("Requesting For", contact.requestingFor),
    row("Service Requested", contact.serviceRequested),
    row("Modality", contact.modality),
    row("Reason for Seeking Services", contact.reasonForSeeking),
    row("Reason for Therapy", contact.reasonForTherapy),
    row("Detailed Reason", contact.detailedReason),
    row("Form Completed By", contact.formCompletedBy),
    row("Preferred Contact", contact.preferredContact),
  ].filter((f): f is FieldRow => f !== null);

  // --- Section: Insurance ---
  const insuranceFields = [
    row("Payer", contact.insurancePayer),
    row("Plan", contact.insurancePlan),
    row("Insurance ID", contact.insuranceId),
    row("Status", contact.insuranceStatus),
  ].filter((f): f is FieldRow => f !== null);

  // --- Section: Referral & History ---
  const referralFields = [
    row("Referral Source", contact.referralSource),
    row("Authorization", contact.referralAuth),
    row("Referral Status", contact.referralStatus),
    row("Prior Services", contact.priorServices),
    row("Prior Provider", contact.priorProvider),
  ].filter((f): f is FieldRow => f !== null);

  // --- Section: Demographics ---
  const demoFields = [
    row("Date of Birth", formatDob(contact.patientDob)),
    row("Gender", contact.gender),
    row("Age", contact.age),
  ].filter((f): f is FieldRow => f !== null);

  // --- Section: Address ---
  const addressValue = buildAddressValue(contact);
  const addressFields = addressValue
    ? [{ label: "Address", value: addressValue }]
    : [];

  // --- Section: Admin ---
  const adminFields = [
    row("Status", contact.status),
    row("Assigned To", contact.assignedTo),
    row("Custody", contact.custody),
    row("Flags", contact.flags),
    row("Priority", contact.priority),
  ].filter((f): f is FieldRow => f !== null);

  const content: Content[] = [
    ...header,
    ...buildSection("INTAKE DETAILS", intakeFields),
    ...buildSection("INSURANCE", insuranceFields),
    ...buildSection("REFERRAL & HISTORY", referralFields),
    ...buildSection("DEMOGRAPHICS", demoFields),
    ...buildSection("ADDRESS", addressFields),
    ...buildSection("ADMIN", adminFields),
  ];

  return {
    content,
    defaultStyle: {
      font: "Helvetica",
      fontSize: 10,
      lineHeight: 1.3,
    },
    styles: {
      orgName: {
        fontSize: 16,
        bold: true,
        color: "#7C3AED",
      },
      docTitle: {
        fontSize: 12,
        color: "#64748B",
      },
      contactName: {
        fontSize: 14,
        bold: true,
        color: "#1E293B",
      },
      contactMeta: {
        fontSize: 9,
        color: "#64748B",
        margin: [0, 1, 0, 0],
      },
      sectionHeader: {
        fontSize: 10,
        bold: true,
        color: "#475569",
        characterSpacing: 1,
      },
      fieldLabel: {
        fontSize: 9,
        bold: true,
        color: "#64748B",
      },
      fieldValue: {
        fontSize: 10,
        color: "#1E293B",
      },
    },
    pageSize: "A4" as const,
    pageMargins: [40, 40, 40, 60],
    footer: (currentPage: number, pageCount: number): Content => ({
      columns: [
        {
          text: `Generated: ${generatedAt}  ·  TFC CRM 2.0`,
          fontSize: 7,
          color: "#94A3B8",
          margin: [40, 0, 0, 0],
        },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          fontSize: 7,
          color: "#94A3B8",
          alignment: "right" as const,
          margin: [0, 0, 40, 0],
        },
      ],
      margin: [0, 20, 0, 0],
    }),
  };
}

/**
 * Build a PDF document from a single form submission's payload.
 * Used for per-submission PDF downloads (multi-intake support).
 */
export function buildSubmissionDocument(submission: FormSubmission): Record<string, unknown> {
  const raw = submission.payload as Record<string, unknown>;
  // Safely coerce all payload values to string | null for the row() helper
  const str = (key: string): string | null => {
    const v = raw[key];
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.filter(Boolean).join(", ") || null;
    if (typeof v === "object") return JSON.stringify(v);
    return String(v).trim() || null;
  };
  const generatedAt = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const submittedDate = submission.submittedAt
    ? formatDate(submission.submittedAt)
    : formatDate(submission.createdAt);

  // --- Header ---
  const header: Content[] = [
    { text: "THE FAMILY CONNECTION", style: "orgName", margin: [0, 0, 0, 2] },
    { text: "Intake Submission", style: "docTitle", margin: [0, 0, 0, 12] },
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: submission.name, style: "contactName" },
            ...(str("email") ? [{ text: str("email"), style: "contactMeta" }] : []),
            ...(str("phone") ? [{ text: str("phone"), style: "contactMeta" }] : []),
          ],
        },
        {
          width: "auto",
          alignment: "right" as const,
          stack: [
            { text: `Submission #${submission.id}`, style: "contactMeta" },
            ...(submittedDate ? [{ text: `Date Submitted: ${submittedDate}`, style: "contactMeta" }] : []),
            ...(str("formCompletedBy") ? [{ text: `Completed By: ${str("formCompletedBy")}`, style: "contactMeta" }] : []),
          ],
        },
      ],
      margin: [0, 0, 0, 6],
    },
    {
      canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: "#7C3AED" }],
      margin: [0, 4, 0, 0],
    },
  ];

  // Build sections from payload fields using safe coercion
  const intakeFields = [
    row("Requesting For", str("requestingFor")),
    row("Service Requested", str("serviceRequested")),
    row("Modality", str("modality")),
    row("Reason for Seeking Services", str("reasonForSeeking")),
    row("Reason for Therapy", str("reasonForTherapy")),
    row("Detailed Reason", str("detailedReason")),
    row("Form Completed By", str("formCompletedBy")),
    row("Preferred Contact", str("preferredContact")),
  ].filter((f): f is FieldRow => f !== null);

  const insuranceFields = [
    row("Payer", str("insurancePayer")),
    row("Plan", str("insurancePlan")),
    row("Insurance ID", str("insuranceId")),
    row("Status", str("insuranceStatus")),
  ].filter((f): f is FieldRow => f !== null);

  const referralFields = [
    row("Referral Source", str("referralSource")),
    row("Authorization", str("referralAuth")),
    row("Referral Status", str("referralStatus")),
    row("Prior Services", str("priorServices")),
    row("Prior Provider", str("priorProvider")),
  ].filter((f): f is FieldRow => f !== null);

  const demoFields = [
    row("Date of Birth", formatDob(str("patientDob"))),
    row("Gender", str("gender")),
    row("Age", str("age")),
  ].filter((f): f is FieldRow => f !== null);

  const addressParts: string[] = [];
  const streetAddr = str("streetAddress");
  if (streetAddr) addressParts.push(streetAddr);
  const cityLine = [str("city"), str("state"), str("zipCode")].filter(Boolean).join(", ");
  if (cityLine) addressParts.push(cityLine);
  const county = str("county");
  if (county) addressParts.push(`${county} County`);
  const addressFields = addressParts.length > 0
    ? [{ label: "Address", value: addressParts.join("\n") }]
    : [];

  // --- Section: Participants ---
  const participantContent: Content[] = [];
  const participants = raw.participantNames;
  if (Array.isArray(participants) && participants.length > 0) {
    const participantFields: FieldRow[] = [];
    for (const [idx, p] of (participants as Array<Record<string, unknown>>).entries()) {
      const prefix = participants.length > 1 ? `Participant ${idx + 1}` : "Participant";
      if (p.name) participantFields.push({ label: `${prefix} — Name`, value: String(p.name) });
      if (p.dob) participantFields.push({ label: `${prefix} — DOB`, value: String(p.dob) });
      if (p.email) participantFields.push({ label: `${prefix} — Email`, value: String(p.email) });
      if (p.phone) participantFields.push({ label: `${prefix} — Phone`, value: String(p.phone) });
    }
    participantContent.push(...buildSection("PARTICIPANTS", participantFields));
  }

  const content: Content[] = [
    ...header,
    ...buildSection("INTAKE DETAILS", intakeFields),
    ...participantContent,
    ...buildSection("INSURANCE", insuranceFields),
    ...buildSection("REFERRAL & HISTORY", referralFields),
    ...buildSection("DEMOGRAPHICS", demoFields),
    ...buildSection("ADDRESS", addressFields),
  ];

  return {
    content,
    defaultStyle: {
      font: "Helvetica",
      fontSize: 10,
      lineHeight: 1.3,
    },
    styles: {
      orgName: { fontSize: 16, bold: true, color: "#7C3AED" },
      docTitle: { fontSize: 12, color: "#64748B" },
      contactName: { fontSize: 14, bold: true, color: "#1E293B" },
      contactMeta: { fontSize: 9, color: "#64748B", margin: [0, 1, 0, 0] },
      sectionHeader: { fontSize: 10, bold: true, color: "#475569", characterSpacing: 1 },
      fieldLabel: { fontSize: 9, bold: true, color: "#64748B" },
      fieldValue: { fontSize: 10, color: "#1E293B" },
    },
    pageSize: "A4" as const,
    pageMargins: [40, 40, 40, 60],
    footer: (currentPage: number, pageCount: number): Content => ({
      columns: [
        { text: `Generated: ${generatedAt}  ·  TFC CRM 2.0`, fontSize: 7, color: "#94A3B8", margin: [40, 0, 0, 0] },
        { text: `Page ${currentPage} of ${pageCount}`, fontSize: 7, color: "#94A3B8", alignment: "right" as const, margin: [0, 0, 40, 0] },
      ],
      margin: [0, 20, 0, 0],
    }),
  };
}
