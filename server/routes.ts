import type { Express } from "express";
import { createServer, type Server } from "http";
import {
  createReminder as createReminderInDb,
  getReminderStats,
  getIntakeComments,
  createIntakeComment,
  getActiveAttentionFlags,
  clearAttentionFlag,
  getAllCrmProviders,
  getCrmProviderById,
  createCrmProvider,
  updateCrmProvider,
  getAllProviderOverrides,
  getProviderOverride,
  upsertProviderOverride,
  getAllProviderAvailability,
  upsertProviderAvailability,
  type ProviderAvailability,
} from "./reminders";
import {
  getTnRecord,
  createTnRecord,
  updateTnStatus,
  resetTnLink,
  resetTnRecordForRetry,
  isStaleInProgress,
} from "./therapy-notes";
import type { TnAgentPayload, TnAgentResponse } from "./therapy-notes";
import { saveEmailSnapshot, getEmailSnapshot, getSnapshotsForContact } from "./email-snapshots";
import { createAssignment, getAssignmentsByContact, deleteAssignment, getLatestAssignmentsByAllContacts } from "./assignments/db";
import {
  syncContacts as syncContactsToDb,
  recordSyncError,
  getAllSyncContacts,
  getSyncContactById,
  getSyncMeta,
  getSyncStaffList,
  getSyncContactCount,
  updateSyncContactStatus,
  updateSyncContactAssignment,
  appendSyncContactNote,
  removeSyncContactNote,
  getSubmissionById,
  getHouseholdMembers,
  enrichSyncContact,
  upsertSingleContact,
  generateIntakeContactId,
  insertIntakeContact,
  insertFormSubmission,
  getRecentSubmissions,
  getSubmissionsForContact,
  insertSubmission,
  normalizeDateValue,
  insertMigrationContacts,
  mergeMigrationContacts,
  fullSyncMigrationContacts,
  updateContactIntakeFields,
  updateContactIdentity,
  deleteSyncContact,
  getWaitlistExportData,
  WAITLIST_EXPORT_COLUMNS,
  type SyncPayloadContact,
  type MigrationContact,
} from "./sync/db";
import {
  logActivity,
  logStatusChange,
  getRecentActivity,
  getStaffActivitySummary,
  getActivityForContact,
  getStatusDurations,
} from "./activity/db";
import { isRestrictedUser, canAccessReferralUpload } from "@shared/access-control";
import { getStatusLabel } from "@shared/status-codes";
import { extractReferralData } from "./referral/extract";
import * as XLSX from "xlsx";
import * as path from "path";
import { z } from "zod";

// Configuration for mock vs live data mode
// Change to "live" to use real n8n webhooks instead of mock data
type DataMode = "mock" | "live";
const DATA_MODE: DataMode = "live";

// ============================================================================
// Read Source Configuration
// ============================================================================
// "auto": Use sync (SQLite) if data exists, fall back to n8n
// "sync": Always use SQLite (fastest, requires active n8n sync job)
// "n8n": Always use n8n webhooks (legacy behavior)
type ReadSource = "auto" | "sync" | "n8n";
const READ_SOURCE: ReadSource = (process.env.READ_SOURCE as ReadSource) || "auto";

// Shared secret for n8n sync endpoint authentication (no default — must be set per environment)
const SYNC_API_KEY = process.env.SYNC_API_KEY || "";

// Shared secret for the standalone Fly.io provider availability form. The form
// POSTs to /api/provider-availability with this key in the X-Provider-Form-Key
// header. Empty in this environment → endpoint returns 503.
const PROVIDER_FORM_API_KEY = process.env.PROVIDER_FORM_API_KEY || "";

/**
 * Check if we should read from sync cache.
 * Returns true if sync cache has data and READ_SOURCE allows it.
 */
async function shouldReadFromSync(): Promise<boolean> {
  if (READ_SOURCE === "n8n") return false;
  if (READ_SOURCE === "sync") return true;
  // "auto": use sync if it has enough data (>= 50 rows prevents partial-cache issues)
  // Exception: if n8n is disabled, always prefer sync (even with few rows)
  try {
    const count = await getSyncContactCount();
    if (isN8nDisabled(WAITLIST_BOARD_URL)) {
      return count > 0;
    }
    if (count > 0 && count < 50) {
      console.log(`[sync] Cache has only ${count} rows — falling back to n8n (minimum 50 required)`);
      return false;
    }
    return count >= 50;
  } catch {
    return false;
  }
}

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
const MONTH_NAMES_MAP: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Validate and return YYYY-MM-DD or null. */
function toValidIsoDate(s: string): string | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, yr, mo, dy] = m;
  const y = parseInt(yr, 10), mon = parseInt(mo, 10), day = parseInt(dy, 10);
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  const d = new Date(y, mon - 1, day);
  if (d.getFullYear() !== y || d.getMonth() !== mon - 1 || d.getDate() !== day) return null;
  return s;
}

function normalizeExcelDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const s = String(value).trim();
  if (s === "") return null;

  // Strip datetime suffix: "2025-01-05T00:00:00Z" → "2025-01-05"
  const isoDatetime = s.match(/^(\d{4}-\d{2}-\d{2})[T ]/);
  if (isoDatetime) return toValidIsoDate(isoDatetime[1]);

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return toValidIsoDate(s);

  // YYYY/MM/DD → YYYY-MM-DD
  const slashIso = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashIso) return toValidIsoDate(`${slashIso[1]}-${slashIso[2]}-${slashIso[3]}`);

  // M/D/YYYY or MM/DD/YYYY
  const usDate = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usDate) {
    const mo = usDate[1].padStart(2, "0");
    const dy = usDate[2].padStart(2, "0");
    return toValidIsoDate(`${usDate[3]}-${mo}-${dy}`);
  }

  // Written month: "January 5, 2025" or "Jan 5, 2025"
  const written = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (written) {
    const monthIdx = MONTH_NAMES_MAP[written[1].toLowerCase()];
    if (monthIdx !== undefined) {
      const mo = String(monthIdx + 1).padStart(2, "0");
      const dy = written[2].padStart(2, "0");
      return toValidIsoDate(`${written[3]}-${mo}-${dy}`);
    }
  }

  // Numeric Excel serial (string or number input)
  const num = typeof value === "number" ? value : parseFloat(s);
  if (!isNaN(num) && num > 15000 && num < 80000) {
    return excelSerialToIso(num);
  }

  // Unrecognized — return null (caller can use reconstruction fallback)
  return null;
}

/** Reconstruct dateAdded from daysOnWaitlist when source date is missing. */
function deriveDateAddedFromDays(daysOnWaitlist: unknown): string | null {
  if (daysOnWaitlist === null || daysOnWaitlist === undefined) return null;
  const days = Number(daysOnWaitlist);
  if (isNaN(days) || days < 0) return null;
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString().split("T")[0];
}

/** Compute days waiting dynamically from dateAdded, falling back to static daysOnWaitlist. */
function computeDaysWaitingServer(dateAdded: string | null | undefined, fallback?: number | null): number {
  if (dateAdded) {
    const isoMatch = dateAdded.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const usMatch = dateAdded.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    let added: Date | null = null;
    if (isoMatch) {
      added = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    } else if (usMatch) {
      added = new Date(Number(usMatch[3]), Number(usMatch[1]) - 1, Number(usMatch[2]));
    }
    if (added && !isNaN(added.getTime())) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const addedDay = new Date(added.getFullYear(), added.getMonth(), added.getDate());
      const diffMs = today.getTime() - addedDay.getTime();
      if (diffMs < 0) return 0;
      return Math.floor(diffMs / (1000 * 60 * 60 * 24));
    }
  }
  return fallback ?? 0;
}

function normalizeOrReconstructDateAdded(
  dateValue: unknown,
  daysOnWaitlist: unknown,
  contactId?: number
): string | null {
  const normalized = normalizeExcelDate(dateValue);
  if (normalized) return normalized;
  const reconstructed = deriveDateAddedFromDays(daysOnWaitlist);
  if (reconstructed && contactId !== undefined) {
    console.warn(`[date-fix] reconstructed dateAdded for contact ${contactId} from daysOnWaitlist=${String(daysOnWaitlist)}`);
  }
  return reconstructed;
}

function excelSerialToIso(serial: number): string {
  // Excel epoch is Dec 30, 1899
  const excelEpoch = new Date(1899, 11, 30);
  const date = new Date(excelEpoch.getTime() + serial * 24 * 60 * 60 * 1000);
  // Return as YYYY-MM-DD
  return date.toISOString().split("T")[0];
}

function excelSerialToMMDDYYYY(serial: number): string {
  const excelEpoch = new Date(1899, 11, 30);
  const jsDate = new Date(excelEpoch.getTime() + serial * 86400000);
  const mm = String(jsDate.getMonth() + 1).padStart(2, "0");
  const dd = String(jsDate.getDate()).padStart(2, "0");
  const yyyy = jsDate.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

// ============================================================================
// n8n URLs — ALL driven by environment variables for staging isolation
// ============================================================================
const WAITLIST_BOARD_URL = process.env.N8N_GET_WAITLIST_BOARD_URL || "https://n8n-familyconnection.agentglu.agency/webhook/get-waitlist-board";
const WAITLIST_SUMMARY_URL = process.env.N8N_GET_WAITLIST_SUMMARY_URL || "https://n8n-familyconnection.agentglu.agency/webhook/get-waitlist-summary";

const N8N_ENDPOINTS = {
  contactSnapshot: process.env.N8N_GET_CONTACT_SNAPSHOT_URL || "https://n8n-familyconnection.agentglu.agency/webhook/get-contact-snapshot",
  updateStatus: process.env.N8N_UPDATE_CONTACT_STATUS_URL || "https://n8n-familyconnection.agentglu.agency/webhook/update-contact-status",
  addNote: process.env.N8N_ADD_CONTACT_NOTE_URL || "https://n8n-familyconnection.agentglu.agency/webhook/add-contact-note",
  assignContact: process.env.N8N_ASSIGN_CONTACT_URL || "https://n8n-familyconnection.agentglu.agency/webhook/assign-contact",
  unassignContact: process.env.N8N_UNASSIGN_CONTACT_URL || "https://n8n-familyconnection.agentglu.agency/webhook/f4414c29-2ae4-4ca3-b400-d6da62ff7812",
} as const;

function isN8nDisabled(url: string): boolean {
  return !url || url === "disabled" || url.startsWith("http://localhost:1");
}

async function safeFetchN8n(
  url: string,
  label: string,
  options: RequestInit,
): Promise<Response | null> {
  if (isN8nDisabled(url)) {
    console.warn(`[staging] Skipping n8n call: ${label} (URL disabled or not configured)`);
    return null;
  }
  return fetch(url, options);
}

// TherapyNotes integration constants
const TN_ALLOWED_EMAILS = [
  "raunek@tfc.health",
  "dawn@tfc.health",
  "amanda@tfc.health",
  "chantel@tfc.health",
  "jmontano@tfc.health",
  "lsego@tfc.health",
  "sandra@tfc.health",
];
const TN_AGENT_URL =
  process.env.TN_AGENT_URL || "https://axiom-browser-agent-clone-production.up.railway.app/api/tn/create-patient";

function parseName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: parts[0] || "", lastName: "" };
  const lastName = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(" ");
  return { firstName, lastName };
}

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
    patientDob: c.patientDob || undefined,
  }));
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Feature gate: block restricted users from Insights & Providers APIs
  const GATED_API_PREFIXES = ["/api/providers", "/api/get-waitlist-summary", "/api/export/insights"];
  app.use((req, res, next) => {
    const email = (req as any).user?.email;
    if (email && isRestrictedUser(email) && GATED_API_PREFIXES.some((p) => req.path.startsWith(p))) {
      return res.status(403).json({ error: "Access denied" });
    }
    next();
  });

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

      console.log(`[contact-snapshot] Fetching contact by ID: ${contactId}, READ_SOURCE: ${READ_SOURCE}`);

      // Hybrid path: Use sync for board data, enrich with n8n for detailed fields
      if (await shouldReadFromSync()) {
        const syncContact = await getSyncContactById(contactId);
        if (syncContact) {
          const hasDetailedData = syncContact.lastNote || syncContact.email;

          if (hasDetailedData) {
            // Fire-and-forget: re-enrich if cache is older than 5 minutes
            const cacheAge = Date.now() - new Date(syncContact.syncedAt + "Z").getTime();
            if (cacheAge > 300_000) {
              (async () => {
                try {
                  const resp = await fetch(N8N_ENDPOINTS.contactSnapshot, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ contactId }),
                  });
                  if (resp.ok) {
                    const raw = await resp.json();
                    const detailed = (raw.contact || raw || {}) as Record<string, unknown>;
                    await enrichSyncContact(contactId, detailed);
                    console.log(`[contact-snapshot] Background re-enriched stale contact ${contactId}`);
                  }
                } catch { /* fire-and-forget */ }
              })();
            }

            // Sync cache has detailed data — serve immediately
            const statusCode = syncContact.statusCode ?? 100;
            const umbrella = statusCode >= 100 && statusCode < 200 ? "WL"
              : statusCode >= 200 && statusCode < 300 ? "PS"
              : statusCode >= 300 && statusCode < 400 ? "PMR"
              : statusCode >= 400 && statusCode < 500 ? "INS"
              : "unknown";

            const notes = parseNotesFromLastNote(syncContact.lastNote || undefined);
            console.log(`[contact-snapshot] Serving ${syncContact.name} from enriched sync cache`);
            return res.json({
              ...syncContact,
              statusCode,
              umbrella,
              status: syncContact.status || "intake",
              serviceRequested: syncContact.serviceRequested || "Unknown",
              daysOnWaitlist: computeDaysWaitingServer(syncContact.dateAdded, syncContact.daysOnWaitlist),
              patientDob: normalizeExcelDate(syncContact.patientDob),
              dateAdded: normalizeOrReconstructDateAdded(syncContact.dateAdded, syncContact.daysOnWaitlist, syncContact.contactId),
              notes,
              _source: "sync",
            });
          }

          // Sync has board data but no detailed data — fetch from n8n and enrich
          console.log(`[contact-snapshot] Sync cache has ${syncContact.name} but missing detail fields, enriching from n8n`);
          try {
            const snapshotResponse = await fetch(N8N_ENDPOINTS.contactSnapshot, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contactId }),
            });

            if (snapshotResponse.ok) {
              const rawData = await snapshotResponse.json();
              const detailed = (rawData.contact || rawData || {}) as Record<string, unknown>;

              // Enrich sync cache for next time (fire-and-forget)
              try { await enrichSyncContact(contactId, detailed); } catch (e) {
                console.warn(`[contact-snapshot] Failed to enrich sync cache:`, e);
              }

              // Build response merging sync board data + n8n detailed data
              const statusCode = syncContact.statusCode ?? 100;
              const umbrella = statusCode >= 100 && statusCode < 200 ? "WL"
                : statusCode >= 200 && statusCode < 300 ? "PS"
                : statusCode >= 300 && statusCode < 400 ? "PMR"
                : statusCode >= 400 && statusCode < 500 ? "INS"
                : "unknown";

              const assignedTo = (() => {
                const raw = (detailed.assignedTo as string)
                  || (detailed["Admin Assigned To Contact"] as string)
                  || syncContact.assignedTo
                  || null;
                return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
              })();

              const merged = {
                contactId: syncContact.contactId,
                name: syncContact.name,
                email: (detailed.email as string) || null,
                phone: (detailed.phone as string) || null,
                requestingFor: (detailed.requestingFor as string) || null,
                reasonForSeeking: (detailed.reasonForSeeking as string) || null,
                reasonForTherapy: (detailed.reasonForTherapy as string)
                  || (detailed["Reason for Therapy MCQ"] as string)
                  || (detailed.reasonForTherapyMCQ as string)
                  || (detailed["Reason for Therapy"] as string)
                  || null,
                detailedReason: (detailed.detailedReason as string) || (detailed.DetailedReason as string) || null,
                formCompletedBy: (detailed.formCompletedBy as string) || null,
                modality: (detailed.modality as string) || null,
                referralSource: (detailed.referralSource as string) || null,
                priorServices: (detailed.priorServices as string) || null,
                priorProvider: (detailed.priorProvider as string) || null,
                insurancePayer: (detailed.insurancePayer as string) || (detailed.insurance as string) || null,
                insurancePlan: (detailed.insurancePlan as string) || (detailed.planName as string) || null,
                insuranceId: (detailed.insuranceId as string) || (detailed.memberId as string) || null,
                insuranceStatus: (detailed.insuranceStatus as string) || null,
                referralAuth: (detailed.referralAuth as string) || null,
                referralStatus: (detailed.referralStatus as string) || null,
                patientDob: normalizeExcelDate(detailed.patientDob || detailed.dob || detailed.dateOfBirth),
                gender: (detailed.gender as string) || (detailed.sex as string) || null,
                age: typeof detailed.age === "number" ? detailed.age : null,
                streetAddress: (detailed.streetAddress as string) || (detailed.address as string) || null,
                city: (detailed.city as string) || null,
                state: (detailed.state as string) || null,
                zipCode: (detailed.zipCode as string) || (detailed.zip as string) || null,
                county: (detailed.county as string) || null,
                preferredContact: (detailed.preferredContact as string) || null,
                custody: (detailed.custody as string) || null,
                flags: (detailed.flags as string) || null,
                priority: (detailed.priority as string) || null,
                rfsLink: (detailed.rfsLink as string) || (detailed.rfs as string) || null,
                documentLink: (detailed.documentLink as string) || (detailed.documents as string) || null,
                intakeSource: syncContact.intakeSource,
                statusCode,
                umbrella,
                status: syncContact.status || "intake",
                serviceRequested: syncContact.serviceRequested || "Unknown",
                daysOnWaitlist: computeDaysWaitingServer(syncContact.dateAdded, syncContact.daysOnWaitlist),
                dateAdded: normalizeOrReconstructDateAdded(syncContact.dateAdded, syncContact.daysOnWaitlist, syncContact.contactId),
                lastContact: normalizeExcelDate(detailed.lastContact),
                assignedTo,
                notes: parseNotesFromLastNote(detailed.lastNote as string | undefined),
                _source: "sync+n8n",
              };

              console.log(`[contact-snapshot] Returning enriched data for ${syncContact.name}`);
              return res.json(merged);
            }
          } catch (enrichError) {
            console.warn(`[contact-snapshot] n8n enrichment failed, serving board-only sync data:`, enrichError);
          }

          // Fallback: serve sync data even without detailed fields
          const statusCode = syncContact.statusCode ?? 100;
          const umbrella = statusCode >= 100 && statusCode < 200 ? "WL"
            : statusCode >= 200 && statusCode < 300 ? "PS"
            : statusCode >= 300 && statusCode < 400 ? "PMR"
            : statusCode >= 400 && statusCode < 500 ? "INS"
            : "unknown";
          return res.json({
            ...syncContact,
            statusCode,
            umbrella,
            status: syncContact.status || "intake",
            serviceRequested: syncContact.serviceRequested || "Unknown",
            daysOnWaitlist: computeDaysWaitingServer(syncContact.dateAdded, syncContact.daysOnWaitlist),
            dateAdded: normalizeOrReconstructDateAdded(syncContact.dateAdded, syncContact.daysOnWaitlist, syncContact.contactId),
            notes: [],
            _source: "sync",
          });
        }
        console.log(`[contact-snapshot] Contact ${contactId} not found in sync cache, falling through to n8n`);
      }

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
            daysOnWaitlist: computeDaysWaitingServer(contact.dateAdded as string | null, contact.daysOnWaitlist as number | null),
            dateAdded: normalizeOrReconstructDateAdded(contact.dateAdded, contact.daysOnWaitlist, Number(contact.contactId)),
            lastContact: normalizeExcelDate(detailed.lastContact),

            // Assignment and notes
            // Check multiple sources: n8n snapshot, board data (may have different field names)
            // Normalize: trim whitespace, convert empty string to null
            assignedTo: (() => {
              const raw = (detailed.assignedTo as string)
                || (detailed["Admin Assigned To Contact"] as string)
                || (contact.assignedTo as string)
                || (contact["Admin Assigned To Contact"] as string)
                || null;
              return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
            })(),
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
   *
   * CONTEXTUAL SIGNATURE DETECTION:
   * Only extracts initials when they appear in clear signature-like patterns.
   *
   * DOES extract: "-EB-", "...waitlist. DP", "...process. AC\", "...email, DP"
   * Does NOT extract: "...in TN." (initials are part of sentence, period comes AFTER)
   *
   * Key insight: Real signatures have punctuation BEFORE initials, not after.
   */
  function extractTrailingInitials(text: string): { initials: string; cleanText: string } | null {
    const trimmed = text.trim();

    // Pattern 1: -INITIALS- format (e.g., -EB-)
    // Unambiguous signature pattern - always extract
    let match = trimmed.match(/\s*-([A-Z]{2,3})-\s*$/);
    if (match && isValidInitials(match[1])) {
      return {
        initials: match[1],
        cleanText: trimmed.slice(0, -match[0].length).trim()
      };
    }

    // Pattern 2: Sentence-ending punctuation + space + INITIALS (+ optional backslash)
    // Matches: "...on the waitlist. DP" or "...process! AC" or "...email. TN\"
    // Does NOT match: "...in TN." (period comes AFTER initials, not before)
    match = trimmed.match(/([.!?])\s+([A-Z]{2,3})\\?\s*$/);
    if (match && isValidInitials(match[2])) {
      // Keep the sentence-ending punctuation in cleanText
      return {
        initials: match[2],
        cleanText: trimmed.slice(0, trimmed.length - match[0].length + 1).trim()
      };
    }

    // Pattern 3: Comma + space + INITIALS at very end (no trailing punctuation)
    // Matches: "...scheduling, DP" or "...review, AC"
    // Does NOT match: "...in TN." (no comma before)
    match = trimmed.match(/,\s+([A-Z]{2,3})\s*$/);
    if (match && isValidInitials(match[1])) {
      return {
        initials: match[1],
        cleanText: trimmed.slice(0, -match[0].length).trim()
      };
    }

    // Pattern 4: INITIALS + backslash at end (common signature pattern in dataset)
    // Matches: "...follow up accordingly JN\" or "...on waitlist DP\"
    // The backslash confirms signature intent
    match = trimmed.match(/\s([A-Z]{2,3})\\$/);
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
    let firstCrmStart = -1;
    let lastCrmContentEnd = 0;

    while ((crmMatch = crmHeaderPattern.exec(lastNote)) !== null) {
      // Track where first CRM note starts (for legacy text before it)
      if (firstCrmStart === -1) {
        firstCrmStart = crmMatch.index;
      }

      const headerEnd = crmMatch.index + crmMatch[0].length;
      const nextCrmMatch = lastNote.slice(headerEnd).search(/\[([A-Z]{2,3})\s*\|/);
      const nextDoubleNewline = lastNote.slice(headerEnd).indexOf("\n\n");

      // Also look for standalone dates (without initials) as content boundary
      const standaloneDateMatch = lastNote.slice(headerEnd).search(/(?:^|[\\])\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);

      let contentEnd: number;
      if (nextCrmMatch >= 0 && nextDoubleNewline >= 0) {
        contentEnd = headerEnd + Math.min(nextCrmMatch, nextDoubleNewline);
      } else if (nextDoubleNewline >= 0) {
        contentEnd = headerEnd + nextDoubleNewline;
      } else if (nextCrmMatch >= 0) {
        contentEnd = headerEnd + nextCrmMatch;
      } else {
        // Look for legacy date patterns OR standalone dates after backslash
        const legacyDateMatch = lastNote.slice(headerEnd).search(/[A-Z]{2,3}\s+\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}/);
        if (legacyDateMatch >= 0) {
          contentEnd = headerEnd + legacyDateMatch;
        } else if (standaloneDateMatch >= 0) {
          contentEnd = headerEnd + standaloneDateMatch;
        } else {
          contentEnd = lastNote.length;
        }
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

    // Get legacy text - include text BEFORE first CRM note AND after last CRM content
    let legacyText: string;
    if (firstCrmStart > 0) {
      // There's text before the first CRM note - this is legacy text!
      const textBefore = lastNote.slice(0, firstCrmStart).trim();
      const textAfter = lastCrmContentEnd < lastNote.length ? lastNote.slice(lastCrmContentEnd).trim() : "";
      legacyText = [textBefore, textAfter].filter(Boolean).join(" ");
    } else if (lastCrmContentEnd > 0) {
      // CRM note at start, get text after
      legacyText = lastNote.slice(lastCrmContentEnd).trim();
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

    // Helper: Determine if a marker is a START marker (content follows) vs END marker (content precedes)
    // A marker is a START marker if:
    // 1. It's at the start of a line (after newline/backslash)
    // 2. It's followed by a colon (e.g., "DP 01/26/2026: content...")
    // 3. It comes after a sentence boundary (". " or "! " or "? ")
    function isStartMarker(matchIndex: number, matchLength: number): boolean {
      // Check what comes BEFORE the match
      const beforeText = legacyText.slice(Math.max(0, matchIndex - 20), matchIndex);
      const atLineStart = /(?:^|[\n\\])\s*$/.test(beforeText) || matchIndex === 0;
      const afterSentenceBoundary = /[.!?]\s+$/.test(beforeText);

      // Check what comes AFTER the match - colon indicates START marker
      const afterText = legacyText.slice(matchIndex + matchLength, matchIndex + matchLength + 3);
      const followedByColon = afterText.trimStart().startsWith(':');

      return atLineStart || followedByColon || afterSentenceBoundary;
    }

    // Pattern A: INITIALS + DATE + TIME
    const endMarkerPattern = /([A-Z]{2,3})\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)/g;
    while ((match = endMarkerPattern.exec(legacyText)) !== null) {
      if (!isTimeIndicator(match[1])) {
        markers.push({
          index: match.index,
          endIndex: match.index + match[0].length,
          date: match[2],
          normalizedDate: normalizeDate(match[2]),
          author: match[1],
          hasTime: true,
          isEndMarker: !isStartMarker(match.index, match[0].length),
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
          markers.push({
            index: match.index,
            endIndex: match.index + match[0].length,
            date: match[2],
            normalizedDate: normalizeDate(match[2]),
            author: match[1],
            hasTime: false,
            isEndMarker: !isStartMarker(match.index, match[0].length),
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

          markers.push({
            index: match.index,
            endIndex: match.index + match[0].length,
            date: match[2],
            normalizedDate: normalizeDate(match[2], inferredYear),
            author: match[1],
            hasTime: false,
            isEndMarker: !isStartMarker(match.index, match[0].length),
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
    console.log("[SUMMARY] READ_SOURCE:", READ_SOURCE);

    // Fast path: compute summary from sync cache
    if (await shouldReadFromSync()) {
      try {
        const contacts = await getAllSyncContacts();
        const activeContacts = contacts.filter((c) => {
          const sc = c.statusCode ?? 0;
          // Inactive: 103, 104, 203, 204, 205, 400+
          return ![103, 104, 203, 204, 205].includes(sc) && sc < 400;
        });

        const waitDays = activeContacts
          .map((c) => computeDaysWaitingServer(c.dateAdded, c.daysOnWaitlist))
          .filter((d) => d > 0);
        const avgWaitDays = waitDays.length > 0
          ? Math.round(waitDays.reduce((a, b) => a + b, 0) / waitDays.length)
          : 0;

        let longestWaitDays = 0;
        let longestWaitingName = "---";
        for (const c of activeContacts) {
          const d = computeDaysWaitingServer(c.dateAdded, c.daysOnWaitlist);
          if (d > longestWaitDays) {
            longestWaitDays = d;
            longestWaitingName = c.name;
          }
        }

        const over30Days = activeContacts.filter((c) => computeDaysWaitingServer(c.dateAdded, c.daysOnWaitlist) > 30).length;
        const over60Days = activeContacts.filter((c) => computeDaysWaitingServer(c.dateAdded, c.daysOnWaitlist) > 60).length;
        const readyToSchedule = contacts.filter((c) => {
          const sc = c.statusCode ?? 0;
          return sc >= 200 && sc < 203;
        }).length;
        const needsFollowUp = contacts.filter((c) => {
          const sc = c.statusCode ?? 0;
          return sc >= 300 && sc < 400;
        }).length;

        // Status breakdown
        const byStatus: Record<string, number> = {};
        for (const c of contacts) {
          const s = c.status || "unknown";
          byStatus[s] = (byStatus[s] || 0) + 1;
        }

        console.log(`[SUMMARY] Computed from ${contacts.length} sync contacts`);
        return res.json({
          totalActive: activeContacts.length,
          avgWaitDays,
          longestWaitDays,
          longestWaitingName,
          over30Days,
          over60Days,
          readyToSchedule,
          needsFollowUp,
          byStatus,
          _source: "sync",
        });
      } catch (syncError) {
        console.warn("[SUMMARY] Sync read failed, falling through to n8n:", syncError);
      }
    }

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
          console.error("[SUMMARY] Live data fetch failed:", liveError);
          return res.status(503).json({
            error: "Database temporarily unavailable. Please refresh in a moment.",
            _source: "error",
          });
        }
      } else {
        return res.status(503).json({
          error: "Database temporarily unavailable. Please refresh in a moment.",
          _source: "error",
        });
      }
    } catch (error) {
      console.error("Error fetching waitlist summary:", error);
      return res.status(503).json({
        error: "Database temporarily unavailable. Please refresh in a moment.",
        _source: "error",
      });
    }
  });

  // Get all waitlist contacts (for Today page priority queues)
  // Uses the board endpoint to ensure contactId is always present
  app.get("/api/waitlist-contacts", async (_req, res) => {
    console.log("[WAITLIST-CONTACTS] === REQUEST START ===");
    console.log("[WAITLIST-CONTACTS] DATA_MODE:", DATA_MODE, "READ_SOURCE:", READ_SOURCE);

    // Fast path: read from sync cache
    if (await shouldReadFromSync()) {
      try {
        const contacts = (await getAllSyncContacts()).map((c) => ({
          ...c,
          dateAdded: normalizeOrReconstructDateAdded(c.dateAdded, c.daysOnWaitlist, c.contactId),
        }));
        console.log(`[WAITLIST-CONTACTS] Serving ${contacts.length} contacts from sync cache`);
        // Populate board cache for backward compat (contact-snapshot lookups)
        setBoardCache({ contacts: contacts as any[] });
        return res.json({ contacts, _source: "sync" });
      } catch (syncError) {
        console.warn("[WAITLIST-CONTACTS] Sync read failed, falling through to n8n:", syncError);
      }
    }

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
                
                // Normalize or reconstruct dateAdded when possible
                const dateAdded = normalizeOrReconstructDateAdded(c.dateAdded, c.daysOnWaitlist, Number(c.contactId));

                // Normalize assignedTo: trim whitespace, convert empty string to null
                const assignedTo = typeof c.assignedTo === "string" && c.assignedTo.trim() !== ""
                  ? c.assignedTo.trim()
                  : null;

                // Normalize patientDob from Excel serial if needed
                const patientDob = normalizeExcelDate(c.patientDob || c.dob || c.dateOfBirth) || undefined;

                return {
                  ...c,
                  assignedTo: assignedTo || undefined, // null → undefined for optional field
                  insurancePayer: insurancePayer ? String(insurancePayer).trim() : undefined, // Convert null to undefined for optional field
                  modality: modality ? String(modality).trim() : undefined, // Convert null to undefined for optional field
                  dateAdded: dateAdded || null, // Normalized date (YYYY-MM-DD) or null
                  patientDob, // Normalized DOB (YYYY-MM-DD) or undefined
                };
              });

            console.log("[WAITLIST-CONTACTS] Valid contacts after filtering:", validContacts.length, "out of", data.contacts.length);

            // Deduplicate by contactId (keep first occurrence)
            // Protects against n8n returning the same contact multiple times
            const seenIds = new Map<number, boolean>();
            const dedupedContacts = validContacts.filter((c: any) => {
              if (seenIds.has(c.contactId)) return false;
              seenIds.set(c.contactId, true);
              return true;
            });
            if (dedupedContacts.length < validContacts.length) {
              console.warn(`[WAITLIST-CONTACTS] Deduplicated ${validContacts.length - dedupedContacts.length} duplicate contacts by contactId`);
            }

            // Populate server-side cache for contact-snapshot lookups
            // This reduces duplicate n8n calls when navigating from Today to Contact Detail
            setBoardCache({ contacts: dedupedContacts });

            console.log("[WAITLIST-CONTACTS] Returning live data with _source:", source, "and", dedupedContacts.length, "contacts");
            return res.json({ contacts: dedupedContacts, _source: source });
          } else {
            console.error("[WAITLIST-CONTACTS] Invalid data structure - contacts is not an array");
            console.error("[WAITLIST-CONTACTS] data.contacts type:", typeof data.contacts, "value:", data.contacts);
            // If contacts array is missing or empty, that's still valid data (just means no contacts)
            // Only fall back if the structure is completely wrong
            if (data.contacts === undefined) {
              console.error("[WAITLIST-CONTACTS] No contacts field in n8n response");
              return res.status(503).json({
                error: "Database temporarily unavailable. Please refresh in a moment.",
                _source: "error",
              });
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
          console.error("[WAITLIST-CONTACTS] All data sources failed");
          return res.status(503).json({
            error: "Database temporarily unavailable. Please refresh in a moment.",
            _source: "error",
          });
        }
      } else {
        return res.status(503).json({
          error: "Database temporarily unavailable. Please refresh in a moment.",
          _source: "error",
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[WAITLIST-CONTACTS] Unexpected error:", errorMessage);
      return res.status(500).json({ error: "Failed to fetch waitlist contacts" });
    }
  });

  // Enrich contacts with latest assigned provider name from CRM assignments table
  async function enrichContactsWithProvider(contacts: any[]): Promise<any[]> {
    try {
      const providerMap = await getLatestAssignmentsByAllContacts();
      return contacts.map((c: any) => ({
        ...c,
        assignedProviderName: c.contactId ? (providerMap.get(c.contactId) ?? null) : null,
      }));
    } catch (err) {
      console.warn("[BOARD] Failed to enrich contacts with provider assignments:", err);
      return contacts;
    }
  }

  // Get waitlist board (contact rows for Kanban - uses dedicated live endpoint)
  app.post("/api/get-waitlist-board", async (_req, res) => {
    console.log("[BOARD] === REQUEST START ===");
    console.log("[BOARD] DATA_MODE:", DATA_MODE, "READ_SOURCE:", READ_SOURCE);

    // Fast path: read from sync cache
    if (await shouldReadFromSync()) {
      try {
        const contacts = await getAllSyncContacts();
        console.log(`[BOARD] Serving ${contacts.length} contacts from sync cache`);
        const enrichedContacts = await enrichContactsWithProvider(contacts as any[]);
        setBoardCache({ contacts: enrichedContacts });
        return res.json({ contacts: enrichedContacts, _source: "sync" });
      } catch (syncError) {
        console.warn("[BOARD] Sync read failed, falling through to n8n:", syncError);
      }
    }

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

            // Normalize assignedTo: trim whitespace, convert empty string to null
            data.contacts = data.contacts.map((c: any) => ({
              ...c,
              assignedTo: typeof c.assignedTo === "string" && c.assignedTo.trim() !== ""
                ? c.assignedTo.trim()
                : null,
            }));

            // Deduplicate by contactId (keep first occurrence)
            // Protects against n8n returning the same contact multiple times
            const beforeCount = data.contacts.length;
            const seenBoardIds = new Map<number, boolean>();
            data.contacts = data.contacts.filter((c: any) => {
              if (c.contactId === undefined || c.contactId === null) return true; // keep contacts without id (logged above)
              if (seenBoardIds.has(c.contactId)) return false;
              seenBoardIds.set(c.contactId, true);
              return true;
            });
            if (data.contacts.length < beforeCount) {
              console.warn(`[BOARD] Deduplicated ${beforeCount - data.contacts.length} duplicate contacts by contactId`);
            }

            // Enrich with provider assignments
            data.contacts = await enrichContactsWithProvider(data.contacts);

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
          console.error("[BOARD] All data sources failed:", liveError);
          return res.status(503).json({
            error: "Database temporarily unavailable. Please refresh in a moment.",
            _source: "error",
          });
        }
      } else {
        return res.status(503).json({
          error: "Database temporarily unavailable. Please refresh in a moment.",
          _source: "error",
        });
      }
    } catch (error) {
      console.error("Error fetching waitlist board:", error);
      return res.status(503).json({
        error: "Database temporarily unavailable. Please refresh in a moment.",
        _source: "error",
      });
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
        // Write-through: update sync cache first for instant UI feedback
        const prev = await getSyncContactById(contactId);
        try {
          await updateSyncContactStatus(contactId, statusCode, getStatusLabel(statusCode));
          console.log(`[update-status] Sync cache updated for contactId ${contactId}`);
        } catch (e) {
          // Cache failure is non-fatal — n8n sync will reconcile.
          console.warn(`[update-status] Failed to update sync cache:`, e);
        }

        // Status logging is hardened: errors propagate to the route handler,
        // which surfaces a 500 to the caller. status_changed events are the
        // only authoritative record of when a contact entered a status, so
        // silent drops would corrupt the time-in-status insights.
        await logStatusChange({
          actorEmail: (req as any).user?.email || "system",
          contactId,
          contactName: prev?.name || "",
          fromCode: prev?.statusCode ?? null,
          fromLabel: prev?.status ?? null,
          toCode: statusCode,
          toLabel: getStatusLabel(statusCode),
        });

        // Clear board cache so next read picks up the change
        boardCache = null;

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
            // Still return success since sync cache was updated — n8n sync will reconcile
            return res.json({ success: true, contactId, newStatus: statusCode, n8nError: true });
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
          console.error(`[update-status] n8n write failed for contactId ${contactId}:`, errorMessage);
          // Still return success — sync cache was already updated, n8n sync will reconcile
          return res.json({ success: true, contactId, newStatus: statusCode, n8nError: true });
        }
      } else {
        // Mock mode - update by index
        const contact = mockContacts[contactId - 1];
        if (!contact) {
          return res.status(404).json({ error: "Contact not found", contactId });
        }
        const label = getStatusLabel(statusCode);
        contact.status = label === "unknown" ? contact.status : label;
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
        const contact = await getSyncContactById(contactId);
        await appendSyncContactNote(contactId, note.trim(), author.trim(), timestamp);
        console.log(`[add-note] Sync cache updated for contactId ${contactId}`);

        try {
          await logActivity({
            type: "note_added",
            actorEmail: (req as any).user?.email || "system",
            entityType: "contact",
            entityId: String(contactId),
            entityName: contact?.name || "",
            metadata: { preview: note.trim().substring(0, 100) },
          });
        } catch (e) {
          console.warn(`[add-note] Activity log failed for contactId ${contactId} (non-blocking)`);
        }
        boardCache = null;

        // CRM write succeeded — return success immediately
        // n8n/Excel sync is fire-and-forget (side effect, not user-blocking)
        const noteResponse = {
          success: true,
          contactId,
          note: {
            date: timestamp,
            content: `${author}: ${note.trim()}`,
          },
        };

        // Fire-and-forget: forward to n8n for Excel sync
        (async () => {
          try {
            const payload = { contactId, note: note.trim(), author: author.trim(), timestamp };
            const response = await fetch(N8N_ENDPOINTS.addNote, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            if (!response.ok) {
              console.warn(`[add-note] n8n returned ${response.status} (non-blocking)`);
            }
          } catch (e) {
            console.warn(`[add-note] n8n fire-and-forget failed (non-blocking):`, e);
          }
        })();

        return res.json(noteResponse);
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
      const cId = req.body?.contactId;
      console.error(`[add-note] DB write failed for contactId ${cId}:`, error instanceof Error ? error.message : error);
      return res.status(500).json({ error: "Failed to save note. Please try again." });
    }
  });

  // Update intake fields on a contact (CRM edits)
  // Only updates safe fields, logs timeline event
  app.patch("/api/contact/:id", async (req, res) => {
    try {
      const contactId = parseInt(req.params.id, 10);
      if (isNaN(contactId) || contactId <= 0) {
        return res.status(400).json({ error: "Invalid contact ID" });
      }

      const { fields, author } = req.body;
      if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
        return res.status(400).json({ error: "fields object is required and must not be empty" });
      }
      if (!author || typeof author !== "string") {
        return res.status(400).json({ error: "author (initials) is required" });
      }

      console.log(`[intake-update] Updating contact ${contactId}`, {
        author,
        fieldCount: Object.keys(fields).length,
        fieldNames: Object.keys(fields),
      });

      const result = await updateContactIntakeFields(contactId, fields);

      if (result.notFound) {
        return res.status(404).json({ error: "Contact not found", contactId });
      }

      if (result.updated.length === 0) {
        return res.json({ success: true, contactId, updated: [], message: "No safe fields to update" });
      }

      // Log timeline event
      const changedList = result.updated.join(", ");
      const timestamp = new Date().toISOString();
      try {
        appendSyncContactNote(
          contactId,
          `[System] Intake updated by ${author} — fields: ${changedList}`,
          author,
          timestamp
        );
      } catch (e) {
        console.warn(`[intake-update] Failed to log timeline event:`, e);
      }

      await logActivity({
        type: "contact_updated",
        actorEmail: (req as any).user?.email || "system",
        entityType: "contact",
        entityId: String(contactId),
        entityName: (await getSyncContactById(contactId))?.name || "",
        metadata: { fields: changedList },
      });

      // Invalidate board cache so next fetch picks up changes
      boardCache = null;

      console.log(`[intake-update] Success for contact ${contactId}:`, result.updated);
      return res.json({
        success: true,
        contactId,
        updated: result.updated,
      });
    } catch (error) {
      console.error("[intake-update] Error:", error);
      return res.status(500).json({ error: "Failed to update intake fields" });
    }
  });

  // Update contact identity fields (name, email, phone)
  app.patch("/api/contact/:id/identity", async (req, res) => {
    try {
      const contactId = parseInt(req.params.id, 10);
      if (isNaN(contactId) || contactId <= 0) {
        return res.status(400).json({ error: "Invalid contact ID" });
      }

      const { name, email, phone } = req.body;
      const updates: Record<string, string> = {};

      if (typeof name === "string" && name.trim()) updates.name = name.trim();
      if (typeof email === "string") updates.email = email.trim();
      if (typeof phone === "string") updates.phone = phone.trim();

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "At least one field (name, email, phone) is required" });
      }

      if (updates.name !== undefined && updates.name.length === 0) {
        return res.status(400).json({ error: "Name cannot be empty" });
      }

      if (updates.email !== undefined && updates.email.length > 0) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(updates.email)) {
          return res.status(400).json({ error: "Invalid email format" });
        }
      }

      const result = await updateContactIdentity(contactId, updates);

      if (result.notFound) {
        return res.status(404).json({ error: "Contact not found", contactId });
      }

      if (result.changes.length === 0) {
        return res.json({ success: true, contactId, changes: [], message: "No changes detected" });
      }

      const actorEmail = (req as any).user?.email || "system";
      const actorInitials = actorEmail === "system"
        ? "SYS"
        : actorEmail.split("@")[0].substring(0, 3).toUpperCase();

      const contact = await getSyncContactById(contactId);
      const contactName = contact?.name || "Unknown";

      const changeSummaryParts = result.changes.map(
        (c) => `${c.field}: ${c.oldValue || "(empty)"} → ${c.newValue || "(empty)"}`
      );

      const timestamp = new Date().toISOString();
      try {
        appendSyncContactNote(
          contactId,
          `[System] Contact details updated by ${actorInitials} — ${changeSummaryParts.join(", ")}`,
          actorInitials,
          timestamp
        );
      } catch (e) {
        console.warn(`[identity-update] Failed to log timeline note:`, e);
      }

      await logActivity({
        type: "contact_updated",
        actorEmail,
        entityType: "contact",
        entityId: String(contactId),
        entityName: contactName,
        metadata: {
          identityChanges: result.changes,
          summary: `Updated contact details for ${contactName}`,
        },
      });

      boardCache = null;

      return res.json({ success: true, contactId, changes: result.changes });
    } catch (error) {
      console.error("[identity-update] Error:", error);
      return res.status(500).json({ error: "Failed to update contact identity" });
    }
  });

  // Delete a contact and all related records
  app.delete("/api/contact/:id", async (req, res) => {
    try {
      const contactId = parseInt(req.params.id, 10);
      if (isNaN(contactId) || contactId <= 0) {
        return res.status(400).json({ error: "Invalid contact ID" });
      }

      const { confirmation } = req.body;
      if (confirmation !== "delete") {
        return res.status(400).json({ error: 'Confirmation must be the word "delete"' });
      }

      const actorEmail = (req as any).user?.email || "system";
      const result = await deleteSyncContact(contactId);

      if (!result.deleted) {
        return res.status(404).json({ error: "Contact not found", contactId });
      }

      await logActivity({
        type: "contact_deleted",
        actorEmail,
        entityType: "contact",
        entityId: String(contactId),
        entityName: result.name || "Unknown",
        metadata: { deletedName: result.name, contactId },
      });

      boardCache = null;

      console.log(`[delete-contact] Contact ${contactId} ("${result.name}") deleted by ${actorEmail}`);
      return res.json({ success: true, contactId, name: result.name });
    } catch (error) {
      console.error("[delete-contact] Error:", error);
      return res.status(500).json({ error: "Failed to delete contact" });
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
      const result = await createReminderInDb({
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
      const stats = await getReminderStats();
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
      const { contactId, assignedTo: rawAssignedTo } = req.body;

      // Normalize assignedTo: trim whitespace, convert empty string to null
      const assignedTo = typeof rawAssignedTo === "string" && rawAssignedTo.trim() !== ""
        ? rawAssignedTo.trim()
        : null;

      // Validate contactId
      if (contactId === undefined || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }

      // Validate assignedTo is valid email or null
      if (assignedTo !== null) {
        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(assignedTo)) {
          return res.status(400).json({ error: "assignedTo must be a valid email address" });
        }
      }

      console.log(`[assign-contact] Assigning contactId ${contactId} to ${assignedTo || "unassigned"}`);

      if (DATA_MODE === "live") {
        // Write-through: update sync cache for instant UI feedback
        try {
          const contact = await getSyncContactById(contactId);
          await updateSyncContactAssignment(contactId, assignedTo);
          console.log(`[assign-contact] Sync cache updated for contactId ${contactId}`);

          await logActivity({
            type: "contact_assigned",
            actorEmail: (req as any).user?.email || "system",
            entityType: "contact",
            entityId: String(contactId),
            entityName: contact?.name || "",
            metadata: { assignedTo: assignedTo || "unassigned" },
          });
        } catch (e) {
          console.warn(`[assign-contact] Failed to update sync cache:`, e);
        }

        try {
          const payload = {
            contactId,
            assignedTo: assignedTo || null,
          };

          // Use dedicated unassign webhook when clearing assignment
          const webhookUrl = assignedTo === null
            ? N8N_ENDPOINTS.unassignContact
            : N8N_ENDPOINTS.assignContact;

          console.log(`[assign-contact] Calling n8n ${assignedTo === null ? "unassign" : "assign"} with payload:`, payload);

          const response = await fetch(webhookUrl, {
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
      // Fast path: read from sync cache
      if (await shouldReadFromSync()) {
        const staff = await getSyncStaffList();
        console.log(`[staff-list] Serving ${staff.length} staff from sync cache`);
        return res.json({ staff });
      }

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

  // ============================================================================
  // Provider Skills Spreadsheet API (Beta - Read Only)
  // ============================================================================
  // Parses the Provider Skills Spreadsheet and returns raw data for visualization
  // No interpretation of values - preserves "x", "x - Slow", empty exactly as-is
  // ============================================================================

  // Cache for provider data (5 minute TTL)
  let providerDataCache: { providers: unknown[]; timestamp: number; lastModified?: string } | null = null;
  const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Provider Skills Spreadsheet path - configurable via env var
  // Priority: 1) env var, 2) project data dir, 3) user Downloads
  const PROVIDER_SPREADSHEET_PATH = process.env.PROVIDER_SPREADSHEET_PATH
    || path.join(process.cwd(), "data", "Provider Skills Spreadsheet.xlsx");

  app.get("/api/providers", async (_req, res) => {
    try {
      console.log("[providers] === REQUEST START ===");
      console.log("[providers] Spreadsheet path:", PROVIDER_SPREADSHEET_PATH);

      // Check cache first
      if (providerDataCache) {
        const age = Date.now() - providerDataCache.timestamp;
        if (age < PROVIDER_CACHE_TTL_MS) {
          console.log(`[providers] Cache hit (age: ${Math.round(age / 1000)}s, ${providerDataCache.providers.length} providers)`);
          return res.json({
            providers: providerDataCache.providers,
            _source: "cached",
            lastModified: providerDataCache.lastModified,
          });
        }
        console.log("[providers] Cache expired, re-reading spreadsheet");
      }

      // Read the spreadsheet
      let workbook: XLSX.WorkBook;
      try {
        workbook = XLSX.readFile(PROVIDER_SPREADSHEET_PATH);
      } catch (fileError) {
        console.error("[providers] Failed to read spreadsheet:", fileError);
        return res.status(500).json({
          error: "Failed to read Provider Skills Spreadsheet",
          message: fileError instanceof Error ? fileError.message : "Unknown error",
          path: PROVIDER_SPREADSHEET_PATH,
        });
      }

      // Parse the "Current" sheet (active providers)
      const sheet = workbook.Sheets["Current"];
      if (!sheet) {
        console.error("[providers] 'Current' sheet not found in spreadsheet");
        return res.status(500).json({
          error: "Sheet 'Current' not found in Provider Skills Spreadsheet",
        });
      }

      const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as string[][];
      console.log("[providers] Raw rows:", data.length);

      // Column mapping (Sandra's May 2026 schema):
      //   Col 0:    Provider Name (with credentials)
      //   Col 1:    Location
      //   Col 2:    "Accepting Client" — Sandra-side ops note, IGNORED on import
      //             (Phase 2's provider_availability form owns capacity).
      //   Cols 3-10:  Adults (18+) — 8 specialties
      //   Cols 11-17: Adolescents (12-17) — 7 specialties
      //   Cols 18-24: Children (6-11) — 7 specialties
      //   Cols 25-29: Children (0-5) — 5 specialties
      //   Col 30:   Notes
      //   Col 31:   "Approved to work remote by Supervisor" — TODO: surface later;
      //             ignored on import for now.
      //   (No insurance column — Sandra dropped it. Insurances now sourced
      //   exclusively from client-side provider-insurance-data.ts snapshot.)
      const adultSpecialties = ["Anger Issues", "Anxiety", "Couples", "Depression", "Family", "Grief", "Trauma", "Stress Management"];
      const adolescentSpecialties = ["Anger Issues", "Anxiety", "Depression", "Family", "Grief", "Trauma", "Stress Management"];
      const children6to11Specialties = ["Anger Issues", "Anxiety", "Depression", "Family", "Grief", "Trauma", "Stress Management"];
      const children0to5Specialties = ["Anxiety", "Depression", "Family", "Grief", "Trauma"];

      type SkillPace = "normal" | "slow";
      interface SkillEntry {
        hasSkill: boolean;
        pace: SkillPace | null;
        supervision: { supervisor: string } | null;
        raw: string;
      }
      interface SkillWarning {
        row: number;
        providerName: string;
        group: string;
        skill: string;
        raw: string;
        reason: string;
      }
      const warnings: SkillWarning[] = [];

      // Cell-value parser. Handles:
      //   ""                                   → no skill
      //   "x" (case-insensitive, w/ ws)        → has skill, normal pace
      //   "x - Slow" / "x-slow"                → has skill, slow pace
      //   "x under supervision by Lane Smith"  → has skill, normal, supervised
      //   "x-slow and shadowing Angelica V"    → has skill, slow, supervised
      //   "x-slow & shadowing renee"           → has skill, slow, supervised
      //   anything else starting with x        → best-effort {has, normal} + warn
      //   anything else                        → no skill + warn
      // Per S1: "shadowing" and "under supervision by" are treated as the same flag.
      const parseSkillCell = (
        raw: unknown,
        ctx: { row: number; providerName: string; group: string; skill: string }
      ): SkillEntry => {
        const trimmed = (raw == null ? "" : String(raw)).trim();
        if (!trimmed) return { hasSkill: false, pace: null, supervision: null, raw: trimmed };

        // Strip a trailing supervision/shadowing annotation, if present.
        const supMatch = trimmed.match(
          /\s+(?:(?:and|&)\s+)?(?:under\s+supervision\s+by|shadowing)\s+(.+?)\s*$/i
        );
        let supervision: { supervisor: string } | null = null;
        let prefix = trimmed;
        if (supMatch) {
          supervision = { supervisor: supMatch[1].trim() };
          prefix = trimmed.slice(0, supMatch.index!).trim();
        }

        if (/^x\s*[-–]\s*slow$/i.test(prefix)) {
          return { hasSkill: true, pace: "slow", supervision, raw: trimmed };
        }
        if (/^x$/i.test(prefix)) {
          return { hasSkill: true, pace: "normal", supervision, raw: trimmed };
        }
        if (prefix.toLowerCase().startsWith("x")) {
          warnings.push({ ...ctx, raw: trimmed, reason: "malformed skill cell, best-effort to {hasSkill:true, pace:\"normal\"}" });
          return { hasSkill: true, pace: "normal", supervision, raw: trimmed };
        }
        warnings.push({ ...ctx, raw: trimmed, reason: "unrecognized value, treated as empty" });
        return { hasSkill: false, pace: null, supervision: null, raw: trimmed };
      };

      const providers: unknown[] = [];

      // Skip header rows (0, 1), process data rows
      for (let i = 2; i < data.length; i++) {
        const row = data[i];
        const nameWithCredentials = row[0]?.toString().trim();

        // Skip empty rows
        if (!nameWithCredentials) continue;

        // Parse name and credentials
        // Format: "FirstName LastName, CREDENTIALS" or "FirstName LastName, CREDENTIALS (Language)"
        const nameMatch = nameWithCredentials.match(/^(.+?),\s*(.+)$/);
        let name = nameMatch ? nameMatch[1].trim() : nameWithCredentials;
        let credentials = nameMatch ? nameMatch[2].trim() : "";

        // Correct names that are in "Last First" format or abbreviated in the spreadsheet
        const nameCorrections: Record<string, string> = {
          "Neuhart Jessica": "Jessica Neuhart",
          "Ty Jones": "Tyra Jones",
        };
        if (nameCorrections[name]) {
          name = nameCorrections[name];
        }

        // Correct credential typos. Keyed by corrected name → corrected credential.
        const credentialCorrections: Record<string, string> = {
          "Cindy Ketchum": "Intern", // CSV has "inten" (typo)
        };
        if (credentialCorrections[name]) {
          credentials = credentialCorrections[name];
        }

        // Skip providers that should be excluded from the list
        const excludedProviders = ["Vera Molina"];
        if (excludedProviders.includes(name)) {
          continue;
        }

        const location = row[1]?.toString().trim() || "";

        // Skill columns (shifted right by 1 vs. pre-May-2026 schema; col 2 is now
        // Sandra's "Accepting Client" ops field, ignored).
        const ADULTS_BASE = 3;
        const ADOLESCENTS_BASE = 11;
        const CHILDREN_6_11_BASE = 18;
        const CHILDREN_0_5_BASE = 25;

        const adultsCapabilities: Record<string, SkillEntry> = {};
        for (let j = 0; j < adultSpecialties.length; j++) {
          const skill = adultSpecialties[j];
          const entry = parseSkillCell(row[ADULTS_BASE + j], { row: i, providerName: name, group: "Adults (18+)", skill });
          if (entry.hasSkill) adultsCapabilities[skill] = entry;
        }
        const adolescentsCapabilities: Record<string, SkillEntry> = {};
        for (let j = 0; j < adolescentSpecialties.length; j++) {
          const skill = adolescentSpecialties[j];
          const entry = parseSkillCell(row[ADOLESCENTS_BASE + j], { row: i, providerName: name, group: "Adolescents (12-17)", skill });
          if (entry.hasSkill) adolescentsCapabilities[skill] = entry;
        }
        const children6to11Capabilities: Record<string, SkillEntry> = {};
        for (let j = 0; j < children6to11Specialties.length; j++) {
          const skill = children6to11Specialties[j];
          const entry = parseSkillCell(row[CHILDREN_6_11_BASE + j], { row: i, providerName: name, group: "Children (6-11)", skill });
          if (entry.hasSkill) children6to11Capabilities[skill] = entry;
        }
        const children0to5Capabilities: Record<string, SkillEntry> = {};
        for (let j = 0; j < children0to5Specialties.length; j++) {
          const skill = children0to5Specialties[j];
          const entry = parseSkillCell(row[CHILDREN_0_5_BASE + j], { row: i, providerName: name, group: "Children (0-5)", skill });
          if (entry.hasSkill) children0to5Capabilities[skill] = entry;
        }

        const notes = row[30]?.toString().trim() || "";
        // Insurances column was removed in May 2026; always emit empty string,
        // client-side hardcoded snapshot is now the only source of truth.
        const acceptedInsurances = "";

        providers.push({
          id: i - 1, // 1-indexed provider ID
          nameWithCredentials,
          name,
          credentials,
          location,
          ageGroups: {
            "Adults (18+)": adultsCapabilities,
            "Adolescents (12-17)": adolescentsCapabilities,
            "Children (6-11)": children6to11Capabilities,
            "Children (0-5)": children0to5Capabilities,
          },
          notes,
          acceptedInsurances,
        });
      }

      console.log("[providers] Parsed", providers.length, "providers from spreadsheet");
      if (warnings.length > 0) {
        const lines = warnings
          .map((w) => `  - ${w.providerName} / ${w.group} / ${w.skill}: ${JSON.stringify(w.raw)} — ${w.reason}`)
          .join("\n");
        console.warn(`[providers] Skill-cell parser warnings (${warnings.length}):\n${lines}`);
      }

      // Apply CRM overrides to spreadsheet providers
      try {
        const overrides = await getAllProviderOverrides();
        const overrideMap = new Map(overrides.map(o => [o.providerName, o]));
        for (const p of providers) {
          const prov = p as any;
          const override = overrideMap.get(prov.name);
          if (override) {
            prov._hasOverrides = true;
            if (override.specialties) prov._overrideSpecialties = override.specialties;
            if (override.insurances) prov._overrideInsurances = override.insurances;
            if (override.populations) prov._overridePopulations = override.populations;
            if (override.notes !== null && override.notes !== undefined) prov._overrideNotes = override.notes;
            // Merge ageGroup capability overrides onto the provider's ageGroups.
            // Override values are still strings ("x", "x - Slow") in
            // provider_overrides.age_groups (no DB migration in Phase 1, per
            // S6 in plan summary). Coerce each override string through the
            // same parseSkillCell used for the spreadsheet so the merged
            // ageGroups stays uniformly { hasSkill, pace, supervision, raw }.
            if (override.ageGroups) {
              for (const [group, caps] of Object.entries(override.ageGroups)) {
                if (!prov.ageGroups[group]) continue;
                for (const [skill, val] of Object.entries(caps as Record<string, string>)) {
                  if (typeof val === "string" && val.trim() !== "") {
                    prov.ageGroups[group][skill] = parseSkillCell(val, {
                      row: -1,
                      providerName: prov.name,
                      group,
                      skill,
                    });
                  } else {
                    delete prov.ageGroups[group][skill];
                  }
                }
              }
            }
          }
        }
        if (overrides.length > 0) {
          console.log("[providers] Applied", overrides.length, "provider overrides");
        }
      } catch (e) {
        console.warn("[providers] Failed to load provider overrides:", e);
      }

      // Merge CRM-managed providers
      try {
        const crmProviders = await getAllCrmProviders();
        for (const cp of crmProviders) {
          providers.push({
            id: 10000 + cp.id, // offset to avoid ID collisions with spreadsheet
            nameWithCredentials: cp.credentials ? `${cp.name}, ${cp.credentials}` : cp.name,
            name: cp.name,
            credentials: cp.credentials,
            location: cp.location,
            ageGroups: {
              "Adults (18+)": {},
              "Adolescents (12-17)": {},
              "Children (6-11)": {},
              "Children (0-5)": {},
            },
            notes: cp.notes,
            acceptedInsurances: cp.insurances.join(", "),
            _crmManaged: true,
            crmId: cp.id,
            specialties: cp.specialties,
            crmAgeGroups: cp.ageGroups,
          });
        }
        if (crmProviders.length > 0) {
          console.log("[providers] Merged", crmProviders.length, "CRM providers");
        }
      } catch (e) {
        console.warn("[providers] Failed to load CRM providers:", e);
      }

      // Update cache
      providerDataCache = {
        providers,
        timestamp: Date.now(),
        lastModified: new Date().toISOString(),
      };

      return res.json({
        providers,
        _source: "spreadsheet",
        lastModified: providerDataCache.lastModified,
      });
    } catch (error) {
      console.error("[providers] Unexpected error:", error);
      return res.status(500).json({
        error: "Failed to fetch provider data",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Create a new CRM-managed provider
  app.post("/api/providers", async (req, res) => {
    try {
      const { name, credentials, location, specialties, ageGroups, insurances, notes } = req.body;

      if (!name || typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ error: "name is required" });
      }

      const id = await createCrmProvider({
        name,
        credentials,
        location,
        specialties,
        ageGroups,
        insurances,
        notes,
      });

      // Invalidate provider cache
      providerDataCache = null;

      // Log activity
      await logActivity({
        type: "provider_updated",
        actorEmail: (req as any).user?.email || "system",
        entityType: "provider",
        entityId: String(id),
        entityName: name.trim(),
        metadata: {
          providerId: id,
          providerName: name.trim(),
          fieldsUpdated: ["created"],
        },
      });

      console.log(`[providers] Created CRM provider ${id}: ${name}`);
      return res.json({ success: true, id });
    } catch (error) {
      console.error("[providers] Error creating provider:", error);
      return res.status(500).json({ error: "Failed to create provider" });
    }
  });

  // Update a CRM-managed provider
  app.patch("/api/providers/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid provider ID" });
      }

      const existing = await getCrmProviderById(id);
      if (!existing) {
        return res.status(404).json({ error: "CRM provider not found" });
      }

      const { name, credentials, location, specialties, ageGroups, insurances, notes } = req.body;

      // Diff fields to know what changed
      const fieldsUpdated: string[] = [];
      if (name !== undefined && name.trim() !== existing.name) fieldsUpdated.push("name");
      if (credentials !== undefined && credentials.trim() !== existing.credentials) fieldsUpdated.push("credentials");
      if (location !== undefined && location.trim() !== existing.location) fieldsUpdated.push("location");
      if (specialties !== undefined && JSON.stringify(specialties) !== JSON.stringify(existing.specialties)) fieldsUpdated.push("specialties");
      if (ageGroups !== undefined && JSON.stringify(ageGroups) !== JSON.stringify(existing.ageGroups)) fieldsUpdated.push("age groups");
      if (insurances !== undefined && JSON.stringify(insurances) !== JSON.stringify(existing.insurances)) fieldsUpdated.push("insurances");
      if (notes !== undefined && notes.trim() !== (existing.notes || "")) fieldsUpdated.push("notes");

      const updated = await updateCrmProvider(id, {
        name,
        credentials,
        location,
        specialties,
        ageGroups,
        insurances,
        notes,
      });

      // Invalidate provider cache
      providerDataCache = null;

      // Log activity if something actually changed
      if (updated && fieldsUpdated.length > 0) {
        await logActivity({
          type: "provider_updated",
          actorEmail: (req as any).user?.email || "system",
          entityType: "provider",
          entityId: String(id),
          entityName: existing.name,
          metadata: {
            providerId: id,
            providerName: existing.name,
            fieldsUpdated,
          },
        });
      }

      const updatedProvider = await getCrmProviderById(id);
      return res.json({ success: true, updated, provider: updatedProvider });
    } catch (error) {
      console.error("[providers] Error updating provider:", error);
      return res.status(500).json({ error: "Failed to update provider" });
    }
  });

  // Override fields on a spreadsheet-backed provider (CRM overlay)
  app.patch("/api/providers/override", async (req, res) => {
    try {
      const { providerName, specialties, insurances, populations, notes, ageGroups } = req.body;

      if (!providerName || typeof providerName !== "string" || providerName.trim() === "") {
        return res.status(400).json({ error: "providerName is required" });
      }

      const existing = await getProviderOverride(providerName.trim());

      // Diff fields for activity log
      const fieldsUpdated: string[] = [];
      if (specialties !== undefined && JSON.stringify(specialties) !== JSON.stringify(existing?.specialties)) fieldsUpdated.push("specialties");
      if (insurances !== undefined && JSON.stringify(insurances) !== JSON.stringify(existing?.insurances)) fieldsUpdated.push("insurances");
      if (populations !== undefined && JSON.stringify(populations) !== JSON.stringify(existing?.populations)) fieldsUpdated.push("populations");
      if (notes !== undefined && notes !== (existing?.notes ?? "")) fieldsUpdated.push("notes");
      if (ageGroups !== undefined) fieldsUpdated.push("age groups");

      await upsertProviderOverride({
        providerName: providerName.trim(),
        specialties,
        insurances,
        populations,
        notes,
        ageGroups,
      });

      // Invalidate provider cache
      providerDataCache = null;

      // Log activity
      if (fieldsUpdated.length > 0) {
        await logActivity({
          type: "provider_updated",
          actorEmail: (req as any).user?.email || "system",
          entityType: "provider",
          entityId: providerName.trim(),
          entityName: providerName.trim(),
          metadata: {
            providerName: providerName.trim(),
            fieldsUpdated,
          },
        });
      }

      return res.json({ success: true, fieldsUpdated });
    } catch (error) {
      console.error("[providers] Error updating provider override:", error);
      return res.status(500).json({ error: "Failed to update provider" });
    }
  });

  // ============================================================================
  // Provider Availability API (standalone Fly.io form → CRM)
  // ============================================================================
  //
  // The standalone provider availability form (separate Fly.io app) POSTs
  // here on every submission. We:
  //   1. Auth-gate via X-Provider-Form-Key header (shared secret).
  //   2. Resolve provider identity by email through PROVIDER_LIST. Unknown
  //      email → 404 (no upsert; we don't trust the form to invent providers).
  //   3. Upsert to provider_availability (last-write-wins on duplicate
  //      submissions per locked decision D1).
  //   4. Mirror to form_submissions for an append-only audit trail
  //      (best-effort — return 200 even if audit write fails).
  //   5. Log provider_availability_submitted activity event with synthetic
  //      "provider_form" actor (D3).
  const providerAvailabilityRequestSchema = z.object({
    providerEmail: z
      .string()
      .trim()
      .min(1, "providerEmail is required")
      .email("providerEmail must be a valid email"),
    acceptingClients: z
      .number()
      .int("acceptingClients must be an integer")
      .nonnegative("acceptingClients must be >= 0"),
    specialConsiderations: z
      .string()
      .max(2000, "specialConsiderations must be <= 2000 characters")
      .optional()
      .nullable(),
  });

  app.post("/api/provider-availability", async (req, res) => {
    try {
      // Auth — shared secret in X-Provider-Form-Key header
      if (!PROVIDER_FORM_API_KEY) {
        console.warn("[provider-availability] Endpoint blocked — PROVIDER_FORM_API_KEY not configured");
        return res.status(503).json({ error: "Provider availability endpoint not configured for this environment" });
      }
      if (req.headers["x-provider-form-key"] !== PROVIDER_FORM_API_KEY) {
        return res.status(401).json({ error: "unauthorized" });
      }

      // Validation
      const parsed = providerAvailabilityRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "validation_error", issues: parsed.error.issues });
      }
      const body = parsed.data;

      // Resolve email → provider identity. Unknown email = no upsert.
      const { getProviderByEmail } = await import("./email/provider-location-config");
      const providerEntry = getProviderByEmail(body.providerEmail);
      if (!providerEntry) {
        return res.status(404).json({ error: "provider_not_found", email: body.providerEmail });
      }

      // Server stamps time. Ignore client-supplied timestamps per D7 (form
      // payload doesn't carry one anyway, but be explicit for safety).
      const submittedAt = new Date().toISOString();

      // Source-of-truth write
      let upserted;
      try {
        upserted = await upsertProviderAvailability({
          providerEmail: providerEntry.email,
          providerName: providerEntry.name,
          acceptingClients: body.acceptingClients,
          specialConsiderations: body.specialConsiderations ?? null,
          lastFormSubmittedAt: submittedAt,
        });
      } catch (err) {
        console.error("[provider-availability] Upsert failed:", err);
        return res.status(500).json({ error: "internal_error" });
      }

      // Bust the GET /api/providers cache so the new value surfaces on the
      // next read without waiting for the 5-minute TTL.
      providerDataCache = null;

      // Audit mirror to form_submissions — best-effort, sequential. If this
      // fails AFTER a successful upsert, log loudly server-side and STILL
      // return 200 — the form must not retry a write that already landed.
      try {
        await insertSubmission({
          formType: "provider_availability",
          source: "provider_availability_form",
          submittedAt,
          contactId: null,
          name: providerEntry.name,
          data: {
            providerEmail: providerEntry.email,
            providerName: providerEntry.name,
            acceptingClients: body.acceptingClients,
            specialConsiderations: body.specialConsiderations ?? null,
            rawBody: req.body,
          },
        });
      } catch (err) {
        console.error(
          "[provider-availability] Audit write to form_submissions FAILED after successful upsert " +
            `for ${providerEntry.email} — recoverable from logs, returning 200 anyway:`,
          err
        );
      }

      // Activity log — synthetic actor per D3 keeps providers out of the
      // staff activity leaderboard. Real provider email goes in entityId.
      await logActivity({
        type: "provider_availability_submitted",
        actorEmail: "provider_form",
        entityType: "provider",
        entityId: providerEntry.email,
        entityName: providerEntry.name,
        metadata: {
          acceptingClients: body.acceptingClients,
          specialConsiderations: body.specialConsiderations ?? null,
        },
      });

      console.log(
        `[provider-availability] Upserted ${providerEntry.name} <${providerEntry.email}> ` +
          `(clients=${body.acceptingClients})`
      );

      return res.json({
        success: true,
        providerEmail: upserted.providerEmail,
        providerName: providerEntry.name,
        submittedAt,
      });
    } catch (error) {
      console.error("[provider-availability] Unexpected error:", error);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // ============================================================================
  // Email Automation API (v1 - Admin-Triggered Only)
  // ============================================================================
  // Manual email sending with templated messages.
  // - NO auto-sending: all emails require explicit admin action
  // - ECC soft-gate: warns if consent missing but doesn't block
  // - Full audit logging in Activity Timeline
  // ============================================================================

  // Import email service functions
  const {
    getTemplateList,
    renderTemplate,
    sendTemplatedEmail,
    getEccStatus,
    validateEmailServiceConfig,
  } = await import("./email/service");

  // Import provider/location config
  const {
    PROVIDER_LIST,
    OFFICE_LOCATIONS,
  } = await import("./email/provider-location-config");

  // Log email service configuration status at startup
  const emailConfig = await validateEmailServiceConfig();
  if (emailConfig.warnings.length > 0) {
    console.warn("[email-api] Email service warnings:");
    emailConfig.warnings.forEach((w) => console.warn(`  - ${w}`));
  } else {
    console.log("[email-api] Email service configured correctly");
  }

  // POST /api/test-email - Send a test email to verify Resend integration
  // Auth: session OR X-Sync-Key header (added to publicPostPaths in auth.ts)
  app.post("/api/test-email", async (req, res) => {
    try {
      // Require X-Sync-Key when not session-authenticated
      const isSessionAuth = req.isAuthenticated && req.isAuthenticated();
      const apiKey = req.headers["x-sync-key"] as string;
      if (!isSessionAuth && (!SYNC_API_KEY || apiKey !== SYNC_API_KEY)) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { to } = req.body;
      const recipient = to?.trim();

      if (!recipient || !recipient.includes("@")) {
        return res.status(400).json({ error: "Valid 'to' email is required" });
      }

      const { Resend } = await import("resend");
      const resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) {
        return res.status(503).json({ error: "RESEND_API_KEY not configured" });
      }

      const fromEmail = process.env.EMAIL_FROM_ADDRESS || process.env.RESEND_FROM_EMAIL || "no-reply@hipaacheck.ai";
      const resend = new Resend(resendKey);

      console.log(`[test-email] Sending test email to ${recipient} from ${fromEmail}`);

      const result = await resend.emails.send({
        from: `TFC CRM Test <${fromEmail}>`,
        to: [recipient],
        subject: "TFC CRM - Email System Test",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1e3a5f;">Email System Test</h2>
            <p>This is a test email from the TFC CRM system.</p>
            <p><strong>Timestamp:</strong> ${new Date().toLocaleString("en-US", { timeZone: "America/Denver" })}</p>
            <p><strong>From:</strong> ${fromEmail}</p>
            <p><strong>Environment:</strong> ${process.env.NODE_ENV || "development"}</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
            <p style="color: #666; font-size: 12px;">The Family Connection - CRM Email System</p>
          </div>
        `,
        text: `TFC CRM Email System Test\n\nTimestamp: ${new Date().toISOString()}\nFrom: ${fromEmail}\n\nThis is a test email from the TFC CRM system.`,
      });

      console.log(`[test-email] Success:`, result);
      return res.json({ success: true, emailId: result.data?.id, from: fromEmail, to: recipient });
    } catch (error) {
      console.error("[test-email] Failed:", error);
      return res.status(500).json({
        error: "Failed to send test email",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // POST /api/feedback — User feedback with optional screenshot
  const multer = require("multer");
  const feedbackUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

  app.post("/api/feedback", feedbackUpload.single("screenshot"), async (req: any, res: any) => {
    try {
      const userEmail = req.user?.email || "unknown";
      const comment = req.body?.comment?.trim();
      if (!comment) {
        return res.status(400).json({ error: "Comment is required" });
      }

      let context: Record<string, unknown> = {};
      try { context = JSON.parse(req.body?.context || "{}"); } catch {}

      const screenshotFile = req.file;
      const screenshotBase64 = screenshotFile
        ? screenshotFile.buffer.toString("base64")
        : null;

      // Store in DB
      const pool = (await import("./db/pool")).getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS feedback_log (
          id SERIAL PRIMARY KEY,
          user_email TEXT NOT NULL,
          comment TEXT NOT NULL,
          has_screenshot BOOLEAN DEFAULT false,
          context JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(
        `INSERT INTO feedback_log (user_email, comment, has_screenshot, context) VALUES ($1, $2, $3, $4)`,
        [userEmail, comment, !!screenshotFile, JSON.stringify(context)]
      );

      // Send admin notification email
      try {
        const { Resend } = await import("resend");
        const resendKey = process.env.RESEND_API_KEY;
        if (resendKey) {
          const resend = new Resend(resendKey);
          const fromEmail = process.env.EMAIL_FROM_ADDRESS || "no-reply@hipaacheck.ai";
          const preview = comment.length > 50 ? comment.slice(0, 50) + "..." : comment;

          const attachments = screenshotBase64 && screenshotFile ? [{
            filename: screenshotFile.originalname || "screenshot.png",
            content: screenshotBase64,
          }] : [];

          // Email to admin
          await resend.emails.send({
            from: `TFC CRM Feedback <${fromEmail}>`,
            to: ["raunek@xpandai.com"],
            subject: `[CRM Feedback] ${preview}`,
            html: `
              <div style="font-family: sans-serif; max-width: 600px;">
                <h2 style="color: #1e3a5f;">CRM Feedback</h2>
                <p><strong>From:</strong> ${userEmail}</p>
                <p><strong>Page:</strong> ${context.pageUrl || "N/A"}</p>
                <p><strong>Time:</strong> ${context.timestamp || new Date().toISOString()}</p>
                <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;" />
                <p>${comment.replace(/\n/g, "<br>")}</p>
                ${screenshotBase64 ? '<p><em>Screenshot attached</em></p>' : ''}
              </div>
            `,
            attachments,
          });

          // Confirmation email to user
          if (userEmail !== "unknown" && userEmail.includes("@")) {
            await resend.emails.send({
              from: `The Family Connection <${fromEmail}>`,
              to: [userEmail],
              subject: "We received your feedback",
              html: `
                <div style="font-family: sans-serif; max-width: 600px;">
                  <h2 style="color: #1e3a5f;">Thank you for your feedback</h2>
                  <p>We've received your feedback and will look into it.</p>
                  <p style="color: #666; font-size: 13px; margin-top: 24px;">
                    <em>"${preview}"</em>
                  </p>
                  <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;" />
                  <p style="color: #999; font-size: 12px;">The Family Connection CRM</p>
                </div>
              `,
            });
          }
        }
      } catch (emailErr) {
        console.error("[feedback] Email send failed (non-blocking):", emailErr);
      }

      console.log(`[feedback] Received from ${userEmail}: "${comment.substring(0, 80)}"`);
      return res.json({ success: true });
    } catch (error) {
      console.error("[feedback] Error:", error);
      return res.status(500).json({ error: "Failed to submit feedback" });
    }
  });

  // POST /api/referral/extract — Upload a referral PDF and get extracted JSON back.
  // Gated to the REFERRAL_UPLOAD_EMAILS allowlist. PDF is processed in memory only
  // (never written to disk) and sent to AWS Bedrock for extraction. Extracted patient
  // data is never logged.
  const referralUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req: any, file: any, cb: any) => {
      if (file.mimetype === "application/pdf") {
        cb(null, true);
      } else {
        cb(new Error("Only PDF files are accepted"));
      }
    },
  });

  app.post("/api/referral/extract", referralUpload.single("pdf"), async (req: any, res: any) => {
    const userEmail = req.user?.email?.toLowerCase() ?? "";
    if (!canAccessReferralUpload(userEmail)) {
      return res.status(403).json({ error: "Access denied" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No PDF file provided" });
    }

    try {
      const extracted = await extractReferralData(req.file.buffer);

      const hasAnyData = Object.values(extracted).some((v) => v !== null);
      if (!hasAnyData) {
        return res.status(422).json({
          error: "This PDF does not appear to contain patient referral information. Please upload the complete referral document.",
        });
      }

      return res.json(extracted);
    } catch (err) {
      console.error("[api/referral/extract] Extraction failed:", (err as Error).message);
      return res.status(500).json({
        error: "Failed to process the referral PDF. Please try again.",
      });
    }
  });

  // GET /api/email-config - Provider list + location list for the Send Email modal
  app.get("/api/email-config", (_req, res) => {
    try {
      // Build providerEmails map from PROVIDER_LIST for backwards compat
      const providerEmails: Record<string, string> = {};
      for (const p of PROVIDER_LIST) {
        providerEmails[p.name] = p.email;
      }
      return res.json({
        providers: PROVIDER_LIST.map((p) => ({
          name: p.name,
          credentials: p.credential,
          email: p.email,
        })),
        providerEmails,
        locations: OFFICE_LOCATIONS.map((l) => ({
          id: l.id,
          label: l.label,
          address: l.address,
        })),
      });
    } catch (error) {
      console.error("[email-api] Error fetching email config:", error);
      return res.status(500).json({ error: "Failed to fetch email config" });
    }
  });

  // GET /api/email-templates - List available templates for dropdown
  app.get("/api/email-templates", async (_req, res) => {
    try {
      const templates = await getTemplateList();
      console.log(`[email-api] Returning ${templates.length} templates`);
      return res.json({ templates });
    } catch (error) {
      console.error("[email-api] Error fetching templates:", error);
      return res.status(500).json({ error: "Failed to fetch email templates" });
    }
  });

  // POST /api/email-preview - Render template preview with contact data
  app.post("/api/email-preview", async (req, res) => {
    try {
      const { contactId, templateId, dynamicFields } = req.body;

      // Validate required fields
      if (!contactId || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }
      if (!templateId || typeof templateId !== "string") {
        return res.status(400).json({ error: "templateId (string) is required" });
      }

      // Read contact from local sync_contacts DB (primary source)
      // Falls back to n8n snapshot only if local data is missing
      let contact: Record<string, unknown> | null = null;
      const localContact = await getSyncContactById(contactId);

      if (localContact && localContact.name) {
        contact = localContact as unknown as Record<string, unknown>;
        console.log(`[email-preview] contactId=${contactId} found=true source=local email=${localContact.email || "MISSING"}`);
      } else if (DATA_MODE === "live") {
        console.warn(`[email-preview] contactId=${contactId} not in local DB, falling back to n8n`);
        try {
          const snapshotResponse = await fetch(N8N_ENDPOINTS.contactSnapshot, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contactId }),
          });
          if (snapshotResponse.ok) {
            const rawData = await snapshotResponse.json();
            contact = rawData.contact || rawData || null;
          }
        } catch (err) {
          console.warn("[email-preview] n8n fallback failed:", err);
        }
      }

      if (!contact) {
        console.error(`[email-preview] contactId=${contactId} found=false`);
        return res.status(404).json({ error: "Contact not found" });
      }

      // Build contact for email rendering
      const contactForEmail = {
        contactId: contactId,
        name: String(contact.name || ""),
        email: contact.email as string | null,
        modality: contact.modality as string | null,
        city: contact.city as string | null,
        serviceRequested: String(contact.serviceRequested || ""),
        requestingFor: (contact.requestingFor as string) || null,
        eccConsent: contact.eccConsent as boolean | null,
      };

      console.log(`[email-preview] contactForEmail: email=${contactForEmail.email}, requestingFor=${contactForEmail.requestingFor}`);

      // Sanitize dynamicFields: only allow string values, strip HTML
      const sanitizedFields: Record<string, string> = {};
      if (dynamicFields && typeof dynamicFields === "object") {
        for (const [key, value] of Object.entries(dynamicFields)) {
          if (typeof value === "string") {
            // Strip any HTML tags for safety
            sanitizedFields[key] = value.replace(/<[^>]*>/g, "");
          }
        }
      }

      // Render preview with admin-provided dynamic fields
      const rendered = await renderTemplate(templateId, contactForEmail, sanitizedFields);
      if (!rendered) {
        return res.status(400).json({ error: `Template not found: ${templateId}` });
      }

      // Include ECC status in response
      const eccStatus = await getEccStatus(contactForEmail);

      console.log(`[email-preview] Rendered "${templateId}" for contact ${contactId} (ECC: ${eccStatus})`);

      return res.json({
        ...rendered,
        eccStatus,
      });
    } catch (error) {
      console.error("[email-preview] Error:", error);
      return res.status(500).json({ error: "Failed to generate email preview" });
    }
  });

  // POST /api/send-email - Send email and log to timeline
  app.post("/api/send-email", async (req, res) => {
    try {
      const { contactId, templateId, eccStatus, dynamicFields } = req.body;

      // Validate required fields
      if (!contactId || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }
      if (!templateId || typeof templateId !== "string") {
        return res.status(400).json({ error: "templateId (string) is required" });
      }
      if (!eccStatus || (eccStatus !== "present" && eccStatus !== "missing")) {
        return res.status(400).json({ error: "eccStatus ('present' | 'missing') is required" });
      }

      // Get authenticated user's email
      const userEmail = (req as unknown as { user?: { email?: string } }).user?.email || "unknown";

      // Read contact from local sync_contacts DB (primary source)
      // Falls back to n8n snapshot only if local data is missing
      let contact: Record<string, unknown> | null = null;
      const localContact = await getSyncContactById(contactId);

      if (localContact && localContact.name) {
        contact = localContact as unknown as Record<string, unknown>;
        console.log(`[send-email] contactId=${contactId} found=true source=local email=${localContact.email || "MISSING"}`);
      } else if (DATA_MODE === "live") {
        console.warn(`[send-email] contactId=${contactId} not in local DB, falling back to n8n`);
        try {
          const snapshotResponse = await fetch(N8N_ENDPOINTS.contactSnapshot, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contactId }),
          });
          if (snapshotResponse.ok) {
            const rawData = await snapshotResponse.json();
            contact = rawData.contact || rawData || null;
          }
        } catch (err) {
          console.warn("[send-email] n8n fallback failed:", err);
        }
      }

      if (!contact) {
        console.error(`[send-email] contactId=${contactId} found=false`);
        return res.status(404).json({ error: "Contact not found" });
      }

      // Build contact for email sending
      const contactForEmail = {
        contactId: contactId,
        name: String(contact.name || ""),
        email: contact.email as string | null,
        modality: contact.modality as string | null,
        city: contact.city as string | null,
        serviceRequested: String(contact.serviceRequested || ""),
        requestingFor: (contact.requestingFor as string) || null,
        eccConsent: contact.eccConsent as boolean | null,
      };

      // Defensive logging before validation
      console.log(`[send-email] Preparing to send:`, {
        contactId,
        recipientEmail: contactForEmail.email,
        recipientName: contactForEmail.name,
        adminEmail: userEmail,
        eccStatus,
      });

      // Check if contact has email - ONLY hard block
      if (!contactForEmail.email) {
        console.error(`[send-email] BLOCKED: Contact ${contactId} has no email address`);
        return res.status(400).json({ error: "Contact has no email address" });
      }

      // Sanitize dynamicFields: only allow string values, strip HTML
      const sanitizedFields: Record<string, string> = {};
      if (dynamicFields && typeof dynamicFields === "object") {
        for (const [key, value] of Object.entries(dynamicFields)) {
          if (typeof value === "string") {
            sanitizedFields[key] = value.replace(/<[^>]*>/g, "");
          }
        }
      }

      // Send the email with admin-provided dynamic fields
      const sendResult = await sendTemplatedEmail({
        templateId,
        contact: contactForEmail,
        sentByEmail: userEmail,
        eccStatus,
        dynamicFields: sanitizedFields,
      });

      const templates = await getTemplateList();
      const templateName = templates.find((t) => t.id === templateId)?.name || templateId;
      const dynamicFieldDetails: string[] = [];
      if (sanitizedFields.therapistName) dynamicFieldDetails.push(`Provider: ${sanitizedFields.therapistName}`);
      if (sanitizedFields.appointmentDatetime) dynamicFieldDetails.push(`Appt: ${sanitizedFields.appointmentDatetime}`);
      if (sanitizedFields.surveyLink) dynamicFieldDetails.push(`Survey: ${sanitizedFields.surveyLink}`);
      const fieldsSuffix = dynamicFieldDetails.length > 0 ? ` | ${dynamicFieldDetails.join(", ")}` : "";

      console.log(
        `[send-email] ${sendResult.success ? "SUCCESS" : "FAILED"}: ` +
        `"${templateName}" to ${contactForEmail.email} by ${userEmail} (ECC: ${eccStatus})`
      );

      if (!sendResult.success) {
        return res.status(502).json({
          success: false,
          error: sendResult.error || "Failed to send email",
        });
      }

      res.json({
        success: true,
        emailId: sendResult.emailId,
      });

      // Save email snapshot for every send that produced rendered HTML (fire-and-forget)
      let snapshotSaved = false;
      if (sendResult.renderedHtml) {
        try {
          await saveEmailSnapshot({
            contactId,
            templateId,
            subject: sendResult.renderedSubject || templateName,
            bodyHtml: sendResult.renderedHtml,
            sentByEmail: userEmail,
            senderEmail: sendResult.senderEmail || "no-reply@hipaacheck.ai",
            recipientEmail: sendResult.recipientEmail || contactForEmail.email,
            ccEmails: sendResult.ccEmails,
          });
          snapshotSaved = true;
        } catch (snapshotErr) {
          console.error(`[send-email] Snapshot save failed: contactId=${contactId} templateId=${templateId}`, snapshotErr);
        }
      }

      const noteContent = `[Email] ${templateName} sent${fieldsSuffix}`;

      await logActivity({
        type: "email_sent",
        actorEmail: userEmail,
        entityType: "contact",
        entityId: String(contactId),
        entityName: contactForEmail.name,
        metadata: {
          contactId,
          template: templateId,
          templateName,
          recipientEmail: contactForEmail.email,
          eccStatus,
          snapshotSaved,
        },
      });

      // Fire-and-forget: log timeline note AFTER response is sent
      if (DATA_MODE === "live" && sendResult.success) {
        const timestamp = new Date().toISOString();
        const author = userEmail.split("@")[0].substring(0, 3).toUpperCase();

        fetch(N8N_ENDPOINTS.addNote, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contactId,
            note: noteContent,
            author,
            timestamp,
          }),
        })
          .then(() => console.log(`[send-email] Timeline note logged for contact ${contactId}`))
          .catch((noteError) => console.error("[send-email] Failed to log timeline note:", noteError));
      }

      return;
    } catch (error) {
      console.error("[send-email] Error:", error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to send email",
      });
    }
  });

  // ============================================================================
  // Intake Comments & Attention Flags API
  // ============================================================================

  // Get all comments for a contact
  // Get intake submissions history for a contact
  app.get("/api/intake-history/:contactId", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId, 10);
      if (isNaN(contactId) || contactId <= 0) {
        return res.status(400).json({ error: "Invalid contactId" });
      }
      const submissions = await getSubmissionsForContact(contactId);
      return res.json({ submissions });
    } catch (error) {
      console.error("[intake-history] Error:", error);
      return res.status(500).json({ error: "Failed to fetch intake history" });
    }
  });

  // Household members — other contacts sharing email or phone
  app.get("/api/household/:contactId", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId, 10);
      if (isNaN(contactId) || contactId <= 0) {
        return res.status(400).json({ error: "Invalid contactId" });
      }
      const contact = await getSyncContactById(contactId);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      const members = await getHouseholdMembers(contactId, contact.email, contact.phone);
      return res.json({ members });
    } catch (error) {
      console.error("[household] Error:", error);
      return res.status(500).json({ error: "Failed to fetch household members" });
    }
  });

  app.get("/api/intake-comments/:contactId", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId, 10);
      if (isNaN(contactId)) {
        return res.status(400).json({ error: "contactId must be a number" });
      }

      const comments = await getIntakeComments(contactId);
      return res.json({ comments });
    } catch (error) {
      console.error("Error getting intake comments:", error);
      return res.status(500).json({ error: "Failed to get intake comments" });
    }
  });

  // Add a comment (auto-creates attention flag)
  app.post("/api/intake-comments", async (req, res) => {
    try {
      const { contactId, contactName, authorEmail, authorInitials, commentText } = req.body;

      if (contactId === undefined || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }
      if (!contactName || typeof contactName !== "string" || contactName.trim() === "") {
        return res.status(400).json({ error: "contactName is required" });
      }
      if (!authorEmail || typeof authorEmail !== "string" || !authorEmail.includes("@")) {
        return res.status(400).json({ error: "valid authorEmail is required" });
      }
      if (!authorInitials || typeof authorInitials !== "string") {
        return res.status(400).json({ error: "authorInitials is required" });
      }
      if (!commentText || typeof commentText !== "string" || commentText.trim() === "") {
        return res.status(400).json({ error: "commentText is required" });
      }

      const result = await createIntakeComment({
        contactId,
        contactName: contactName.trim(),
        authorEmail: authorEmail.trim(),
        authorInitials: authorInitials.trim(),
        commentText: commentText.trim(),
      });

      return res.json({
        success: true,
        commentId: result.commentId,
        flagCreated: result.flagCreated,
      });
    } catch (error) {
      console.error("Error creating intake comment:", error);
      return res.status(500).json({ error: "Failed to create intake comment" });
    }
  });

  // Get all active attention flags (bulk endpoint for list/kanban views)
  app.get("/api/attention-flags", async (_req, res) => {
    try {
      const flags = await getActiveAttentionFlags();
      return res.json({ flags });
    } catch (error) {
      console.error("Error getting attention flags:", error);
      return res.status(500).json({ error: "Failed to get attention flags" });
    }
  });

  // Clear an attention flag
  app.post("/api/attention-flags/:contactId/clear", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId, 10);
      if (isNaN(contactId)) {
        return res.status(400).json({ error: "contactId must be a number" });
      }

      const clearedByEmail = req.body.clearedByEmail;
      if (!clearedByEmail || typeof clearedByEmail !== "string" || !clearedByEmail.includes("@")) {
        return res.status(400).json({ error: "valid clearedByEmail is required" });
      }

      const cleared = await clearAttentionFlag(contactId, clearedByEmail.trim());
      return res.json({ success: true, cleared });
    } catch (error) {
      console.error("Error clearing attention flag:", error);
      return res.status(500).json({ error: "Failed to clear attention flag" });
    }
  });

  // ============================================================================
  // Direct Intake API (Form → CRM DB, no Excel/n8n in the path)
  // ============================================================================

  app.post("/api/intake", async (req: any, res) => {
    try {
      const b = req.body;

      if (!b.name || typeof b.name !== "string" || !b.name.trim()) {
        return res.status(400).json({ error: "name is required" });
      }

      const now = new Date().toISOString();
      const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

      // reasonForTherapy may arrive as string[] from the form — join to comma-separated
      const reasonForTherapy = Array.isArray(b.reasonForTherapy)
        ? b.reasonForTherapy.join(", ")
        : s(b.reasonForTherapy);

      // Optional intake source flag — default preserves existing public RFS behavior
      const rawSource = typeof b.source === "string" ? b.source.trim() : "";
      const isUploadedReferral = rawSource === "uploaded_referral";
      const intakeSource = isUploadedReferral ? "uploaded_referral" : "website_form";
      const submissionSource = isUploadedReferral ? "uploaded_referral" : "rfs_v2";
      const referralAuth = s(b.referralAuth) || s(b.referralNumber);

      // Build readable last_note for timeline display
      const lines: string[] = [`Intake ${now}`];
      if (s(b.requestingFor)) lines.push(`Requesting For: ${s(b.requestingFor)}`);
      if (s(b.reasonForSeeking)) lines.push(`Reason: ${s(b.reasonForSeeking)}`);
      if (reasonForTherapy) lines.push(`Therapy Type: ${reasonForTherapy}`);
      if (s(b.modality)) lines.push(`Modality: ${s(b.modality)}`);
      if (s(b.insurancePayer)) lines.push(`Insurance: ${s(b.insurancePayer)}`);
      if (s(b.referralSource)) lines.push(`Referral: ${s(b.referralSource)}`);
      if (referralAuth) lines.push(`Referral #: ${referralAuth}`);
      if (s(b.notes)) lines.push(`Notes: ${s(b.notes)}`);
      const lastNote = lines.join("\n");

      // Each RFS submission creates its own independent contact record
      const contactId = await generateIntakeContactId();

      // Immutable audit log — capture raw submission before any processing
      let submissionId: number | null = null;
      try {
        submissionId = await insertFormSubmission({
          source: submissionSource,
          contactId,
          name: b.name.trim(),
          payload: b,
        });
      } catch (err) {
        console.error("[INTAKE] Failed to log form submission (non-fatal):", err);
      }

      await insertIntakeContact({
        contactId,
        name: b.name.trim(),
        email: s(b.email),
        phone: s(b.phone),
        lastNote,
        sourceSubmissionId: submissionId,
        intakeSource,
        referralAuth,

        serviceRequested: s(b.serviceRequested) || reasonForTherapy,
        requestingFor: s(b.requestingFor),
        reasonForSeeking: s(b.reasonForSeeking),
        reasonForTherapy,
        detailedReason: s(b.detailedReason),
        formCompletedBy: s(b.formCompletedBy),
        modality: s(b.modality),
        referralSource: s(b.referralSource),
        priorServices: s(b.priorServices),
        priorProvider: s(b.priorProvider),
        preferredContact: s(b.preferredContact),
        custody: s(b.custody),
        flags: s(b.flags),
        priority: s(b.priority),

        insurancePayer: s(b.insurancePayer),
        insurancePlan: s(b.insurancePlan),
        insuranceId: s(b.insuranceId),

        patientDob: s(b.patientDob),
        gender: s(b.gender),

        streetAddress: s(b.streetAddress),
        city: s(b.city),
        state: s(b.state),
        zipCode: s(b.zipCode),
        county: s(b.county),
      });

      boardCache = null;

      if (isUploadedReferral) {
        await logActivity({
          type: "referral_uploaded",
          actorEmail: req.user?.email || "system",
          entityType: "contact",
          entityId: String(contactId),
          entityName: b.name.trim(),
          metadata: {
            referralSource: s(b.referralSource) || "",
            staffName: s(b.formCompletedBy) || req.user?.name || "",
          },
        });
      } else {
        await logActivity({
          type: "submission_received",
          actorEmail: "system",
          entityType: "contact",
          entityId: String(contactId),
          entityName: b.name.trim(),
          metadata: { formType: "Intake", source: "rfs_v2" },
        });
      }

      console.log(`[INTAKE] New contact created: ${contactId} (${b.name.trim()}) source=${intakeSource}`);

      return res.json({ success: true, contactId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Intake failed";
      console.error("[INTAKE] Error:", message);
      return res.status(500).json({ error: message });
    }
  });

  // ============================================================================
  // Sync API (n8n → CRM database)
  // ============================================================================

  // n8n pushes full Excel snapshot to this endpoint on a cron schedule
  app.post("/api/sync/contacts", async (req, res) => {
    try {
      if (!SYNC_API_KEY) {
        console.warn("[staging] /api/sync/contacts blocked — SYNC_API_KEY not configured");
        return res.status(503).json({ error: "Sync not configured for this environment" });
      }
      const apiKey = req.headers["x-sync-key"] as string;
      if (apiKey !== SYNC_API_KEY) {
        return res.status(401).json({ error: "Invalid sync key" });
      }

      const { contacts } = req.body;

      if (!contacts || !Array.isArray(contacts)) {
        return res.status(400).json({ error: "contacts array is required" });
      }

      console.log(`[sync] Received ${contacts.length} contacts from n8n`);

      const result = await syncContactsToDb(contacts);

      console.log(`[sync] Complete: ${result.synced} synced, ${result.skipped} unchanged, ${result.deleted} deleted in ${result.durationMs}ms`);

      return res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      console.error("[sync] Error:", message);
      recordSyncError(message);
      return res.status(500).json({ error: message });
    }
  });

  // Sync health status (for frontend badge + monitoring)
  app.get("/api/sync/status", async (_req, res) => {
    try {
      const meta = getSyncMeta();
      const contactCount = await getSyncContactCount();
      return res.json({ ...meta, contactCount });
    } catch (error) {
      console.error("[sync] Error fetching status:", error);
      return res.status(500).json({ error: "Failed to fetch sync status" });
    }
  });

  // Frontend-triggered full sync (fetches from n8n, updates SQLite cache)
  app.post("/api/sync/trigger", async (_req, res) => {
    try {
      if (isN8nDisabled(WAITLIST_BOARD_URL)) {
        console.warn("[staging] /api/sync/trigger skipped — n8n disabled");
        return res.json({ success: true, synced: 0, skipped: 0, deleted: 0, durationMs: 0, totalContacts: 0, stagingSkipped: true });
      }
      console.log("[sync-trigger] Frontend-triggered full sync starting...");

      const response = await fetch(WAITLIST_BOARD_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new Error(`n8n returned ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        throw new Error("Received HTML instead of JSON from n8n");
      }

      const text = await response.text();
      if (!text || text.trim() === "") {
        throw new Error("Empty response from n8n");
      }

      const data = JSON.parse(text);
      const contacts = Array.isArray(data) ? data : data.contacts || data.data || [];

      if (!Array.isArray(contacts) || contacts.length === 0) {
        throw new Error("No contacts returned from n8n");
      }

      console.log(`[sync-trigger] Fetched ${contacts.length} contacts from n8n, syncing to SQLite...`);

      const result = await syncContactsToDb(contacts);

      console.log(`[sync-trigger] Sync complete: ${result.synced} upserted, ${result.skipped} unchanged, ${result.deleted} deleted in ${result.durationMs}ms`);

      return res.json({
        success: true,
        synced: result.synced,
        skipped: result.skipped,
        deleted: result.deleted,
        durationMs: result.durationMs,
        totalContacts: contacts.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync trigger failed";
      console.error("[sync-trigger] Error:", message);
      recordSyncError(message);
      return res.status(500).json({ error: message });
    }
  });

  // Manual single-contact sync (admin-triggered refresh from Excel)
  app.post("/api/sync/contact/:contactId", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId, 10);
      if (isNaN(contactId)) {
        return res.status(400).json({ error: "contactId must be a number" });
      }

      if (isN8nDisabled(WAITLIST_BOARD_URL)) {
        console.warn(`[staging] Manual sync for contact ${contactId} skipped — n8n disabled`);
        return res.json({ success: true, stagingSkipped: true });
      }

      console.log(`[sync] Manual sync for contact ${contactId}`);

      let boardContact: Record<string, unknown> | null = null;
      try {
        const boardResponse = await fetch(WAITLIST_BOARD_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (boardResponse.ok) {
          const boardData = await boardResponse.json();
          const contacts = boardData.contacts || [];
          boardContact = contacts.find((c: any) => c.contactId === contactId) || null;
        }
      } catch (e) {
        console.warn(`[sync] Board fetch failed during manual sync:`, e);
      }

      if (!boardContact) {
        return res.status(404).json({ error: "Contact not found in Excel" });
      }

      // Step 2: Fetch detailed data from n8n snapshot
      let detailedData: Record<string, unknown> = {};
      try {
        const snapshotResponse = await fetch(N8N_ENDPOINTS.contactSnapshot, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId }),
        });
        if (snapshotResponse.ok) {
          const rawData = await snapshotResponse.json();
          detailedData = (rawData.contact || rawData || {}) as Record<string, unknown>;
        }
      } catch (e) {
        console.warn(`[sync] Snapshot fetch failed during manual sync:`, e);
      }

      // Step 3: Merge board + detailed data and upsert
      const merged = { ...boardContact, ...detailedData, contactId } as SyncPayloadContact;
      await upsertSingleContact(merged);

      // Step 4: Also enrich with detailed fields
      await enrichSyncContact(contactId, detailedData);

      // Step 5: Return the fresh contact
      const freshContact = await getSyncContactById(contactId);
      console.log(`[sync] Manual sync complete for contact ${contactId}`);

      return res.json({
        success: true,
        contact: freshContact,
      });
    } catch (error) {
      console.error("[sync] Manual sync error:", error);
      return res.status(500).json({ error: "Failed to sync contact" });
    }
  });

  // ============================================================================
  // Provider Assignments (CRM-only)
  // ============================================================================

  // Get all assignments for a contact
  app.get("/api/assignments/:contactId", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId, 10);
      if (isNaN(contactId)) {
        return res.status(400).json({ error: "contactId must be a number" });
      }

      const assignments = await getAssignmentsByContact(contactId);
      return res.json({ assignments });
    } catch (error) {
      console.error("Error getting assignments:", error);
      return res.status(500).json({ error: "Failed to get assignments" });
    }
  });

  // Create a provider assignment
  app.post("/api/assignments", async (req, res) => {
    try {
      const { contactId, contactName, providerName, credential, assignmentComment, assignedByEmail, assignedByInitials } = req.body;

      if (contactId === undefined || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }
      if (!contactName || typeof contactName !== "string" || contactName.trim() === "") {
        return res.status(400).json({ error: "contactName is required" });
      }
      if (!providerName || typeof providerName !== "string" || providerName.trim() === "") {
        return res.status(400).json({ error: "providerName is required" });
      }
      if (!credential || typeof credential !== "string" || credential.trim() === "") {
        return res.status(400).json({ error: "credential is required" });
      }
      if (!assignedByEmail || typeof assignedByEmail !== "string" || !assignedByEmail.includes("@")) {
        return res.status(400).json({ error: "valid assignedByEmail is required" });
      }
      if (!assignedByInitials || typeof assignedByInitials !== "string") {
        return res.status(400).json({ error: "assignedByInitials is required" });
      }

      const result = await createAssignment({
        contactId,
        contactName: contactName.trim(),
        providerName: providerName.trim(),
        credential: credential.trim(),
        assignmentComment: assignmentComment?.trim() || undefined,
        assignedByEmail: assignedByEmail.trim(),
        assignedByInitials: assignedByInitials.trim(),
      });

      await logActivity({
        type: "contact_assigned",
        actorEmail: assignedByEmail.trim(),
        entityType: "contact",
        entityId: String(contactId),
        entityName: contactName.trim(),
        metadata: {
          providerName: providerName.trim(),
          credential: credential.trim(),
          assignmentType: "provider",
        },
      });

      return res.json({
        success: true,
        assignmentId: result.assignmentId,
      });
    } catch (error) {
      console.error("Error creating assignment:", error);
      return res.status(500).json({ error: "Failed to create assignment" });
    }
  });

  // Delete a provider assignment
  app.delete("/api/assignments/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: "id must be a number" });
      }

      // Capture assignment context before deletion for audit trail
      const pool = (await import("./db/pool")).getPool();
      const { rows } = await pool.query(
        `SELECT contact_id AS "contactId", contact_name AS "contactName", provider_name AS "providerName"
         FROM contact_provider_assignments WHERE id = $1`,
        [id]
      );
      const assignmentContext = rows[0] as { contactId: number; contactName: string; providerName: string } | undefined;

      const deleted = await deleteAssignment(id);
      if (!deleted) {
        return res.status(404).json({ error: "Assignment not found" });
      }

      // Log the deletion
      if (assignmentContext) {
        await logActivity({
          type: "assignment_deleted",
          actorEmail: (req as any).user?.email || "system",
          entityType: "contact",
          entityId: String(assignmentContext.contactId),
          entityName: assignmentContext.contactName,
          metadata: { providerName: assignmentContext.providerName },
        });
      }

      return res.json({ success: true });
    } catch (error) {
      console.error("Error deleting assignment:", error);
      return res.status(500).json({ error: "Failed to delete assignment" });
    }
  });

  // Delete a note from a contact's timeline
  app.post("/api/delete-note", async (req, res) => {
    try {
      const { contactId, noteContent } = req.body;
      if (!contactId || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }
      if (!noteContent || typeof noteContent !== "string") {
        return res.status(400).json({ error: "noteContent (string) is required" });
      }
      const removed = await removeSyncContactNote(contactId, noteContent);
      if (!removed) {
        return res.status(404).json({ error: "Note not found" });
      }

      // Log the deletion
      const contactName = (await getSyncContactById(contactId))?.name || `Contact ${contactId}`;
      const preview = noteContent.trim().slice(0, 150);
      await logActivity({
        type: "note_deleted",
        actorEmail: (req as any).user?.email || "system",
        entityType: "contact",
        entityId: String(contactId),
        entityName: contactName,
        metadata: { preview },
      });

      boardCache = null;
      return res.json({ success: true });
    } catch (error) {
      console.error("Error deleting note:", error);
      return res.status(500).json({ error: "Failed to delete note" });
    }
  });

  // ============================================================================
  // TherapyNotes EHR Integration
  // ============================================================================

  // Get TN record status for a contact
  app.get("/api/therapy-notes/:contactId", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId, 10);
      if (isNaN(contactId)) {
        return res.status(400).json({ error: "contactId must be a number" });
      }

      const record = await getTnRecord(contactId);
      return res.json({ record });
    } catch (error) {
      console.error("[therapy-notes] Error getting record:", error);
      return res.status(500).json({ error: "Failed to get TherapyNotes status" });
    }
  });

  // Manually reset a TN link (e.g. patient deleted in TherapyNotes)
  app.post("/api/therapy-notes/reset", async (req, res) => {
    try {
      const userEmail = (req as unknown as { user?: { email?: string } }).user?.email || "";
      if (!userEmail || !TN_ALLOWED_EMAILS.includes(userEmail.toLowerCase())) {
        return res.status(403).json({ error: "Not authorized for TherapyNotes integration" });
      }

      const { contactId } = req.body;
      if (!contactId || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }

      const existing = await getTnRecord(contactId);
      if (!existing) {
        return res.status(404).json({ error: "No TherapyNotes record for this contact" });
      }

      await resetTnLink(contactId);

      // Fire-and-forget timeline log
      const author = userEmail.split("@")[0].substring(0, 3).toUpperCase();
      fetch(N8N_ENDPOINTS.addNote, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId,
          note: `[TherapyNotes] Link manually reset by ${userEmail}`,
          author,
          timestamp: new Date().toISOString(),
        }),
      }).catch((err) => console.error("[therapy-notes] Timeline log failed:", err));

      const record = await getTnRecord(contactId);
      return res.json({ success: true, record });
    } catch (error) {
      console.error("[therapy-notes] Error in reset endpoint:", error);
      return res.status(500).json({ error: "Failed to reset TherapyNotes link" });
    }
  });

  // Create TN patient — returns 202 immediately, TN agent runs async
  app.post("/api/therapy-notes/create", async (req, res) => {
    try {
      // Auth check
      const userEmail = (req as unknown as { user?: { email?: string } }).user?.email || "";
      if (!userEmail || !TN_ALLOWED_EMAILS.includes(userEmail.toLowerCase())) {
        return res.status(403).json({ error: "Not authorized for TherapyNotes integration" });
      }

      const { contactId } = req.body;
      if (!contactId || typeof contactId !== "number") {
        return res.status(400).json({ error: "contactId (number) is required" });
      }

      // Check existing record
      const existing = await getTnRecord(contactId);
      if (existing) {
        if (existing.tnStatus === "created") {
          return res.status(200).json({ status: "created", record: existing });
        }
        if (existing.tnStatus === "in_progress" && !isStaleInProgress(existing)) {
          return res.status(409).json({ status: "in_progress", record: existing });
        }
        // Stale in_progress or failed → reset for retry
        await resetTnRecordForRetry(contactId);
      } else {
        // New record
        const contactName = req.body.contactName || "Unknown";
        await createTnRecord({ contactId, contactName, createdByEmail: userEmail });
      }

      // Validate TN_API_KEY
      if (!process.env.TN_API_KEY) {
        await updateTnStatus(contactId, "failed", { failureReason: "TN_API_KEY not configured on server" });
        return res.status(500).json({ error: "TherapyNotes API key not configured" });
      }

      // Log therapy_notes_started activity
      const contactName = req.body.contactName || (await getSyncContactById(contactId))?.name || `Contact ${contactId}`;
      await logActivity({
        type: "therapy_notes_started",
        actorEmail: userEmail,
        entityType: "contact",
        entityId: String(contactId),
        entityName: contactName,
        metadata: { contactId },
      });

      // Return 202 immediately
      const record = await getTnRecord(contactId);
      res.status(202).json({ status: "in_progress", record });

      // Detached async: read data → validate → call TN agent (with retry) → update record
      (async () => {
        const TN_MAX_RETRIES = 2;
        const TN_BASE_DELAY_MS = 3000;

        try {
          console.log(`[TN] Started for contact ${contactId}`);

          // ---- Step 1: Get contact data from LOCAL DB (no n8n dependency) ----
          let snapshot: Record<string, unknown> | null = null;
          const localContact = await getSyncContactById(contactId);

          if (localContact && localContact.name) {
            console.log(`[TN] Using local sync_contacts data for ${contactId}`);
            snapshot = localContact as unknown as Record<string, unknown>;
          } else {
            // Fallback to n8n if local data is missing/incomplete
            console.warn(`[TN] Local data missing for ${contactId}, falling back to n8n snapshot`);
            const snapshotResponse = await fetch(N8N_ENDPOINTS.contactSnapshot, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contactId }),
            });

            if (!snapshotResponse.ok) {
              throw new Error(`n8n snapshot returned ${snapshotResponse.status}`);
            }

            const rawData = await snapshotResponse.json() as Record<string, unknown>;
            snapshot = (rawData.contact || rawData || {}) as Record<string, unknown>;
          }

          // ---- Step 2: Build payload ----
          const fullName = (snapshot.name as string) || "";
          const { firstName, lastName } = parseName(fullName);

          // Convert DOB: Excel serial → MM/DD/YYYY, ISO string → MM/DD/YYYY
          let dob = "";
          const rawDob = snapshot.patientDob;
          if (typeof rawDob === "number" && rawDob > 15000 && rawDob < 80000) {
            dob = excelSerialToMMDDYYYY(rawDob);
          } else if (typeof rawDob === "string" && rawDob.length > 0) {
            const isoMatch = rawDob.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (isoMatch) {
              dob = `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`;
            } else {
              dob = rawDob;
            }
          }

          const payload: TnAgentPayload = {
            first_name: firstName,
            last_name: lastName,
            dob,
            email: (snapshot.email as string) || "",
            address: (snapshot.streetAddress as string) || "",
            zip: (snapshot.zipCode as string) || "",
            sex: (snapshot.gender as string) || "",
            eil: (snapshot.insuranceId as string) || "",
            phone: (snapshot.phone as string) || "",
            rfs_url: (snapshot.rfsLink as string) || "",
          };

          console.log(`[TN] Payload built: ${firstName} ${lastName}, DOB=${dob}`);

          // ---- Step 3: Pre-validate critical fields ----
          const missingFields: string[] = [];
          if (!payload.first_name) missingFields.push("first_name");
          if (!payload.last_name) missingFields.push("last_name");
          if (!payload.dob) missingFields.push("dob");

          if (missingFields.length > 0) {
            const reason = `Missing critical fields: ${missingFields.join(", ")}`;
            console.error(`[TN] Pre-validation failed: ${reason}`);
            await updateTnStatus(contactId, "failed", { failureReason: reason });
            return;
          }

          if (isN8nDisabled(TN_AGENT_URL) || !process.env.TN_API_KEY) {
            console.warn("[TN] Skipped — TN_AGENT_URL or TN_API_KEY not configured");
            await updateTnStatus(contactId, "failed", { failureReason: "TherapyNotes disabled in this environment" });
            return;
          }

          // ---- Step 4: Call TN agent with retry ----
          let lastError = "";
          for (let attempt = 0; attempt <= TN_MAX_RETRIES; attempt++) {
            if (attempt > 0) {
              const delay = TN_BASE_DELAY_MS * Math.pow(2, attempt - 1);
              console.log(`[TN] Retry ${attempt}/${TN_MAX_RETRIES} after ${delay}ms`);
              await new Promise(r => setTimeout(r, delay));
            }

            try {
              console.log(`[TN] Agent call attempt ${attempt + 1}/${TN_MAX_RETRIES + 1}`);

              const tnResponse = await fetch(TN_AGENT_URL, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-API-Key": process.env.TN_API_KEY!,
                },
                body: JSON.stringify(payload),
              });

              const rawTnText = await tnResponse.text();
              let tnResult: TnAgentResponse;
              try {
                tnResult = JSON.parse(rawTnText) as TnAgentResponse;
              } catch {
                throw new Error(`TN agent returned invalid JSON (HTTP ${tnResponse.status})`);
              }

              if (tnResult.status === "success") {
                console.log(`[TN] Success: url=${tnResult.tn_patient_url}`);
                await updateTnStatus(contactId, "created", {
                  url: tnResult.tn_patient_url,
                  id: tnResult.tn_patient_id,
                });

                // Log therapy_notes_created activity
                const contactName = (await getSyncContactById(contactId))?.name || `Contact ${contactId}`;
                await logActivity({
                  type: "therapy_notes_created",
                  actorEmail: userEmail,
                  entityType: "contact",
                  entityId: String(contactId),
                  entityName: contactName,
                  metadata: {
                    contactId,
                    tnPatientId: tnResult.tn_patient_id,
                    tnPatientUrl: tnResult.tn_patient_url,
                  },
                });

                // Fire-and-forget timeline log
                const author = userEmail.split("@")[0].substring(0, 3).toUpperCase();
                fetch(N8N_ENDPOINTS.addNote, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    contactId,
                    note: `[TherapyNotes] Patient created successfully: ${tnResult.tn_patient_url || "N/A"}`,
                    author,
                    timestamp: new Date().toISOString(),
                  }),
                }).catch((err) => console.error("[TN] Timeline log failed:", err));
                return; // Success — exit retry loop
              }

              // Agent returned error — may be retryable
              lastError = tnResult.failure_reason || "TN agent returned error";
              console.warn(`[TN] Agent error (attempt ${attempt + 1}): ${lastError}`);
            } catch (fetchErr) {
              lastError = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
              console.error(`[TN] Fetch error (attempt ${attempt + 1}): ${lastError}`);
            }
          }

          // All retries exhausted
          console.error(`[TN] All attempts failed for contact ${contactId}: ${lastError}`);
          await updateTnStatus(contactId, "failed", { failureReason: lastError });

          // Log therapy_notes_failed activity
          await logActivity({
            type: "therapy_notes_failed",
            actorEmail: userEmail,
            entityType: "contact",
            entityId: String(contactId),
            entityName: (await getSyncContactById(contactId))?.name || `Contact ${contactId}`,
            metadata: { contactId, failureReason: lastError, attempts: TN_MAX_RETRIES + 1 },
          });

          // Fire-and-forget timeline log for failure
          const author = userEmail.split("@")[0].substring(0, 3).toUpperCase();
          fetch(N8N_ENDPOINTS.addNote, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contactId,
              note: `[TherapyNotes] Patient creation failed after ${TN_MAX_RETRIES + 1} attempts: ${lastError}`,
              author,
              timestamp: new Date().toISOString(),
            }),
          }).catch((err) => console.error("[TN] Timeline log failed:", err));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[TN] Unexpected error for contact ${contactId}: ${message}`);
          await updateTnStatus(contactId, "failed", { failureReason: message });

          await logActivity({
            type: "therapy_notes_failed",
            actorEmail: userEmail,
            entityType: "contact",
            entityId: String(contactId),
            entityName: (await getSyncContactById(contactId))?.name || `Contact ${contactId}`,
            metadata: { contactId, failureReason: message },
          });
        }

        console.log(`[TN] Final state:`, JSON.stringify(await getTnRecord(contactId)));
      })();
    } catch (error) {
      console.error("[therapy-notes] Error in create endpoint:", error);
      return res.status(500).json({ error: "Failed to start TherapyNotes creation" });
    }
  });

  // ============================================================================
  // Submissions API (immutable audit log)
  // ============================================================================

  app.get("/api/submissions", async (_req, res) => {
    try {
      const submissions = await getRecentSubmissions(50);
      return res.json({ submissions });
    } catch (error) {
      console.error("[submissions] Error fetching submissions:", error);
      return res.status(500).json({ error: "Failed to fetch submissions" });
    }
  });

  // Unified form ingestion — any form can POST here
  app.post("/api/submissions", async (req, res) => {
    try {
      const { formType, source, submittedAt, data, contactId, name } = req.body;

      if (!formType || typeof formType !== "string") {
        return res.status(400).json({ error: "formType is required (string)" });
      }
      if (!source || typeof source !== "string") {
        return res.status(400).json({ error: "source is required (string)" });
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return res.status(400).json({ error: "data is required (object)" });
      }

      // Validate submittedAt if provided
      let normalizedSubmittedAt: string | undefined;
      if (submittedAt) {
        const parsed = new Date(submittedAt);
        if (isNaN(parsed.getTime())) {
          return res.status(400).json({ error: "submittedAt must be a valid ISO timestamp" });
        }
        normalizedSubmittedAt = parsed.toISOString();
      }

      const id = await insertSubmission({
        formType: formType.trim(),
        source: source.trim(),
        submittedAt: normalizedSubmittedAt,
        contactId: typeof contactId === "number" ? contactId : null,
        name: typeof name === "string" ? name.trim() : "",
        data,
      });

      await logActivity({
        type: "submission_received",
        actorEmail: "system",
        entityType: "submission",
        entityId: String(id),
        entityName: typeof name === "string" ? name.trim() : String(data.patientName || data.name || ""),
        metadata: { formType, source },
      });

      console.log(`[submissions] Ingested: id=${id} formType=${formType} source=${source}`);
      return res.json({ success: true, id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Submission failed";
      console.error("[submissions] Error:", message);
      return res.status(500).json({ error: message });
    }
  });

  // ============================================================================
  // Migration API (one-time Excel → CRM import)
  // ============================================================================

  const MIGRATE_API_KEY = process.env.MIGRATE_API_KEY || "";
  const VALID_MIGRATE_STATUS_CODES = [100, 101, 102, 103, 104, 200, 201, 202, 203, 204, 205, 300, 400];

  const STATUS_LABELS: Record<number, string> = {
    100: "New — No Outreach",
    101: "Waiting — Initial Contact",
    102: "Waiting — On Waitlist",
    103: "Waiting — Needs Follow-up",
    104: "Waiting — Pending Paperwork",
    200: "Ready to Schedule",
    201: "Scheduling — New Assignment",
    202: "Scheduling — Assigned",
    203: "Scheduling — Attempted",
    204: "Scheduling — PM Review",
    205: "Scheduled",
    300: "Active",
    400: "Insurance Not Accepted",
  };

  app.post("/api/migrate", async (req, res) => {
    console.log("[MIGRATE ENDPOINT HIT]", { dryRun: req.query.dryRun, bodySize: JSON.stringify(req.body || {}).length });
    try {
      // Step 2: Security — require X-Migrate-Key header
      if (!MIGRATE_API_KEY) {
        return res.status(500).json({ error: "MIGRATE_API_KEY not configured on server" });
      }
      const providedKey = req.headers["x-migrate-key"];
      if (providedKey !== MIGRATE_API_KEY) {
        return res.status(401).json({ error: "Invalid or missing X-Migrate-Key header" });
      }

      const dryRun = req.query.dryRun === "true";
      const { contacts, mode = "insert" } = req.body;

      if (mode !== "insert" && mode !== "merge" && mode !== "fullsync") {
        return res.status(400).json({ error: 'mode must be "insert", "merge", or "fullsync"' });
      }

      if (!Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({ error: "Request body must contain a non-empty contacts array" });
      }

      // Validation + normalization pass
      const validContacts: MigrationContact[] = [];
      const errors: Array<{ contactId: number | null; field: string; message: string }> = [];
      const stats = {
        statusDistribution: {} as Record<number, number>,
        missingFields: {} as Record<string, number>,
        dateParsing: { dobSuccess: 0, dobFailed: 0, dateAddedSuccess: 0, dateAddedFailed: 0 },
        insuranceVariants: {} as Record<string, number>,
      };

      for (let i = 0; i < contacts.length; i++) {
        const raw = contacts[i];
        const rowLabel = raw.contactId ?? `row-${i}`;
        let rowValid = true;

        // Required fields
        if (raw.contactId === undefined || raw.contactId === null || typeof raw.contactId !== "number") {
          errors.push({ contactId: rowLabel, field: "contactId", message: "Missing or non-numeric contactId" });
          rowValid = false;
        }
        if (!raw.name || typeof raw.name !== "string" || raw.name.trim() === "") {
          errors.push({ contactId: rowLabel, field: "name", message: "Missing or empty name" });
          rowValid = false;
        }

        // Status code validation
        const statusCode = typeof raw.statusCode === "number" ? raw.statusCode : null;
        if (statusCode !== null && !VALID_MIGRATE_STATUS_CODES.includes(statusCode)) {
          errors.push({ contactId: rowLabel, field: "statusCode", message: `Invalid status code: ${statusCode}` });
          rowValid = false;
        }

        // Date normalization: patientDob (M/D/YYYY → YYYY-MM-DD)
        let patientDob: string | null = null;
        if (raw.patientDob) {
          patientDob = normalizeDateValue(raw.patientDob);
          if (patientDob) {
            stats.dateParsing.dobSuccess++;
          } else {
            stats.dateParsing.dobFailed++;
            errors.push({ contactId: rowLabel, field: "patientDob", message: `Failed to parse DOB: "${raw.patientDob}"` });
          }
        }

        // Date normalization: dateAdded
        let dateAdded: string | null = null;
        if (raw.dateAdded) {
          dateAdded = normalizeDateValue(raw.dateAdded);
          if (dateAdded) {
            stats.dateParsing.dateAddedSuccess++;
          } else {
            stats.dateParsing.dateAddedFailed++;
            errors.push({ contactId: rowLabel, field: "dateAdded", message: `Failed to parse dateAdded: "${raw.dateAdded}"` });
          }
        }

        // Track stats
        if (statusCode !== null) {
          stats.statusDistribution[statusCode] = (stats.statusDistribution[statusCode] || 0) + 1;
        }

        // Track missing optional fields
        const optionalFields = [
          "email", "phone", "insurancePayer", "patientDob", "dateAdded",
          "reasonForTherapy", "lastNote", "assignedTo", "gender",
          "streetAddress", "city", "state", "zipCode",
        ];
        for (const f of optionalFields) {
          if (!raw[f] || (typeof raw[f] === "string" && raw[f].trim() === "")) {
            stats.missingFields[f] = (stats.missingFields[f] || 0) + 1;
          }
        }

        // Track insurance variants
        if (raw.insurancePayer && typeof raw.insurancePayer === "string" && raw.insurancePayer.trim() !== "") {
          const payer = raw.insurancePayer.trim();
          stats.insuranceVariants[payer] = (stats.insuranceVariants[payer] || 0) + 1;
        }

        // Compute age from DOB
        let age: number | null = null;
        if (patientDob) {
          const dobDate = new Date(patientDob);
          const now = new Date();
          age = now.getFullYear() - dobDate.getFullYear();
          const monthDiff = now.getMonth() - dobDate.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dobDate.getDate())) {
            age--;
          }
        }

        if (rowValid) {
          const status = statusCode !== null ? (STATUS_LABELS[statusCode] || String(statusCode)) : null;
          validContacts.push({
            contactId: raw.contactId,
            name: raw.name.trim(),
            email: raw.email?.trim() || null,
            phone: raw.phone?.trim() || null,
            status,
            statusCode,
            serviceRequested: raw.serviceRequested?.trim() || null,
            daysOnWaitlist: typeof raw.daysOnWaitlist === "number" ? raw.daysOnWaitlist : null,
            dateAdded,
            assignedTo: raw.assignedTo?.trim() || null,
            requestingFor: raw.requestingFor?.trim() || null,
            reasonForSeeking: raw.reasonForSeeking?.trim() || null,
            reasonForTherapy: raw.reasonForTherapy?.trim() || null,
            detailedReason: raw.detailedReason?.trim() || null,
            formCompletedBy: raw.formCompletedBy?.trim() || null,
            modality: raw.modality?.trim() || null,
            priorServices: raw.priorServices?.trim() || null,
            priorProvider: raw.priorProvider?.trim() || null,
            insurancePayer: raw.insurancePayer?.trim() || null,
            insurancePlan: raw.insurancePlan?.trim() || null,
            insuranceId: raw.insuranceId?.trim() || null,
            patientDob,
            gender: raw.gender?.trim() || null,
            age,
            streetAddress: raw.streetAddress?.trim() || null,
            city: raw.city?.trim() || null,
            state: raw.state?.trim() || null,
            zipCode: raw.zipCode?.trim() || null,
            rfsLink: raw.rfsLink?.trim() || null,
            lastNote: raw.lastNote || null,
            flags: raw.flags?.trim() || null,
          });
        }
      }

      // Dry run: return validation results only
      if (dryRun) {
        console.log("[MIGRATION] Dry run complete", {
          total: contacts.length,
          valid: validContacts.length,
          invalid: contacts.length - validContacts.length,
          errors: errors.length,
        });
        return res.json({
          dryRun: true,
          total: contacts.length,
          valid: validContacts.length,
          invalid: contacts.length - validContacts.length,
          errors,
          stats,
        });
      }

      // Real migration: insert or merge into DB
      if (mode === "merge") {
        const result = await mergeMigrationContacts(validContacts);

        console.log("[MIGRATION:MERGE]", {
          total: contacts.length,
          valid: validContacts.length,
          inserted: result.inserted,
          updated: result.updated,
          skipped: result.skipped,
          errors: result.errors.length + errors.length,
        });

        return res.json({
          success: true,
          mode: "merge",
          total: contacts.length,
          valid: validContacts.length,
          inserted: result.inserted,
          updated: result.updated,
          skipped: result.skipped,
          errors: [
            ...errors,
            ...result.errors.map((e) => ({ contactId: e.contactId, field: "db", message: e.message })),
          ],
          stats,
        });
      }

      if (mode === "fullsync") {
        const result = await fullSyncMigrationContacts(validContacts);

        console.log("[MIGRATION:FULLSYNC]", {
          total: contacts.length,
          valid: validContacts.length,
          inserted: result.inserted,
          updated: result.updated,
          unchanged: result.unchanged,
          errors: result.errors.length + errors.length,
        });

        return res.json({
          success: true,
          mode: "fullsync",
          total: contacts.length,
          valid: validContacts.length,
          inserted: result.inserted,
          updated: result.updated,
          unchanged: result.unchanged,
          errors: [
            ...errors,
            ...result.errors.map((e) => ({ contactId: e.contactId, field: "db", message: e.message })),
          ],
          stats,
        });
      }

      const result = await insertMigrationContacts(validContacts);

      console.log("[MIGRATION:INSERT]", {
        total: contacts.length,
        valid: validContacts.length,
        migrated: result.migrated,
        skipped: result.skipped,
        errors: result.errors.length + errors.length,
      });

      return res.json({
        success: true,
        mode: "insert",
        total: contacts.length,
        valid: validContacts.length,
        migrated: result.migrated,
        skipped: result.skipped,
        errors: [
          ...errors,
          ...result.errors.map((e) => ({ contactId: e.contactId, field: "db", message: e.message })),
        ],
        stats,
      });
    } catch (error) {
      console.error("[MIGRATION] Fatal error:", error);
      return res.status(500).json({
        error: "Migration failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ============================================================================
  // Intake PDF API
  // ============================================================================

  app.get("/api/contact/:id/intake-pdf", async (req, res) => {
    try {
      const contactId = parseInt(req.params.id, 10);
      if (isNaN(contactId)) {
        return res.status(400).json({ error: "contactId must be a number" });
      }

      const contact = await getSyncContactById(contactId);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }

      const hasIntake = contact.requestingFor || contact.reasonForSeeking ||
        contact.reasonForTherapy || contact.formCompletedBy || contact.modality ||
        contact.insurancePayer || contact.referralSource || contact.priorServices ||
        contact.patientDob || contact.gender || contact.streetAddress || contact.city;

      if (!hasIntake) {
        return res.status(404).json({ error: "No intake data available for this contact" });
      }

      // Fetch latest submission to get participant data from raw payload
      const submissions = await getSubmissionsForContact(contactId);
      const latestPayload = submissions.length > 0
        ? (submissions[0].payload as Record<string, unknown>)
        : null;

      const pdfmake = require("pdfmake");
      pdfmake.addFonts(require("pdfmake/standard-fonts/Helvetica"));

      const { buildIntakeDocument } = await import("./pdf/intake-template");
      const docDefinition = buildIntakeDocument(contact, latestPayload);
      const pdfDoc = pdfmake.createPdf(docDefinition);

      const safeName = contact.name.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "-");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Intake-${safeName}-${contact.contactId}.pdf"`
      );
      res.setHeader("Cache-Control", "no-cache");

      const stream = await pdfDoc.getStream();
      stream.pipe(res);
      stream.end();
    } catch (error) {
      console.error("[intake-pdf] Error generating PDF:", error);
      return res.status(500).json({ error: "Failed to generate intake PDF" });
    }
  });

  // Per-submission intake PDF (multi-intake support)
  app.get("/api/intake/pdf/:submissionId", async (req, res) => {
    try {
      const submissionId = parseInt(req.params.submissionId, 10);
      if (isNaN(submissionId)) {
        return res.status(400).json({ error: "submissionId must be a number" });
      }

      const submission = await getSubmissionById(submissionId);
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const pdfmake = require("pdfmake");
      pdfmake.addFonts(require("pdfmake/standard-fonts/Helvetica"));

      const { buildSubmissionDocument } = await import("./pdf/intake-template");
      const docDefinition = buildSubmissionDocument(submission);
      const pdfDoc = pdfmake.createPdf(docDefinition);

      const safeName = submission.name.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "-");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Intake-${safeName}-Sub${submission.id}.pdf"`
      );
      res.setHeader("Cache-Control", "no-cache");

      const stream = await pdfDoc.getStream();
      stream.pipe(res);
      stream.end();
    } catch (error) {
      console.error("[intake-pdf] Error generating submission PDF:", error);
      return res.status(500).json({ error: "Failed to generate intake PDF" });
    }
  });

  // Insights PDF report
  app.get("/api/export/insights.pdf", async (_req, res) => {
    try {
      const { computeInsightsMetrics, buildInsightsDocument } = await import("./pdf/insights-template");
      const metrics = await computeInsightsMetrics();
      const docDefinition = buildInsightsDocument(metrics);

      const pdfmake = require("pdfmake");
      pdfmake.addFonts(require("pdfmake/standard-fonts/Helvetica"));
      const pdfDoc = pdfmake.createPdf(docDefinition);

      const now = new Date();
      const ts = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "-",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
      ].join("");

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="insights-${ts}.pdf"`);
      res.setHeader("Cache-Control", "no-cache");

      const stream = await pdfDoc.getStream();
      stream.pipe(res);
      stream.end();
    } catch (error) {
      console.error("[insights-pdf] Error:", error);
      return res.status(500).json({ error: "Failed to generate insights PDF" });
    }
  });

  // ============================================================================
  // Email Snapshots API
  // ============================================================================

  // Get snapshot metadata for a contact (no HTML body)
  app.get("/api/email-snapshots/:contactId", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId, 10);
      if (isNaN(contactId)) {
        return res.status(400).json({ error: "contactId must be a number" });
      }
      const snapshots = await getSnapshotsForContact(contactId);
      return res.json({ snapshots });
    } catch (error) {
      console.error("[email-snapshots] Error fetching snapshots:", error);
      return res.status(500).json({ error: "Failed to fetch email snapshots" });
    }
  });

  // Get a single snapshot with full HTML body (for download)
  app.get("/api/email-snapshot/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: "id must be a number" });
      }
      const snapshot = await getEmailSnapshot(id);
      if (!snapshot) {
        return res.status(404).json({ error: "Snapshot not found" });
      }
      return res.json(snapshot);
    } catch (error) {
      console.error("[email-snapshots] Error fetching snapshot:", error);
      return res.status(500).json({ error: "Failed to fetch email snapshot" });
    }
  });

  // ============================================================================
  // Activity Timeline
  // ============================================================================

  app.get("/api/activity", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit)) || 100, 500);
      const activities = await getRecentActivity(limit);
      return res.json({ activities });
    } catch (error) {
      console.error("[activity] Error fetching activity:", error);
      return res.status(500).json({ error: "Failed to fetch activity" });
    }
  });

  // Contact-scoped activity (for contact timeline)
  app.get("/api/activity/contact/:contactId", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId, 10);
      if (isNaN(contactId) || contactId <= 0) {
        return res.status(400).json({ error: "Invalid contactId" });
      }
      const activities = await getActivityForContact(contactId);
      return res.json({ activities });
    } catch (error) {
      console.error("[activity] Error fetching contact activity:", error);
      return res.status(500).json({ error: "Failed to fetch contact activity" });
    }
  });

  app.get("/api/activity/staff-summary", async (_req, res) => {
    try {
      const days = 7;
      const staff = await getStaffActivitySummary(days);
      return res.json({ staff, days });
    } catch (error) {
      console.error("[activity] Error fetching staff summary:", error);
      return res.status(500).json({ error: "Failed to fetch staff summary" });
    }
  });

  // Time-in-status: per-contact tenure and per-code aggregates.
  // Auth: same surface as the rest of /api/activity (session-mounted middleware).
  // NULL byContact[].timeInCurrentStatusSeconds means "no logged event places
  // this contact on its current status_code" — typically a sync-driven contact
  // whose status mutations predate the status_changed logging coverage.
  app.get("/api/insights/status-durations", async (_req, res) => {
    try {
      const result = await getStatusDurations();
      return res.json(result);
    } catch (error) {
      console.error("[insights] Error computing status durations:", error);
      return res.status(500).json({ error: "Failed to compute status durations" });
    }
  });

  // ============================================================================
  // Export: Waitlist Snapshot
  // ============================================================================

  // Shared auth check for all export endpoints
  // Accepts EITHER: session auth (logged-in CRM user) OR X-Sync-Key (n8n)
  function checkExportAuth(req: any, res: any): boolean {
    // Session-authenticated users pass through
    if (req.isAuthenticated && req.isAuthenticated()) return true;

    // Fall back to API key auth (for n8n / external callers)
    const apiKey = req.headers["x-sync-key"] as string;
    if (SYNC_API_KEY && apiKey === SYNC_API_KEY) return true;

    res.status(401).json({ error: "Authentication required" });
    return false;
  }

  // JSON export (for n8n or programmatic consumers)
  app.get("/api/export/waitlist", async (req, res) => {
    try {
      if (!checkExportAuth(req, res)) return;
      const result = await getWaitlistExportData();
      console.log(`[export] JSON: ${result.total} rows`);
      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Export failed";
      console.error("[export] Error:", message);
      return res.status(500).json({ error: message });
    }
  });

  // CSV export (file download)
  app.get("/api/export/waitlist.csv", async (req, res) => {
    try {
      if (!checkExportAuth(req, res)) return;
      const { rows, total } = await getWaitlistExportData();
      console.log(`[export] CSV: ${total} rows`);

      // Build CSV: header + rows, using canonical column order
      const escape = (v: unknown): string => {
        const s = String(v ?? "");
        if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      };

      const header = WAITLIST_EXPORT_COLUMNS.map(escape).join(",");
      const lines = rows.map(row =>
        WAITLIST_EXPORT_COLUMNS.map(col => escape(row[col])).join(",")
      );

      const csv = header + "\r\n" + lines.join("\r\n") + "\r\n";

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="waitlist-export.csv"');
      return res.send(csv);
    } catch (error) {
      const message = error instanceof Error ? error.message : "CSV export failed";
      console.error("[export] CSV Error:", message);
      return res.status(500).json({ error: message });
    }
  });

  // Excel export (file download)
  app.get("/api/export/waitlist.xlsx", async (req, res) => {
    try {
      if (!checkExportAuth(req, res)) return;
      const { rows, total } = await getWaitlistExportData();
      console.log(`[export] XLSX: ${total} rows`);

      // Build worksheet from rows using canonical column order
      const wsData = rows.map(row =>
        WAITLIST_EXPORT_COLUMNS.reduce((obj, col) => {
          obj[col] = row[col];
          return obj;
        }, {} as Record<string, unknown>)
      );

      const ws = XLSX.utils.json_to_sheet(wsData, { header: [...WAITLIST_EXPORT_COLUMNS] });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Waitlist");

      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="waitlist-export.xlsx"');
      return res.send(buf);
    } catch (error) {
      const message = error instanceof Error ? error.message : "XLSX export failed";
      console.error("[export] XLSX Error:", message);
      return res.status(500).json({ error: message });
    }
  });

  return httpServer;
}
