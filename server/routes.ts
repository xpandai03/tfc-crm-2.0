import type { Express } from "express";
import { createServer, type Server } from "http";
import { createReminder as createReminderInDb, getReminderStats } from "./reminders";

// Configuration for mock vs live data mode
// Change to "live" to use real n8n webhooks instead of mock data
type DataMode = "mock" | "live";
const DATA_MODE: DataMode = "live";

// ============================================================================
// Server-Side Board Data Cache
// ============================================================================
// Purpose: Reduce duplicate n8n calls when navigating from list to detail views
// The get-contact-snapshot endpoint needs board data to look up contactId → name
// This cache allows reusing board data fetched by list pages within a short window
//
// TTL: 60 seconds (board data is relatively stable)
// ============================================================================
interface BoardCacheEntry {
  data: { contacts: Array<{ contactId: number; name: string; [key: string]: unknown }> };
  timestamp: number;
}

let boardCache: BoardCacheEntry | null = null;
const BOARD_CACHE_TTL_MS = 60 * 1000; // 60 seconds

function getBoardFromCache(): BoardCacheEntry["data"] | null {
  if (!boardCache) return null;
  const age = Date.now() - boardCache.timestamp;
  if (age > BOARD_CACHE_TTL_MS) {
    console.log("[board-cache] Cache expired, clearing");
    boardCache = null;
    return null;
  }
  console.log(`[board-cache] Cache hit (age: ${Math.round(age / 1000)}s)`);
  return boardCache.data;
}

function setBoardCache(data: BoardCacheEntry["data"]): void {
  boardCache = { data, timestamp: Date.now() };
  console.log("[board-cache] Cache updated");
}

// ============================================================================
// Date Normalization Helper (Phase 6.4)
// ============================================================================
// Excel stores dates as serial numbers (days since Dec 30, 1899)
// This helper detects and converts Excel serials to ISO date strings
// ============================================================================
function normalizeExcelDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  // If it's already a valid date string, return it
  if (typeof value === "string") {
    // Check if it's a recognizable date format (ISO, MM/DD/YYYY, etc.)
    const dateRegex = /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}/;
    if (dateRegex.test(value)) {
      return value;
    }
    // Try parsing as number (Excel serial passed as string)
    const num = parseFloat(value);
    // Range 15000-80000 covers years 1941-2119 (for birth dates from 1940s onward)
    if (!isNaN(num) && num > 15000 && num < 80000) {
      return excelSerialToIso(num);
    }
    return value; // Return as-is if not recognizable
  }

  // If it's a number, check if it's an Excel serial
  if (typeof value === "number") {
    // Range 15000-80000 covers years 1941-2119 (for birth dates from 1940s onward)
    // Excel serial 28045 = ~1976, 36526 = 2000, 45000 = ~2023
    if (value > 15000 && value < 80000) {
      return excelSerialToIso(value);
    }
    return String(value); // Return as string if not Excel serial
  }

  return null;
}

function excelSerialToIso(serial: number): string {
  // Excel epoch is Dec 30, 1899
  const excelEpoch = new Date(1899, 11, 30);
  const date = new Date(excelEpoch.getTime() + serial * 24 * 60 * 60 * 1000);
  // Return as YYYY-MM-DD
  return date.toISOString().split("T")[0];
}

// ============================================================================
// HARD-LOCKED n8n URLs - NO ENV VARS FOR CRITICAL ENDPOINTS
// ============================================================================
// The waitlist board URL MUST be this exact value. No env var fallback.
// This prevents URL resolution bugs from misconfigured environment variables.
const WAITLIST_BOARD_URL = "https://n8n-familyconnection.agentglu.agency/webhook/get-waitlist-board";
const WAITLIST_SUMMARY_URL = "https://n8n-familyconnection.agentglu.agency/webhook/get-waitlist-summary";

// Other n8n endpoints (less critical, can use env vars)
const N8N_ENDPOINTS = {
  contactSnapshot: process.env.N8N_GET_CONTACT_SNAPSHOT_URL || "https://n8n-familyconnection.agentglu.agency/webhook/get-contact-snapshot",
  updateStatus: process.env.N8N_UPDATE_CONTACT_STATUS_URL || "https://n8n-familyconnection.agentglu.agency/webhook/update-contact-status",
  addNote: process.env.N8N_ADD_CONTACT_NOTE_URL || "https://n8n-familyconnection.agentglu.agency/webhook/add-contact-note",
  assignContact: process.env.N8N_ASSIGN_CONTACT_URL || "https://n8n-familyconnection.agentglu.agency/webhook/assign-contact",
} as const;

// Mock data for development
type MockContact = {
  name: string;
  email?: string;
  phone?: string;
  status: string;
  serviceRequested: string;
  daysOnWaitlist: number;
  dateAdded: string;
  lastContact?: string;
  assignedTo?: string;
  notes: { date: string; content: string; author?: string }[];
  // Additional intake fields (Phase 6)
  modality?: string;
  insurancePayer?: string;
  referralSource?: string;
  priorServices?: string;
  // Demographics (Phase 6.2)
  patientDob?: string;
  gender?: string;
  // Address (Phase 6.2)
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  // Contact preferences (Phase 6.2)
  preferredContact?: string;
  // Intake context
  requestingFor?: string;
  reasonForSeeking?: string;
  formCompletedBy?: string;
};

const mockContacts: MockContact[] = [
  {
    name: "Emilio Castro",
    email: "emilio.castro@email.com",
    phone: "(555) 123-4567",
    status: "waiting",
    serviceRequested: "Family Counseling",
    daysOnWaitlist: 72,
    dateAdded: "2025-10-28",
    lastContact: "2025-12-15",
    assignedTo: "Sarah Johnson",
    notes: [
      { date: "2025-12-15", content: "Called to check in. Still interested in services.", author: "SJ" },
      { date: "2025-11-20", content: "Initial intake completed. Waiting for provider availability.", author: "MC" },
    ],
    // Mock intake fields for testing
    modality: "In-Person",
    insurancePayer: "Blue Cross Blue Shield",
    referralSource: "School Counselor",
    priorServices: "None reported",
    // Phase 6.2 fields
    patientDob: "2015-03-15",
    gender: "Male",
    streetAddress: "123 Oak Street",
    city: "Austin",
    state: "TX",
    zipCode: "78701",
    preferredContact: "Phone",
    requestingFor: "Child (son)",
    reasonForSeeking: "Behavioral issues at school, difficulty with transitions",
    formCompletedBy: "Parent (Maria Castro)",
  },
  {
    name: "Maria Santos",
    email: "maria.santos@email.com",
    phone: "(555) 234-5678",
    status: "ready_to_schedule",
    serviceRequested: "Child Therapy",
    daysOnWaitlist: 45,
    dateAdded: "2025-11-25",
    lastContact: "2026-01-05",
    assignedTo: "Mike Chen",
    notes: [
      { date: "2026-01-05", content: "Provider available next week. Ready to schedule.", author: "MC" },
    ],
    modality: "Telehealth",
    insurancePayer: "Medicaid",
    referralSource: "Pediatrician referral",
  },
  {
    name: "James Wilson",
    email: "james.w@email.com",
    phone: "(555) 345-6789",
    status: "intake",
    serviceRequested: "Couples Counseling",
    daysOnWaitlist: 5,
    dateAdded: "2026-01-04",
    notes: [],
  },
  {
    name: "Linda Thompson",
    email: "linda.t@email.com",
    phone: "(555) 456-7890",
    status: "waiting",
    serviceRequested: "Individual Therapy",
    daysOnWaitlist: 68,
    dateAdded: "2025-11-02",
    lastContact: "2025-12-20",
    assignedTo: "Sarah Johnson",
    notes: [
      { date: "2025-12-20", content: "Follow-up call. Patient is flexible with scheduling." },
    ],
  },
  {
    name: "Robert Kim",
    email: "robert.kim@email.com",
    phone: "(555) 567-8901",
    status: "on_hold",
    serviceRequested: "Family Counseling",
    daysOnWaitlist: 30,
    dateAdded: "2025-12-10",
    lastContact: "2026-01-02",
    notes: [
      { date: "2026-01-02", content: "Requested hold due to travel. Will resume in February." },
    ],
  },
  {
    name: "Jennifer Lopez",
    email: "jen.lopez@email.com",
    phone: "(555) 678-9012",
    status: "waiting",
    serviceRequested: "Child Therapy",
    daysOnWaitlist: 85,
    dateAdded: "2025-10-16",
    lastContact: "2025-12-28",
    assignedTo: "Mike Chen",
    notes: [
      { date: "2025-12-28", content: "Discussed options. Waiting for Spanish-speaking provider." },
    ],
  },
  {
    name: "David Brown",
    email: "david.b@email.com",
    phone: "(555) 789-0123",
    status: "ready_to_schedule",
    serviceRequested: "Individual Therapy",
    daysOnWaitlist: 21,
    dateAdded: "2025-12-19",
    lastContact: "2026-01-07",
    notes: [
      { date: "2026-01-07", content: "Provider matched. Sending appointment options." },
    ],
  },
  {
    name: "Sarah Martinez",
    email: "sarah.m@email.com",
    phone: "(555) 890-1234",
    status: "scheduled",
    serviceRequested: "Couples Counseling",
    daysOnWaitlist: 14,
    dateAdded: "2025-12-26",
    lastContact: "2026-01-08",
    notes: [
      { date: "2026-01-08", content: "First appointment scheduled for Jan 15." },
    ],
  },
  {
    name: "Michael Johnson",
    email: "michael.j@email.com",
    phone: "(555) 901-2345",
    status: "intake",
    serviceRequested: "Family Counseling",
    daysOnWaitlist: 3,
    dateAdded: "2026-01-06",
    notes: [],
  },
  {
    name: "Amanda White",
    email: "amanda.w@email.com",
    phone: "(555) 012-3456",
    status: "waiting",
    serviceRequested: "Child Therapy",
    daysOnWaitlist: 52,
    dateAdded: "2025-11-18",
    lastContact: "2025-12-30",
    assignedTo: "Sarah Johnson",
    notes: [
      { date: "2025-12-30", content: "Needs evening appointments only." },
    ],
  },
  {
    name: "Christopher Lee",
    email: "chris.lee@email.com",
    phone: "(555) 123-4568",
    status: "closed",
    serviceRequested: "Individual Therapy",
    daysOnWaitlist: 0,
    dateAdded: "2025-09-15",
    lastContact: "2025-11-01",
    notes: [
      { date: "2025-11-01", content: "Successfully completed 8-week program." },
    ],
  },
  {
    name: "Patricia Garcia",
    email: "patricia.g@email.com",
    phone: "(555) 234-5679",
    status: "waiting",
    serviceRequested: "Family Counseling",
    daysOnWaitlist: 63,
    dateAdded: "2025-11-07",
    lastContact: "2026-01-03",
    assignedTo: "Mike Chen",
    notes: [
      { date: "2026-01-03", content: "Bilingual services requested." },
    ],
  },
];

function getMockContact(name: string) {
  return mockContacts.find(
    (c) => c.name.toLowerCase() === name.toLowerCase()
  );
}

function getMockWaitlistSummary() {
  const activeContacts = mockContacts.filter((c) => c.status !== "closed");
  return {
    totalActive: activeContacts.length,
    avgWaitDays: Math.round(
      activeContacts.reduce((sum, c) => sum + c.daysOnWaitlist, 0) / activeContacts.length
    ),
    longestWaitDays: Math.max(...mockContacts.map((c) => c.daysOnWaitlist)),
    longestWaitingName: "Jennifer Lopez",
    over30Days: activeContacts.filter((c) => c.daysOnWaitlist > 30).length,
    over60Days: activeContacts.filter((c) => c.daysOnWaitlist > 60).length,
    readyToSchedule: mockContacts.filter((c) => c.status === "ready_to_schedule").length,
    needsFollowUp: mockContacts.filter((c) => c.status === "waiting" && c.daysOnWaitlist > 14).length,
    byStatus: {
      intake: mockContacts.filter((c) => c.status === "intake").length,
      waiting: mockContacts.filter((c) => c.status === "waiting").length,
      ready_to_schedule: mockContacts.filter((c) => c.status === "ready_to_schedule").length,
      scheduled: mockContacts.filter((c) => c.status === "scheduled").length,
      on_hold: mockContacts.filter((c) => c.status === "on_hold").length,
      closed: mockContacts.filter((c) => c.status === "closed").length,
    },
  };
}

// Convert string status to numeric code (for mock data compatibility)
function stringStatusToCode(status: string): number {
  const mapping: Record<string, number> = {
    intake: 100,
    waiting: 101,
    ready_to_schedule: 200,
    scheduled: 202,
    on_hold: 300,
    closed: 400,
  };
  return mapping[status] || 100;
}

function getMockWaitlistContacts() {
  // CRITICAL: Must include contactId and statusCode for Today page cards to work
  return mockContacts.map((c, index) => ({
    contactId: index + 1, // 1-indexed to match live data convention
    name: c.name,
    status: c.status,
    statusCode: stringStatusToCode(c.status), // Convert string status to numeric
    serviceRequested: c.serviceRequested,
    daysOnWaitlist: c.daysOnWaitlist,
    dateAdded: c.dateAdded,
  }));
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Get contact snapshot by contactId (ONLY)
  // Strategy:
  //   1. Look up contact in board cache/data by contactId
  //   2. Call n8n get-contact-snapshot with contactId for detailed data
  // IMPORTANT: contactName is NOT supported - n8n workflow expects contactId only
  app.post("/api/get-contact-snapshot", async (req, res) => {
    try {
      const { contactId } = req.body;

      if (contactId === undefined || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }

      console.log(`[contact-snapshot] Fetching contact by ID: ${contactId}`);

      if (DATA_MODE === "live") {
        try {
          // Step 1: Look up contact by ID (use cache if available to avoid duplicate n8n calls)
          let contacts: Array<{ contactId: number; name: string; [key: string]: unknown }>;
          const cachedBoard = getBoardFromCache();

          if (cachedBoard) {
            // Use cached board data (reduces n8n calls when navigating from list to detail)
            console.log(`[contact-snapshot] Using cached board data for contact ${contactId}`);
            contacts = cachedBoard.contacts;
          } else {
            // Cache miss - fetch fresh board data from n8n
            console.log(`[contact-snapshot] Cache miss, fetching board from n8n for contact ${contactId}`);
            console.log(`[contact-snapshot] FINAL FETCH URL =`, WAITLIST_BOARD_URL);
            const boardResponse = await fetch(WAITLIST_BOARD_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            });

            if (!boardResponse.ok) {
              throw new Error(`Board fetch failed: ${boardResponse.status}`);
            }

            const boardData = await boardResponse.json();
            contacts = boardData.contacts || [];

            // Populate cache for future lookups
            setBoardCache({ contacts });
          }

          // Find contact by ID
          const contact = contacts.find((c) => c.contactId === contactId);

          if (!contact) {
            console.warn(`[DATA_INTEGRITY] Contact ${contactId} not found in board data (Excel row missing?)`);
            return res.status(404).json({ error: "Contact not found", contactId });
          }

          // Defensive: Validate required fields exist
          if (contact.statusCode === undefined) {
            console.warn(`[DATA_INTEGRITY] Contact ${contactId} (${contact.name}) missing statusCode`);
          }
          if (!contact.name) {
            console.warn(`[DATA_INTEGRITY] Contact ${contactId} missing name field`);
          }

          console.log(`[contact-snapshot] Found contact in board: ${contact.name} (ID: ${contactId})`);

          // Step 2: Call n8n contact-snapshot with contactId for detailed data (notes, intake fields)
          // IMPORTANT: n8n workflow expects contactId ONLY - do not send contactName
          let detailedData = {};
          try {
            const snapshotResponse = await fetch(N8N_ENDPOINTS.contactSnapshot, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contactId }),
            });

            if (snapshotResponse.ok) {
              const rawData = await snapshotResponse.json();
              // Extract contact details from n8n response
              detailedData = rawData.contact || rawData || {};
              console.log(`[contact-snapshot] Got detailed data for contactId ${contactId}`);
            } else {
              console.warn(`[contact-snapshot] n8n snapshot returned ${snapshotResponse.status} for contactId ${contactId}`);
            }
          } catch (snapshotError) {
            console.warn(`[contact-snapshot] Failed to get detailed data for contactId ${contactId}:`, snapshotError);
          }

          // Step 3: Merge board data with detailed data (board data takes precedence for core fields)
          // Extract detailed fields from n8n response
          const detailed = detailedData as Record<string, unknown>;

          // Debug: Log assignedTo from all sources
          console.log(`[contact-snapshot] assignedTo sources for ${contact.name}:`, {
            "detailed.assignedTo": detailed.assignedTo,
            "detailed['Admin Assigned To Contact']": detailed["Admin Assigned To Contact"],
            "contact.assignedTo": contact.assignedTo,
            "contact['Admin Assigned To Contact']": contact["Admin Assigned To Contact"],
          });

          // Compute umbrella from status code
          const statusCode = contact.statusCode as number | undefined;
          const umbrella = statusCode !== undefined
            ? (statusCode >= 100 && statusCode < 200 ? "WL"
               : statusCode >= 200 && statusCode < 300 ? "PS"
               : statusCode >= 300 && statusCode < 400 ? "PMR"
               : statusCode >= 400 && statusCode < 500 ? "INS"
               : "unknown")
            : "unknown";

          const mergedData = {
            // Core identity fields
            contactId: contact.contactId,
            name: contact.name,

            // Contact info from n8n detailed response
            email: (detailed.email as string) || null,
            phone: (detailed.phone as string) || null,

            // Intake info from n8n detailed response
            requestingFor: (detailed.requestingFor as string) || null,
            reasonForSeeking: (detailed.reasonForSeeking as string) || null,
            // Excel column BD: Reason for Therapy MCQ (comma-separated string)
            reasonForTherapy: (detailed.reasonForTherapy as string) 
              || (detailed["Reason for Therapy MCQ"] as string)
              || (detailed.reasonForTherapyMCQ as string)
              || (detailed["Reason for Therapy"] as string)
              || null,
            // Detailed Reason - INTERNAL USE ONLY (provider matching)
            // Not displayed in UI - sensitive narrative data
            detailedReason: (detailed.detailedReason as string) || (detailed.DetailedReason as string) || null,
            formCompletedBy: (detailed.formCompletedBy as string) || null,

            // Additional intake fields (Phase 6)
            modality: (detailed.modality as string) || null,
            referralSource: (detailed.referralSource as string) || null,
            priorServices: (detailed.priorServices as string) || null,
            priorProvider: (detailed.priorProvider as string) || null,

            // Insurance fields (Phase 6.3)
            insurancePayer: (detailed.insurancePayer as string) || (detailed.insurance as string) || null,
            insurancePlan: (detailed.insurancePlan as string) || (detailed.planName as string) || null,
            insuranceId: (detailed.insuranceId as string) || (detailed.memberId as string) || (detailed.policyNumber as string) || null,
            insuranceStatus: (detailed.insuranceStatus as string) || (detailed.verificationStatus as string) || null,

            // Referral fields (Phase 6.3)
            referralAuth: (detailed.referralAuth as string) || (detailed.authNumber as string) || null,
            referralStatus: (detailed.referralStatus as string) || null,

            // Demographics (Phase 6.2) - DOB normalized from Excel serial (Phase 6.4)
            patientDob: normalizeExcelDate(detailed.patientDob || detailed.dob || detailed.dateOfBirth),
            gender: (detailed.gender as string) || (detailed.sex as string) || null,
            age: typeof detailed.age === "number" ? detailed.age : null,

            // Address (Phase 6.2)
            streetAddress: (detailed.streetAddress as string) || (detailed.address as string) || (detailed.street as string) || null,
            city: (detailed.city as string) || null,
            state: (detailed.state as string) || null,
            zipCode: (detailed.zipCode as string) || (detailed.zip as string) || (detailed.postalCode as string) || null,
            county: (detailed.county as string) || null,

            // Contact preferences (Phase 6.2)
            preferredContact: (detailed.preferredContact as string) || (detailed.preferredContactMethod as string) || (detailed.contactPreference as string) || null,

            // Admin / Flags (Phase 6.3)
            custody: (detailed.custody as string) || (detailed.custodyStatus as string) || null,
            flags: (detailed.flags as string) || (detailed.alert as string) || null,
            priority: (detailed.priority as string) || (detailed.urgency as string) || null,

            // Links (Phase 6.3 - CRITICAL)
            rfsLink: (detailed.rfsLink as string) || (detailed.rfs as string) || (detailed.sharepointLink as string) || (detailed.formLink as string) || null,
            documentLink: (detailed.documentLink as string) || (detailed.documents as string) || (detailed.fileLink as string) || null,

            // Status fields (board data is authoritative)
            statusCode: contact.statusCode,
            umbrella,
            status: contact.status || "intake",

            // Waitlist tracking fields (dates normalized from Excel serial - Phase 6.4)
            serviceRequested: contact.serviceRequested || (detailed.requestingFor as string) || "Unknown",
            daysOnWaitlist: contact.daysOnWaitlist ?? 0,
            dateAdded: normalizeExcelDate(contact.dateAdded),
            lastContact: normalizeExcelDate(detailed.lastContact),

            // Assignment and notes
            // Check multiple sources: n8n snapshot, board data (may have different field names)
            assignedTo: (detailed.assignedTo as string)
              || (detailed["Admin Assigned To Contact"] as string)
              || (contact.assignedTo as string)
              || (contact["Admin Assigned To Contact"] as string)
              || null,
            notes: parseNotesFromLastNote(detailed.lastNote as string | undefined),
          };

          // Defensive: Log if intake fields are all missing (possible n8n field mapping issue)
          const hasAnyIntakeField = mergedData.requestingFor || mergedData.reasonForSeeking ||
            mergedData.formCompletedBy || mergedData.modality || mergedData.insurancePayer ||
            mergedData.referralSource || mergedData.priorServices;
          if (!hasAnyIntakeField) {
            console.warn(`[DATA_INTEGRITY] Contact ${contactId} (${contact.name}) has no intake fields - check n8n field mapping`);
          }

          console.log(`[contact-snapshot] Returning merged data for ${contact.name}`);
          return res.json({ ...mergedData, _source: "live" });
        } catch (liveError) {
          console.error("Live data fetch failed:", liveError);
          return res.status(404).json({ error: "Contact not found", contactId });
        }
      } else {
        // Mock mode - search by index (contactId maps to array index + 1)
        const mockContact = mockContacts[contactId - 1];
        if (!mockContact) {
          return res.status(404).json({ error: "Contact not found", contactId });
        }
        // Compute statusCode and umbrella from status string
        const statusCode = stringStatusToCode(mockContact.status);
        const umbrella = statusCode >= 100 && statusCode < 200 ? "WL"
          : statusCode >= 200 && statusCode < 300 ? "PS"
          : statusCode >= 300 && statusCode < 400 ? "PMR"
          : statusCode >= 400 && statusCode < 500 ? "INS"
          : "unknown";
        return res.json({
          ...mockContact,
          contactId,
          statusCode,
          umbrella,
          _source: "mock",
        });
      }
    } catch (error) {
      console.error("Error fetching contact snapshot:", error);
      return res.status(500).json({ error: "Failed to fetch contact snapshot" });
    }
  });

  // =============================================================================
  // ROBUST NOTE PARSER v4 - Comprehensive date extraction for legacy Excel audit trails
  // =============================================================================
  //
  // Key insight: Real data uses mixed patterns:
  // - INITIALS + DATE + TIME at START of line → content follows
  // - INITIALS + DATE + TIME in MIDDLE of text → content precedes (END marker)
  // - Standalone DATE → content follows (START marker)
  // =============================================================================

  interface ParsedNote {
    date: string;
    content: string;
    author?: string;
  }

  /**
   * Check if string is a time indicator (AM/PM) - not valid initials
   */
  function isTimeIndicator(str: string): boolean {
    return /^(AM|PM)$/i.test(str);
  }

  /**
   * Check if string looks like valid author initials
   */
  function isValidInitials(str: string): boolean {
    if (!str || str.length < 2 || str.length > 3) return false;
    if (isTimeIndicator(str)) return false;
    if (!/^[A-Z]{2,3}$/.test(str)) return false;
    return true;
  }

  /**
   * Normalize date string to ISO format with smart year inference
   */
  function normalizeDate(dateStr: string, contextYear: number = 2025): string {
    if (!dateStr) return "";

    // Clean the date string (remove trailing colon, etc.)
    dateStr = dateStr.replace(/[:\s]+$/, "").trim();

    // Already ISO format
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;

    // Parse MM/DD/YYYY or MM-DD-YYYY (4-digit year)
    let match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (match) {
      const [, month, day, year] = match;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    // Parse MM/DD/YY or MM-DD-YY (2-digit year)
    match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
    if (match) {
      const [, month, day, shortYear] = match;
      const year = 2000 + parseInt(shortYear);
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    // Parse M/D (month/day only) - infer year from context
    match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if (match) {
      const [, month, day] = match;
      return `${contextYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    return dateStr;
  }

  /**
   * Extract trailing initials from end of text segment
   * Handles: DP, JN\, -EB-, CM\, . AC, etc.
   */
  function extractTrailingInitials(text: string): { initials: string; cleanText: string } | null {
    const trimmed = text.trim();

    // Pattern 1: -INITIALS- format (e.g., -EB-)
    let match = trimmed.match(/\s*-([A-Z]{2,3})-\s*$/);
    if (match && isValidInitials(match[1])) {
      return {
        initials: match[1],
        cleanText: trimmed.slice(0, -match[0].length).trim()
      };
    }

    // Pattern 2: INITIALS\ or INITIALS, or INITIALS. or just INITIALS at end
    match = trimmed.match(/[.,\s]+([A-Z]{2,3})[\\,.\s]*$/);
    if (match && isValidInitials(match[1])) {
      return {
        initials: match[1],
        cleanText: trimmed.slice(0, -match[0].length).trim()
      };
    }

    // Pattern 3: Just INITIALS at end (space + initials)
    match = trimmed.match(/\s([A-Z]{2,3})$/);
    if (match && isValidInitials(match[1])) {
      return {
        initials: match[1],
        cleanText: trimmed.slice(0, -match[0].length).trim()
      };
    }

    return null;
  }

  /**
   * Main parser function v4 - comprehensive date extraction
   */
  /**
   * Infer context year from dates found in the text
   * Since all data is Oct 2025 - Jan 2026, we infer year intelligently
   */
  function inferContextYearFromText(text: string): number {
    // First, try to find any full dates (with year) in the text
    const fullDatePattern = /\d{1,2}[\/\-]\d{1,2}[\/\-](\d{2,4})/g;
    const years: number[] = [];
    let match;
    
    while ((match = fullDatePattern.exec(text)) !== null) {
      const yearStr = match[1];
      if (yearStr.length === 4) {
        years.push(parseInt(yearStr));
      } else if (yearStr.length === 2) {
        const year = 2000 + parseInt(yearStr);
        years.push(year);
      }
    }
    
    // If we found years, use the most recent one
    if (years.length > 0) {
      return Math.max(...years);
    }
    
    // For short dates without year, infer from month:
    // Oct-Dec (10-12) = 2025, Jan (1) = 2026
    // Check for any month indicators in the text
    const monthPattern = /\b(?:Jan|January|Oct|October|Nov|November|Dec|December)\b/i;
    if (monthPattern.test(text)) {
      const textLower = text.toLowerCase();
      if (textLower.includes('jan') || textLower.includes('january')) {
        return 2026;
      }
      return 2025;
    }
    
    // Default: if we're currently in Jan 2026, use 2026; otherwise 2025
    const now = new Date();
    const currentMonth = now.getMonth() + 1; // 1-12
    const currentYear = now.getFullYear();
    
    if (currentMonth === 1 && currentYear === 2026) {
      return 2026;
    }
    
    return 2025;
  }

  /**
   * Infer year for a short date (M/D) based on month
   * Oct-Dec (10-12) = 2025, Jan (1) = 2026
   */
  function inferYearForShortDate(month: number): number {
    if (month >= 1 && month <= 1) return 2026; // January
    if (month >= 10 && month <= 12) return 2025; // Oct-Dec
    return 2025; // Default fallback
  }

  function parseNotesRobust(lastNote: string | undefined): ParsedNote[] {
    if (!lastNote || typeof lastNote !== "string" || lastNote.trim() === "") {
      return [];
    }

    const results: ParsedNote[] = [];
    // Infer context year from the text itself (handles Oct 2025 - Jan 2026 range)
    const contextYear = inferContextYearFromText(lastNote);

    // Handle CRM notes first (they're well-structured)
    const crmHeaderPattern = /\[([A-Z]{2,3})\s*\|\s*(\d{1,2}\/\d{1,2}\/\d{4}),\s*(\d{1,2}:\d{2}\s*[AP]M)\]/g;
    let crmMatch;
    let lastCrmContentEnd = 0;

    while ((crmMatch = crmHeaderPattern.exec(lastNote)) !== null) {
      const headerEnd = crmMatch.index + crmMatch[0].length;
      const nextCrmMatch = lastNote.slice(headerEnd).search(/\[([A-Z]{2,3})\s*\|/);
      const nextDoubleNewline = lastNote.slice(headerEnd).indexOf("\n\n");

      let contentEnd: number;
      if (nextCrmMatch >= 0 && nextDoubleNewline >= 0) {
        contentEnd = headerEnd + Math.min(nextCrmMatch, nextDoubleNewline);
      } else if (nextDoubleNewline >= 0) {
        contentEnd = headerEnd + nextDoubleNewline;
      } else if (nextCrmMatch >= 0) {
        contentEnd = headerEnd + nextCrmMatch;
      } else {
        const legacyDateMatch = lastNote.slice(headerEnd).search(/[A-Z]{2,3}\s+\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}/);
        contentEnd = legacyDateMatch >= 0 ? headerEnd + legacyDateMatch : lastNote.length;
      }

      const content = lastNote.slice(headerEnd, contentEnd).trim();
      if (content) {
        results.push({
          date: normalizeDate(crmMatch[2]),
          content,
          author: crmMatch[1],
        });
      }
      lastCrmContentEnd = Math.max(lastCrmContentEnd, contentEnd);
    }

    // Get legacy text
    let legacyText: string;
    if (lastCrmContentEnd > 0) {
      const doubleNewline = lastNote.indexOf("\n\n", lastCrmContentEnd - 10);
      legacyText = doubleNewline >= 0 ? lastNote.slice(doubleNewline).trim() : lastNote.slice(lastCrmContentEnd).trim();
    } else {
      legacyText = lastNote;
    }

    if (!legacyText) {
      results.sort((a, b) => b.date.localeCompare(a.date));
      return results;
    }

    // Find ALL date patterns in legacy text
    interface DateMarker {
      index: number;
      endIndex: number;
      date: string;
      normalizedDate: string;
      author?: string;
      hasTime: boolean;
      isEndMarker: boolean;
    }

    const markers: DateMarker[] = [];
    let match;

    // Pattern A: INITIALS + DATE + TIME
    const endMarkerPattern = /([A-Z]{2,3})\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)/g;
    while ((match = endMarkerPattern.exec(legacyText)) !== null) {
      if (!isTimeIndicator(match[1])) {
        const beforeText = legacyText.slice(Math.max(0, match.index - 20), match.index);
        const atLineStart = /(?:^|[\n\\])\s*$/.test(beforeText) || match.index === 0;
        markers.push({
          index: match.index,
          endIndex: match.index + match[0].length,
          date: match[2],
          normalizedDate: normalizeDate(match[2]),
          author: match[1],
          hasTime: true,
          isEndMarker: !atLineStart,
        });
      }
    }

    // Pattern B: INITIALS + DATE (no time) - full date with year
    const initialsDatePattern = /([A-Z]{2,3})\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})(?!\s+\d{1,2}:\d{2})/g;
    while ((match = initialsDatePattern.exec(legacyText)) !== null) {
      if (!isTimeIndicator(match[1])) {
        const overlaps = markers.some(m =>
          (match!.index >= m.index && match!.index < m.endIndex) ||
          (m.index >= match!.index && m.index < match!.index + match![0].length)
        );
        if (!overlaps) {
          const beforeText = legacyText.slice(Math.max(0, match.index - 20), match.index);
          const atLineStart = /(?:^|[\n\\])\s*$/.test(beforeText) || match.index === 0;
          markers.push({
            index: match.index,
            endIndex: match.index + match[0].length,
            date: match[2],
            normalizedDate: normalizeDate(match[2]),
            author: match[1],
            hasTime: false,
            isEndMarker: !atLineStart,
          });
        }
      }
    }

    // Pattern B2: INITIALS + SHORT_DATE (M/D without year) - NEW PATTERN
    // Matches: "NB 1/9", "LVM 1/9", "EB 11/25", etc.
    const initialsShortDatePattern = /([A-Z]{2,3})\s+(\d{1,2}\/\d{1,2})(?![\/\-\d])/g;
    while ((match = initialsShortDatePattern.exec(legacyText)) !== null) {
      if (!isTimeIndicator(match[1])) {
        const overlaps = markers.some(m =>
          (match!.index >= m.index && match!.index < m.endIndex) ||
          (m.index >= match!.index && m.index < match!.index + match![0].length)
        );
        if (!overlaps) {
          // Infer year from month: Jan = 2026, Oct-Dec = 2025
          const dateParts = match[2].split('/');
          const month = parseInt(dateParts[0]);
          const inferredYear = inferYearForShortDate(month);
          
          const beforeText = legacyText.slice(Math.max(0, match.index - 20), match.index);
          const atLineStart = /(?:^|[\n\\])\s*$/.test(beforeText) || match.index === 0;
          markers.push({
            index: match.index,
            endIndex: match.index + match[0].length,
            date: match[2],
            normalizedDate: normalizeDate(match[2], inferredYear),
            author: match[1],
            hasTime: false,
            isEndMarker: !atLineStart,
          });
        }
      }
    }

    // Pattern C: Date at START of line/segment
    const startDatePattern = /(?:^|[\n\\]\s*)(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}):?\s/gm;
    while ((match = startDatePattern.exec(legacyText)) !== null) {
      const overlaps = markers.some(m =>
        (match!.index >= m.index && match!.index < m.endIndex) ||
        (m.index >= match!.index && m.index < match!.index + match![0].length)
      );
      if (!overlaps) {
        markers.push({
          index: match.index,
          endIndex: match.index + match[0].length,
          date: match[1],
          normalizedDate: normalizeDate(match[1]),
          author: undefined,
          hasTime: false,
          isEndMarker: false,
        });
      }
    }

    // Pattern D: Standalone date MM/DD/YY
    const standaloneDatePattern = /(?<![\/\-\d])(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2})(?![\/\-\d])/g;
    while ((match = standaloneDatePattern.exec(legacyText)) !== null) {
      const overlaps = markers.some(m =>
        (match!.index >= m.index && match!.index < m.endIndex) ||
        (m.index >= match!.index && m.index < match!.index + match![0].length)
      );
      if (!overlaps) {
        markers.push({
          index: match.index,
          endIndex: match.index + match[0].length,
          date: match[1],
          normalizedDate: normalizeDate(match[1]),
          author: undefined,
          hasTime: false,
          isEndMarker: false,
        });
      }
    }

    // Pattern E: Short date M/D after separator
    const shortDatePattern = /(?:[\n\\]\s*)(\d{1,2}\/\d{1,2})(?![\/\-\d])/g;
    while ((match = shortDatePattern.exec(legacyText)) !== null) {
      const overlaps = markers.some(m =>
        (match!.index >= m.index && match!.index < m.endIndex) ||
        (m.index >= match!.index && m.index < match!.index + match![0].length)
      );
      if (!overlaps) {
        // Infer year from month: Jan = 2026, Oct-Dec = 2025
        const dateParts = match[1].split('/');
        const month = parseInt(dateParts[0]);
        const inferredYear = inferYearForShortDate(month);
        
        markers.push({
          index: match.index,
          endIndex: match.index + match[0].length,
          date: match[1],
          normalizedDate: normalizeDate(match[1], inferredYear),
          author: undefined,
          hasTime: false,
          isEndMarker: false,
        });
      }
    }

    // Pattern F: Inline short date M/D (after space, followed by letter)
    const inlineShortDatePattern = /\s(\d{1,2}\/\d{1,2})(?=\s+[A-Za-z])/g;
    while ((match = inlineShortDatePattern.exec(legacyText)) !== null) {
      const overlaps = markers.some(m =>
        (match!.index >= m.index && match!.index < m.endIndex) ||
        (m.index >= match!.index && m.index < match!.index + match![0].length)
      );
      if (!overlaps) {
        const parts = match[1].split("/");
        const month = parseInt(parts[0]);
        const day = parseInt(parts[1]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          // Infer year from month: Jan = 2026, Oct-Dec = 2025
          const inferredYear = inferYearForShortDate(month);
          
          markers.push({
            index: match.index + 1,
            endIndex: match.index + match[0].length,
            date: match[1],
            normalizedDate: normalizeDate(match[1], inferredYear),
            author: undefined,
            hasTime: false,
            isEndMarker: false,
          });
        }
      }
    }

    // Sort markers by position
    markers.sort((a, b) => a.index - b.index);

    // Process markers to create entries
    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const prevMarker = markers[i - 1];
      const nextMarker = markers[i + 1];

      let content: string;
      let author = marker.author;

      if (marker.isEndMarker) {
        const contentStart = prevMarker ? prevMarker.endIndex : 0;
        content = legacyText.slice(contentStart, marker.index).trim();
      } else {
        const contentEnd = nextMarker ? nextMarker.index : legacyText.length;
        content = legacyText.slice(marker.endIndex, contentEnd).trim();

        if (!author) {
          const trailing = extractTrailingInitials(content);
          if (trailing) {
            author = trailing.initials;
            content = trailing.cleanText;
          }
        }
      }

      content = content
        .replace(/^[\\\s,.:]+/, "")
        .replace(/[\\\s,.:]+$/, "")
        .replace(/\s+/g, " ")
        .trim();

      if (content && content.length > 3) {
        results.push({
          date: marker.normalizedDate,
          content,
          author,
        });
      }
    }

    // Log parsing statistics
    const totalEntries = results.length;
    const unknownDateCount = results.filter(r => !r.date).length;
    if (totalEntries > 0) {
      console.log(`[parseNotes] Parsed ${totalEntries} entries, UnknownDate=${unknownDateCount}`);
    }

    // Sort: dated entries by date desc, unknown-date entries last
    results.sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      return 0;
    });

    return results;
  }

  // Main entry point - uses robust parser
  function parseNotesFromLastNote(lastNote: string | undefined): ParsedNote[] {
    return parseNotesRobust(lastNote);
  }

  // Get waitlist summary
  app.post("/api/get-waitlist-summary", async (_req, res) => {
    console.log("[SUMMARY] === REQUEST START ===");
    console.log("[SUMMARY] FINAL FETCH URL =", WAITLIST_SUMMARY_URL);
    try {
      if (DATA_MODE === "live") {
        try {
          // HARD-LOCKED URL - no env vars, no fallbacks
          const response = await fetch(WAITLIST_SUMMARY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });

          console.log("[SUMMARY] n8n response status:", response.status);

          if (!response.ok) {
            throw new Error(`n8n webhook returned ${response.status}`);
          }

          const liveData = await response.json();
          
          // Normalize live data to match expected schema
          // Live data has: averageWaitDays, longestWaiting.name, longestWaiting.days
          // Expected: avgWaitDays, longestWaitingName, longestWaitDays
          const normalizedData = {
            totalActive: liveData.totalActive ?? 0,
            avgWaitDays: liveData.averageWaitDays ?? liveData.avgWaitDays ?? 0,
            longestWaitDays: liveData.longestWaiting?.days ?? liveData.maxWaitDays ?? liveData.longestWaitDays ?? 0,
            longestWaitingName: liveData.longestWaiting?.name ?? liveData.longestWaitingName ?? "---",
            over30Days: liveData.over30Days ?? 0,
            over60Days: liveData.over60Days ?? 0,
            readyToSchedule: liveData.readyToSchedule ?? 0,
            needsFollowUp: liveData.needsFollowUp ?? 0,
            // byStatus may not exist in live data - frontend will compute it
            byStatus: liveData.byStatus ?? liveData.statusBreakdown ?? {},
          };
          
          return res.json({ ...normalizedData, _source: "live" });
        } catch (liveError) {
          console.warn("Live data fetch failed, falling back to mock:", liveError);
          return res.json({ ...getMockWaitlistSummary(), _source: "fallback" });
        }
      } else {
        return res.json({ ...getMockWaitlistSummary(), _source: "mock" });
      }
    } catch (error) {
      console.error("Error fetching waitlist summary:", error);
      return res.status(500).json({ error: "Failed to fetch waitlist summary" });
    }
  });

  // Get all waitlist contacts (for Today page priority queues)
  // Uses the board endpoint to ensure contactId is always present
  app.get("/api/waitlist-contacts", async (_req, res) => {
    console.log("[WAITLIST-CONTACTS] === REQUEST START ===");
    console.log("[WAITLIST-CONTACTS] DATA_MODE:", DATA_MODE);
    console.log("[WAITLIST-CONTACTS] FINAL FETCH URL =", WAITLIST_BOARD_URL);
    try {
      if (DATA_MODE === "live") {
        try {
          // HARD-LOCKED URL - no env vars, no fallbacks
          const response = await fetch(WAITLIST_BOARD_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });

          console.log("[WAITLIST-CONTACTS] n8n response status:", response.status);
          console.log("[WAITLIST-CONTACTS] n8n response content-type:", response.headers.get("content-type"));

          // CRITICAL: Detect HTML responses (wrong URL symptom)
          const contentType = response.headers.get("content-type") || "";
          if (contentType.includes("text/html")) {
            const htmlPreview = await response.text();
            console.error("[WAITLIST-CONTACTS] RECEIVED HTML INSTEAD OF JSON!");
            console.error("[WAITLIST-CONTACTS] HTML preview:", htmlPreview.substring(0, 500));
            throw new Error("Received HTML response - wrong URL or n8n error");
          }

          if (!response.ok) {
            console.error("[WAITLIST-CONTACTS] n8n returned non-200 status:", response.status, response.statusText);
            throw new Error(`n8n webhook returned ${response.status}`);
          }

          // Parse response
          const text = await response.text();
          console.log("[WAITLIST-CONTACTS] n8n response length:", text.length);
          console.log("[WAITLIST-CONTACTS] n8n response preview:", text.substring(0, 300));

          if (!text || text.trim() === "") {
            console.error("[WAITLIST-CONTACTS] Empty response from n8n");
            throw new Error("Empty response from n8n");
          }

          let data;
          try {
            data = JSON.parse(text);
            console.log("[WAITLIST-CONTACTS] JSON parsed successfully");
          } catch (parseError) {
            console.error("[WAITLIST-CONTACTS] JSON parse error:", parseError);
            console.error("[WAITLIST-CONTACTS] Response text that failed to parse:", text.substring(0, 500));
            throw new Error(`Failed to parse n8n response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
          }

          console.log("[WAITLIST-CONTACTS] Parsed data keys:", Object.keys(data));
          console.log("[WAITLIST-CONTACTS] _source from n8n:", data._source);
          console.log("[WAITLIST-CONTACTS] contacts type:", typeof data.contacts, Array.isArray(data.contacts) ? "array" : "not array");
          console.log("[WAITLIST-CONTACTS] contacts length:", data.contacts?.length ?? "undefined");

          // CRITICAL: Use n8n's _source if present, otherwise default to "live" if we have valid data
          const source = data._source === "live" || data._source === "fallback" ? data._source : "live";

          if (data.contacts && Array.isArray(data.contacts)) {
            console.log("[WAITLIST-CONTACTS] Contacts array is valid, filtering for contactId");
            
            // Validate that contacts have contactId (log but don't fail)
            // Also extract insurancePayer if present (for insights aggregation)
            const validContacts = data.contacts
              .filter((c: any) => {
                if (c.contactId === undefined || c.contactId === null) {
                  console.warn("[WAITLIST-CONTACTS] Contact missing contactId:", c.name);
                  return false;
                }
                return true;
              })
              .map((c: any) => {
                // Pass-through insurancePayer if present (for insights aggregation)
                // Try multiple field name variations from Excel/n8n
                const insurancePayer = c.insurancePayer 
                  || c.insurance 
                  || c["Primary Insurance Provider"]
                  || c["Primary insurance provider"]
                  || c["primaryInsuranceProvider"]
                  || c["Insurance"]
                  || c["Insurance Payer"]
                  || c["Primary Insurance"]
                  || null;
                
                // Pass-through modality if present (for insights aggregation)
                const modality = c.modality
                  || c["Desired Modality"]
                  || c.desiredModality
                  || null;
                
                // Normalize dateAdded from Excel serial to ISO format (YYYY-MM-DD)
                const dateAdded = normalizeExcelDate(c.dateAdded);
                
                return {
                  ...c,
                  insurancePayer: insurancePayer ? String(insurancePayer).trim() : undefined, // Convert null to undefined for optional field
                  modality: modality ? String(modality).trim() : undefined, // Convert null to undefined for optional field
                  dateAdded: dateAdded || null, // Normalized date (YYYY-MM-DD) or null
                };
              });

            console.log("[WAITLIST-CONTACTS] Valid contacts after filtering:", validContacts.length, "out of", data.contacts.length);

            // Populate server-side cache for contact-snapshot lookups
            // This reduces duplicate n8n calls when navigating from Today to Contact Detail
            setBoardCache({ contacts: validContacts });

            console.log("[WAITLIST-CONTACTS] Returning live data with _source:", source, "and", validContacts.length, "contacts");
            return res.json({ contacts: validContacts, _source: source });
          } else {
            console.error("[WAITLIST-CONTACTS] Invalid data structure - contacts is not an array");
            console.error("[WAITLIST-CONTACTS] data.contacts type:", typeof data.contacts, "value:", data.contacts);
            // If contacts array is missing or empty, that's still valid data (just means no contacts)
            // Only fall back if the structure is completely wrong
            if (data.contacts === undefined) {
              console.warn("[WAITLIST-CONTACTS] No contacts field in response, falling back to mock");
              return res.json({ contacts: getMockWaitlistContacts(), _source: "fallback" });
            }
            // If contacts exists but isn't an array, treat as empty array rather than falling back
            console.warn("[WAITLIST-CONTACTS] contacts is not an array, treating as empty array");
            setBoardCache({ contacts: [] });
            return res.json({ contacts: [], _source: source });
          }
        } catch (liveError) {
          const errorMessage = liveError instanceof Error ? liveError.message : String(liveError);
          const errorStack = liveError instanceof Error ? liveError.stack : undefined;
          console.error("[WAITLIST-CONTACTS] Live data fetch failed:", errorMessage);
          if (errorStack) {
            console.error("[WAITLIST-CONTACTS] Error stack:", errorStack);
          }
          console.warn("[WAITLIST-CONTACTS] Falling back to mock data");
          return res.json({ contacts: getMockWaitlistContacts(), _source: "fallback" });
        }
      } else {
        console.log("[WAITLIST-CONTACTS] DATA_MODE is 'mock', returning mock data");
        return res.json({ contacts: getMockWaitlistContacts(), _source: "mock" });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[WAITLIST-CONTACTS] Unexpected error:", errorMessage);
      return res.status(500).json({ error: "Failed to fetch waitlist contacts" });
    }
  });

  // Get waitlist board (contact rows for Kanban - uses dedicated live endpoint)
  app.post("/api/get-waitlist-board", async (_req, res) => {
    console.log("[BOARD] === REQUEST START ===");
    console.log("[BOARD] DATA_MODE:", DATA_MODE);
    console.log("[BOARD] FINAL FETCH URL =", WAITLIST_BOARD_URL);
    try {
      if (DATA_MODE === "live") {
        try {
          // HARD-LOCKED URL - no env vars, no fallbacks
          const response = await fetch(WAITLIST_BOARD_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
            },
            body: JSON.stringify({}),
          });

          console.log("[BOARD] n8n response status:", response.status);
          console.log("[BOARD] n8n response content-type:", response.headers.get("content-type"));

          // CRITICAL: Detect HTML responses (wrong URL symptom)
          const contentType = response.headers.get("content-type") || "";
          if (contentType.includes("text/html")) {
            const htmlPreview = await response.text();
            console.error("[BOARD] RECEIVED HTML INSTEAD OF JSON!");
            console.error("[BOARD] HTML preview:", htmlPreview.substring(0, 500));
            throw new Error("Received HTML response - wrong URL or n8n error");
          }

          if (!response.ok) {
            throw new Error(`n8n webhook returned ${response.status}`);
          }

          const text = await response.text();
          console.log("[BOARD] n8n response length:", text.length);
          console.log("[BOARD] n8n response preview:", text.substring(0, 200));

          if (!text || text.trim() === "") {
            throw new Error("Empty response from n8n");
          }

          let data;
          try {
            data = JSON.parse(text);
            console.log("[BOARD] JSON parsed successfully");
          } catch (parseError) {
            console.error("[BOARD] JSON parse error:", parseError);
            console.error("[BOARD] Response text that failed to parse:", text.substring(0, 500));
            throw new Error(`Failed to parse n8n response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
          }

          console.log("[BOARD] Parsed data keys:", Object.keys(data));
          console.log("[BOARD] n8n board _source:", data._source);
          console.log("[BOARD] n8n board contacts type:", typeof data.contacts, Array.isArray(data.contacts) ? "array" : "not array");
          console.log("[BOARD] n8n board contacts count:", data.contacts?.length ?? "undefined");

          // CRITICAL: Preserve _source from n8n response, default to "live" if missing but data is valid
          const source = data._source === "live" || data._source === "fallback" ? data._source : "live";

          // Defensive: Check for contacts missing required fields (log warnings, don't fail)
          if (data.contacts && Array.isArray(data.contacts)) {
            const missingContactId = data.contacts.filter((c: any) => c.contactId === undefined || c.contactId === null);
            const missingStatusCode = data.contacts.filter((c: any) => c.statusCode === undefined);
            if (missingContactId.length > 0) {
              console.warn(`[BOARD][DATA_INTEGRITY] ${missingContactId.length} contacts missing contactId:`, missingContactId.slice(0, 5).map((c: any) => c.name));
            }
            if (missingStatusCode.length > 0) {
              console.warn(`[BOARD][DATA_INTEGRITY] ${missingStatusCode.length} contacts missing statusCode:`, missingStatusCode.slice(0, 5).map((c: any) => c.name || c.contactId));
            }

            // Populate server-side cache for contact-snapshot lookups
            // This reduces duplicate n8n calls when navigating from list to detail view
            setBoardCache({ contacts: data.contacts });
            
            console.log("[BOARD] Returning live data with _source:", source, "and", data.contacts.length, "contacts");
          } else {
            console.warn("[BOARD] Contacts field is missing or not an array");
            console.warn("[BOARD] data.contacts type:", typeof data.contacts, "value:", data.contacts);
            // Still return the data structure even if contacts is missing/invalid
            // Let the frontend handle it
            if (!data.contacts) {
              data.contacts = [];
            }
          }

          // Return the response with preserved/ensured _source field
          return res.json({ ...data, _source: source });
        } catch (liveError) {
          console.warn("Live board fetch failed, falling back to mock:", liveError);
          return res.json({ contacts: getMockWaitlistContacts(), _source: "fallback" });
        }
      } else {
        return res.json({ contacts: getMockWaitlistContacts(), _source: "mock" });
      }
    } catch (error) {
      console.error("Error fetching waitlist board:", error);
      return res.status(500).json({ error: "Failed to fetch waitlist board" });
    }
  });

  // Get config (for frontend to know if live mode is enabled)
  app.get("/api/config", (_req, res) => {
    res.json({ dataMode: DATA_MODE });
  });

  // Valid status codes for the umbrella model
  // WL (100-104), PS (200-205), PMR (300), INS (400)
  // Note: 205 (Initial Appt Completed) is inactive and appears in INS column
  const VALID_STATUS_CODES = [100, 101, 102, 103, 104, 200, 201, 202, 203, 204, 205, 300, 400];

  // Umbrella types for status grouping
  type UmbrellaId = "WL" | "PS" | "PMR" | "INS" | "unknown";

  // Get umbrella ID from status code
  function getUmbrellaForStatusCode(statusCode: number | undefined): UmbrellaId {
    if (statusCode === undefined) return "unknown";
    if (statusCode >= 100 && statusCode < 200) return "WL";
    if (statusCode >= 200 && statusCode < 300) return "PS";
    if (statusCode >= 300 && statusCode < 400) return "PMR";
    if (statusCode >= 400 && statusCode < 500) return "INS";
    return "unknown";
  }

  // Update contact status by contactId
  app.post("/api/update-status", async (req, res) => {
    try {
      const { contactId, statusCode } = req.body;

      if (contactId === undefined || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }
      if (statusCode === undefined || typeof statusCode !== "number") {
        return res.status(400).json({ error: "statusCode (number) is required" });
      }

      // Validate status code against known values
      if (!VALID_STATUS_CODES.includes(statusCode)) {
        console.warn(`[update-status] Invalid status code ${statusCode} for contactId ${contactId}`);
        return res.status(400).json({
          error: "Invalid status code",
          message: `Status code ${statusCode} is not valid`,
          validCodes: VALID_STATUS_CODES,
        });
      }

      console.log(`[update-status] Request received:`, {
        contactId,
        statusCode,
        timestamp: new Date().toISOString(),
      });

      if (DATA_MODE === "live") {
        try {
          const payload = { contactId, statusCode };

          console.log(`[update-status] Calling n8n with payload:`, payload);

          const response = await fetch(N8N_ENDPOINTS.updateStatus, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          const responseText = await response.text();
          console.log(`[update-status] n8n response:`, {
            status: response.status,
            statusText: response.statusText,
            body: responseText.substring(0, 500),
          });

          if (!response.ok) {
            console.error(`[update-status] n8n returned ${response.status}: ${responseText}`);
            return res.status(502).json({
              error: "Status update failed",
              message: `n8n returned ${response.status}: ${response.statusText}`,
              details: responseText.substring(0, 200),
            });
          }

          // Parse the response
          let data;
          try {
            data = JSON.parse(responseText);
          } catch {
            data = { success: true, contactId, newStatus: statusCode };
          }

          console.log(`[update-status] Success for contactId ${contactId}:`, data);
          return res.json({ success: true, contactId, newStatus: statusCode, ...data });
        } catch (liveError) {
          const errorMessage = liveError instanceof Error ? liveError.message : "Unknown error";
          console.error(`[update-status] Live update failed for contactId ${contactId}:`, errorMessage);
          return res.status(500).json({
            error: "Status update failed",
            message: `Could not update status: ${errorMessage}`,
          });
        }
      } else {
        // Mock mode - update by index
        const statusCodeToString: Record<number, string> = {
          100: "intake",
          101: "waiting",
          102: "waiting",
          200: "ready_to_schedule",
          201: "waiting",
          202: "scheduled",
          203: "waiting",
          300: "on_hold",
          400: "closed",
        };

        const contact = mockContacts[contactId - 1];
        if (!contact) {
          return res.status(404).json({ error: "Contact not found", contactId });
        }
        contact.status = statusCodeToString[statusCode] || contact.status;
        return res.json({ success: true, contactId, newStatus: statusCode });
      }
    } catch (error) {
      console.error("Error updating status:", error);
      return res.status(500).json({ error: "Failed to update status" });
    }
  });

  // Add note to contact by contactId
  // n8n contract: { contactId, note, author, timestamp }
  // n8n handles appending to Excel "Notes added by agent" column
  app.post("/api/add-note", async (req, res) => {
    try {
      const { contactId, note, author, timestamp } = req.body;

      // Validate all required fields
      if (contactId === undefined || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }
      if (!note || typeof note !== "string" || note.trim() === "") {
        return res.status(400).json({ error: "note content is required" });
      }
      if (!author || typeof author !== "string" || author.trim() === "") {
        return res.status(400).json({ error: "author initials are required" });
      }
      if (!timestamp || typeof timestamp !== "string") {
        return res.status(400).json({ error: "timestamp is required" });
      }

      console.log(`[add-note] Adding note to contactId ${contactId}`, {
        author,
        timestamp,
        notePreview: note.substring(0, 50),
      });

      if (DATA_MODE === "live") {
        try {
          // Forward exact payload to n8n - it handles Excel formatting
          const payload = {
            contactId,
            note: note.trim(),
            author: author.trim(),
            timestamp,
          };

          console.log(`[add-note] Sending to n8n:`, payload);

          const response = await fetch(N8N_ENDPOINTS.addNote, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          const responseText = await response.text();
          console.log(`[add-note] n8n response:`, {
            status: response.status,
            body: responseText.substring(0, 200),
          });

          if (!response.ok) {
            console.error(`[add-note] n8n returned ${response.status}: ${responseText}`);
            return res.status(502).json({
              error: "Failed to add note",
              message: `n8n returned ${response.status}`,
              details: responseText.substring(0, 200),
            });
          }

          // Parse response if JSON
          let data = {};
          try {
            data = JSON.parse(responseText);
          } catch {
            // Response might not be JSON - that's OK
          }

          console.log(`[add-note] Success for contactId ${contactId}`);
          return res.json({
            success: true,
            contactId,
            note: {
              date: timestamp,
              content: `${author}: ${note.trim()}`,
            },
            ...data,
          });
        } catch (liveError) {
          const errorMessage = liveError instanceof Error ? liveError.message : "Unknown error";
          console.error(`[add-note] Live update failed for contactId ${contactId}:`, errorMessage);
          return res.status(500).json({
            error: "Failed to add note",
            message: errorMessage,
          });
        }
      } else {
        // Mock mode - update by index
        const contact = mockContacts[contactId - 1];
        if (!contact) {
          return res.status(404).json({ error: "Contact not found", contactId });
        }

        const newNote = {
          date: timestamp,
          content: `${author}: ${note.trim()}`,
        };

        if (!contact.notes) {
          contact.notes = [];
        }
        contact.notes.unshift(newNote);
        contact.lastContact = timestamp.split("T")[0];

        return res.json({ success: true, contactId, note: newNote });
      }
    } catch (error) {
      console.error("Error adding note:", error);
      return res.status(500).json({ error: "Failed to add note" });
    }
  });

  // Create email reminder for a contact
  // Stores in SQLite database, cron job sends emails when due
  app.post("/api/reminders", async (req, res) => {
    try {
      const {
        contactId,
        contactName,
        createdByEmail,
        reminderText,
        reminderDateTime,
        secondReminderDateTime,
      } = req.body;

      // Validate required fields
      if (contactId === undefined || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }
      if (!contactName || typeof contactName !== "string" || contactName.trim() === "") {
        return res.status(400).json({ error: "contactName is required" });
      }
      if (!createdByEmail || typeof createdByEmail !== "string" || !createdByEmail.includes("@")) {
        return res.status(400).json({ error: "valid createdByEmail is required" });
      }
      if (!reminderText || typeof reminderText !== "string" || reminderText.trim() === "") {
        return res.status(400).json({ error: "reminderText is required" });
      }
      if (!reminderDateTime || typeof reminderDateTime !== "string") {
        return res.status(400).json({ error: "reminderDateTime is required" });
      }

      // Validate reminderDateTime is in the future
      const reminderDate = new Date(reminderDateTime);
      if (isNaN(reminderDate.getTime())) {
        return res.status(400).json({ error: "reminderDateTime must be a valid ISO date string" });
      }
      if (reminderDate <= new Date()) {
        return res.status(400).json({ error: "reminderDateTime must be in the future" });
      }

      // Validate secondReminderDateTime if provided
      if (secondReminderDateTime) {
        const secondDate = new Date(secondReminderDateTime);
        if (isNaN(secondDate.getTime())) {
          return res.status(400).json({ error: "secondReminderDateTime must be a valid ISO date string" });
        }
        if (secondDate >= reminderDate) {
          return res.status(400).json({ error: "secondReminderDateTime must be before reminderDateTime" });
        }
      }

      console.log(`[create-reminder] Creating reminder for contactId ${contactId}`, {
        contactName,
        createdByEmail,
        reminderDateTime,
        hasSecondReminder: !!secondReminderDateTime,
      });

      // Create reminder in SQLite database
      const result = createReminderInDb({
        contactId,
        contactName: contactName.trim(),
        createdByEmail: createdByEmail.trim(),
        reminderText: reminderText.trim(),
        reminderDateTime,
        secondReminderDateTime: secondReminderDateTime || undefined,
      });

      console.log(`[create-reminder] Success for contactId ${contactId}: id=${result.id}`);

      return res.json({
        success: true,
        id: result.id,
        secondReminderId: result.secondId,
        _source: "app",
      });
    } catch (error) {
      console.error("Error creating reminder:", error);
      return res.status(500).json({ error: "Failed to create reminder" });
    }
  });

  // Get reminder stats (monitoring endpoint)
  app.get("/api/reminders/stats", async (_req, res) => {
    try {
      const stats = getReminderStats();
      return res.json(stats);
    } catch (error) {
      console.error("Error getting reminder stats:", error);
      return res.status(500).json({ error: "Failed to get reminder stats" });
    }
  });

  // ============================================================================
  // Task Ownership API Endpoints
  // ============================================================================

  // Staff list cache (5 minute TTL)
  let staffListCache: { staff: string[]; timestamp: number } | null = null;
  const STAFF_LIST_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Assign contact to staff member
  // Updates Excel "Assigned To" column via n8n webhook
  app.post("/api/assign-contact", async (req, res) => {
    try {
      const { contactId, assignedTo } = req.body;

      // Validate contactId
      if (contactId === undefined || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }

      // Validate assignedTo is valid email or null
      if (assignedTo !== null && assignedTo !== undefined) {
        if (typeof assignedTo !== "string") {
          return res.status(400).json({ error: "assignedTo must be a string (email) or null" });
        }
        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (assignedTo.trim() !== "" && !emailRegex.test(assignedTo)) {
          return res.status(400).json({ error: "assignedTo must be a valid email address" });
        }
      }

      console.log(`[assign-contact] Assigning contactId ${contactId} to ${assignedTo || "unassigned"}`);

      if (DATA_MODE === "live") {
        try {
          const payload = {
            contactId,
            assignedTo: assignedTo || null,
          };

          console.log(`[assign-contact] Calling n8n with payload:`, payload);

          const response = await fetch(N8N_ENDPOINTS.assignContact, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          const responseText = await response.text();
          console.log(`[assign-contact] n8n response:`, {
            status: response.status,
            body: responseText.substring(0, 200),
          });

          if (!response.ok) {
            console.error(`[assign-contact] n8n returned ${response.status}: ${responseText}`);
            return res.status(502).json({
              error: "Assignment failed",
              message: `n8n returned ${response.status}: ${response.statusText}`,
              details: responseText.substring(0, 200),
            });
          }

          // Parse response if JSON
          let data = {};
          try {
            data = JSON.parse(responseText);
          } catch {
            // Response might not be JSON - that's OK
          }

          // Invalidate caches since assignments changed
          staffListCache = null;
          boardCache = null; // CRITICAL: Clear board cache so next fetch gets fresh data

          console.log(`[assign-contact] Success for contactId ${contactId}`);
          return res.json({
            success: true,
            contactId,
            assignedTo: assignedTo || null,
            ...data,
          });
        } catch (liveError) {
          const errorMessage = liveError instanceof Error ? liveError.message : "Unknown error";
          console.error(`[assign-contact] Live update failed for contactId ${contactId}:`, errorMessage);
          return res.status(500).json({
            error: "Assignment failed",
            message: errorMessage,
          });
        }
      } else {
        // Mock mode - update by index
        const contact = mockContacts[contactId - 1];
        if (!contact) {
          return res.status(404).json({ error: "Contact not found", contactId });
        }
        contact.assignedTo = assignedTo || undefined;
        return res.json({ success: true, contactId, assignedTo: assignedTo || null });
      }
    } catch (error) {
      console.error("Error assigning contact:", error);
      return res.status(500).json({ error: "Failed to assign contact" });
    }
  });

  // Get list of known staff from existing assignments
  // Returns unique non-null assignedTo values from board data
  app.get("/api/staff-list", async (_req, res) => {
    try {
      // Check cache first
      if (staffListCache) {
        const age = Date.now() - staffListCache.timestamp;
        if (age < STAFF_LIST_CACHE_TTL_MS) {
          console.log(`[staff-list] Cache hit (age: ${Math.round(age / 1000)}s)`);
          return res.json({ staff: staffListCache.staff });
        }
        console.log("[staff-list] Cache expired, refreshing");
      }

      // Get board data (use cache if available)
      let contacts: Array<{ assignedTo?: string | null; [key: string]: unknown }> = [];
      const cachedBoard = getBoardFromCache();

      if (cachedBoard) {
        contacts = cachedBoard.contacts;
      } else if (DATA_MODE === "live") {
        try {
          console.log("[staff-list] FINAL FETCH URL =", WAITLIST_BOARD_URL);
          const response = await fetch(WAITLIST_BOARD_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });

          if (response.ok) {
            const data = await response.json();
            contacts = data.contacts || [];
            setBoardCache({ contacts: data.contacts });
          }
        } catch (error) {
          console.warn("[staff-list] Failed to fetch board data:", error);
        }
      } else {
        // Mock mode
        contacts = mockContacts;
      }

      // Extract unique non-null assignedTo values
      const staffSet = new Set<string>();
      for (const contact of contacts) {
        if (contact.assignedTo && typeof contact.assignedTo === "string" && contact.assignedTo.trim() !== "") {
          staffSet.add(contact.assignedTo.trim());
        }
      }

      // Sort alphabetically
      const staff = Array.from(staffSet).sort((a, b) => a.localeCompare(b));

      // Update cache
      staffListCache = { staff, timestamp: Date.now() };

      console.log(`[staff-list] Returning ${staff.length} staff members`);
      return res.json({ staff });
    } catch (error) {
      console.error("Error fetching staff list:", error);
      return res.status(500).json({ error: "Failed to fetch staff list" });
    }
  });

  return httpServer;
}
