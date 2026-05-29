import { apiRequest } from "./queryClient";
import type { ContactSnapshot, WaitlistContact, WaitlistSummary } from "@shared/schema";
import type { DataSource, DataMode } from "./data-source-context";

export type WithSource<T> = T & { _source?: DataSource };

export async function getContactSnapshot(contactId: number): Promise<WithSource<ContactSnapshot>> {
  const response = await apiRequest("POST", "/api/get-contact-snapshot", { contactId });
  return response.json();
}

export async function getWaitlistSummary(): Promise<WithSource<WaitlistSummary>> {
  const response = await apiRequest("POST", "/api/get-waitlist-summary");
  return response.json();
}

export async function getWaitlistContacts(): Promise<{ contacts: WaitlistContact[]; _source?: DataSource }> {
  const response = await fetch("/api/waitlist-contacts", {
    cache: "no-store", // CRITICAL: Prevent browser caching
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch waitlist contacts");
  }
  return response.json();
}

export async function getWaitlistBoard(): Promise<{ contacts: WaitlistContact[]; _source?: DataSource }> {
  const response = await apiRequest("POST", "/api/get-waitlist-board");
  return response.json();
}

export async function getConfig(): Promise<{ dataMode: DataMode }> {
  const response = await fetch("/api/config", {
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch config");
  }
  return response.json();
}

export async function updateContactStatus(
  contactId: number,
  statusCode: number
): Promise<{ success: boolean; contactId: number; newStatus: number }> {
  // CANONICAL ENFORCEMENT: contactId is mandatory for all status updates
  if (contactId === undefined || contactId === null || isNaN(contactId)) {
    throw new Error("[API] contactId is required for status updates");
  }
  if (statusCode === undefined || statusCode === null || isNaN(statusCode)) {
    throw new Error("[API] statusCode is required for status updates");
  }

  const response = await apiRequest("POST", "/api/update-status", {
    contactId,
    statusCode,
  });
  return response.json();
}

export interface AddNoteParams {
  contactId: number;
  note: string;
  author: string;    // User initials (e.g., "RP")
  timestamp: string; // ISO or formatted timestamp
}

export async function addNoteToContact(
  params: AddNoteParams
): Promise<{ success: boolean; contactId: number; note: { date: string; content: string } }> {
  const { contactId, note, author, timestamp } = params;

  // CANONICAL ENFORCEMENT: All fields are mandatory
  if (contactId === undefined || contactId === null || isNaN(contactId)) {
    throw new Error("[API] contactId is required for adding notes");
  }
  if (!note || typeof note !== "string" || note.trim() === "") {
    throw new Error("[API] note content is required");
  }
  if (!author || typeof author !== "string" || author.trim() === "") {
    throw new Error("[API] author initials are required");
  }
  if (!timestamp || typeof timestamp !== "string") {
    throw new Error("[API] timestamp is required");
  }

  const response = await apiRequest("POST", "/api/add-note", {
    contactId,
    note: note.trim(),
    author: author.trim(),
    timestamp,
  });
  return response.json();
}

export async function deleteNote(contactId: number, noteContent: string): Promise<{ success: boolean }> {
  const response = await apiRequest("POST", "/api/delete-note", { contactId, noteContent });
  return response.json();
}

export async function deleteAssignment(assignmentId: number): Promise<{ success: boolean }> {
  const response = await apiRequest("DELETE", `/api/assignments/${assignmentId}`);
  return response.json();
}

export interface CreateReminderParams {
  contactId: number;
  contactName: string;
  createdByEmail: string;
  reminderText: string;
  reminderDateTime: string;       // ISO 8601
  secondReminderDateTime?: string; // ISO 8601, optional
}

export async function createReminder(
  params: CreateReminderParams
): Promise<{ success: boolean; id: string; _source?: string }> {
  const { contactId, contactName, createdByEmail, reminderText, reminderDateTime, secondReminderDateTime } = params;

  // Validation
  if (contactId === undefined || contactId === null || isNaN(contactId)) {
    throw new Error("[API] contactId is required for creating reminders");
  }
  if (!contactName || typeof contactName !== "string" || contactName.trim() === "") {
    throw new Error("[API] contactName is required");
  }
  if (!createdByEmail || typeof createdByEmail !== "string" || !createdByEmail.includes("@")) {
    throw new Error("[API] valid createdByEmail is required");
  }
  if (!reminderText || typeof reminderText !== "string" || reminderText.trim() === "") {
    throw new Error("[API] reminderText is required");
  }
  if (!reminderDateTime || typeof reminderDateTime !== "string") {
    throw new Error("[API] reminderDateTime is required");
  }

  const response = await apiRequest("POST", "/api/reminders", {
    contactId,
    contactName: contactName.trim(),
    createdByEmail: createdByEmail.trim(),
    reminderText: reminderText.trim(),
    reminderDateTime,
    secondReminderDateTime,
  });
  return response.json();
}

// ============================================================================
// Task Ownership API
// ============================================================================

export interface AssignmentResponse {
  success: boolean;
  contactId: number;
  assignedTo: string | null;
}

export async function assignContact(
  contactId: number,
  assignedTo: string | null
): Promise<AssignmentResponse> {
  // Validation
  if (contactId === undefined || contactId === null || isNaN(contactId)) {
    throw new Error("[API] contactId is required for assignment");
  }

  const response = await apiRequest("POST", "/api/assign-contact", {
    contactId,
    assignedTo,
  });
  return response.json();
}

export async function getStaffList(): Promise<{ staff: string[] }> {
  const response = await fetch("/api/staff-list", {
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch staff list");
  }
  return response.json();
}

// ============================================================================
// Intake Comments & Attention Flags API
// ============================================================================

export interface IntakeComment {
  id: number;
  contactId: number;
  contactName: string;
  authorEmail: string;
  authorInitials: string;
  commentText: string;
  createdAt: string;
}

export interface AttentionFlag {
  id: number;
  contactId: number;
  flaggedByEmail: string;
  flaggedAt: string;
  clearedByEmail: string | null;
  clearedAt: string | null;
}

export async function getIntakeComments(contactId: number): Promise<{ comments: IntakeComment[] }> {
  const response = await fetch(`/api/intake-comments/${contactId}`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch intake comments");
  }
  return response.json();
}

export async function createIntakeComment(params: {
  contactId: number;
  contactName: string;
  authorEmail: string;
  authorInitials: string;
  commentText: string;
}): Promise<{ success: boolean; commentId: number; flagCreated: boolean }> {
  const response = await apiRequest("POST", "/api/intake-comments", params);
  return response.json();
}

export async function getAttentionFlags(): Promise<{ flags: AttentionFlag[] }> {
  const response = await fetch("/api/attention-flags", {
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch attention flags");
  }
  return response.json();
}

export async function clearAttentionFlag(
  contactId: number,
  clearedByEmail: string
): Promise<{ success: boolean; cleared: boolean }> {
  const response = await apiRequest("POST", `/api/attention-flags/${contactId}/clear`, {
    clearedByEmail,
  });
  return response.json();
}

// ============================================================================
// Provider Assignments API
// ============================================================================

export interface ProviderAssignment {
  id: number;
  contactId: number;
  contactName: string;
  providerName: string;
  credential: string;
  assignmentComment: string | null;
  assignedByEmail: string;
  assignedByInitials: string;
  assignedAt: string;
  source: string;
}

export async function getAssignments(contactId: number): Promise<{ assignments: ProviderAssignment[] }> {
  const response = await fetch(`/api/assignments/${contactId}`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch assignments");
  }
  return response.json();
}

export async function createAssignment(params: {
  contactId: number;
  contactName: string;
  providerName: string;
  credential: string;
  assignmentComment?: string;
  assignedByEmail: string;
  assignedByInitials: string;
}): Promise<{ success: boolean; assignmentId: number }> {
  const response = await apiRequest("POST", "/api/assignments", params);
  return response.json();
}

// ============================================================================
// Intake Edit API
// ============================================================================

export async function updateContactIntake(
  contactId: number,
  fields: Record<string, string | null>,
  author: string
): Promise<{ success: boolean; contactId: number; updated: string[] }> {
  const response = await apiRequest("PATCH", `/api/contact/${contactId}`, {
    fields,
    author,
  });
  return response.json();
}

// ============================================================================
// Contact Identity Edit API
// ============================================================================

export async function updateContactIdentity(
  contactId: number,
  updates: { name?: string; email?: string; phone?: string }
): Promise<{ success: boolean; contactId: number; changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> }> {
  const response = await apiRequest("PATCH", `/api/contact/${contactId}/identity`, updates);
  return response.json();
}

// ============================================================================
// Contact Delete API
// ============================================================================

export async function deleteContact(
  contactId: number,
  confirmation: string
): Promise<{ success: boolean; contactId: number; name: string }> {
  const response = await apiRequest("DELETE", `/api/contact/${contactId}`, { confirmation });
  return response.json();
}

// ============================================================================
// Sync API
// ============================================================================

export async function syncContactFromExcel(contactId: number): Promise<{ success: boolean; contact: unknown }> {
  const response = await apiRequest("POST", `/api/sync/contact/${contactId}`);
  return response.json();
}

export async function triggerFullSync(): Promise<{
  success: boolean;
  synced: number;
  skipped: number;
  deleted: number;
  durationMs: number;
  totalContacts: number;
}> {
  const response = await apiRequest("POST", "/api/sync/trigger");
  return response.json();
}

// ============================================================================
// TherapyNotes API
// ============================================================================

export interface TherapyNotesRecord {
  id: number;
  contactId: number;
  contactName: string;
  createdByEmail: string;
  tnStatus: "pending" | "in_progress" | "created" | "failed";
  tnPatientUrl: string | null;
  tnPatientId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getTherapyNotesStatus(
  contactId: number
): Promise<{ record: TherapyNotesRecord | null }> {
  const response = await fetch(`/api/therapy-notes/${contactId}`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) throw new Error("Failed to fetch TherapyNotes status");
  return response.json();
}

export async function createTherapyNotesPatient(
  contactId: number,
  contactName?: string
): Promise<{ status: string; record: TherapyNotesRecord }> {
  const response = await apiRequest("POST", "/api/therapy-notes/create", {
    contactId,
    contactName,
  });
  return response.json();
}

export async function resetTherapyNotesLink(
  contactId: number
): Promise<{ success: boolean; record: TherapyNotesRecord }> {
  const response = await apiRequest("POST", "/api/therapy-notes/reset", {
    contactId,
  });
  return response.json();
}

// ============================================================================
// TN V2 — "Add to Schedule in TN (Beta)" API
// ============================================================================

export interface TnV2State {
  scheduledAppointmentDate: string | null; // ISO YYYY-MM-DD
  scheduledAppointmentTime: string | null; // h:mm am/pm
  providerAssigned: boolean;
  providerName: string | null;
  emailSent: boolean;
  canGenerateIntakePdf: boolean; // contact has intake data → intake PDF is generatable
}

export interface TnV2RunResult {
  status: "success" | "error";
  tn_patient_url?: string | null;
  tn_patient_id?: string | null;
  appointmentDatetime?: string;
  error?: string;
}

/** Button state + the three precondition flags for the Beta button. */
export async function getTnV2State(contactId: number): Promise<TnV2State> {
  const response = await fetch(`/api/therapy-notes/v2/state/${contactId}`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) throw new Error("Failed to fetch TN scheduling state");
  return response.json();
}

/** Persist the staff-entered scheduled appointment (widget save). */
export async function saveScheduledAppointment(
  contactId: number,
  date: string | null,
  time: string | null
): Promise<{ success: boolean; scheduledAppointmentDate: string | null; scheduledAppointmentTime: string | null }> {
  const response = await apiRequest("POST", "/api/therapy-notes/v2/schedule-appointment", {
    contactId,
    date,
    time,
  });
  return response.json();
}

/**
 * Run the synchronous V2 workflow (create patient + upload PDFs + schedule).
 * Can take 90–180s; uses a 240s client-side timeout to match the server (C14).
 * Throws Error("<status>: <message>") on non-2xx so callers can show the reason.
 */
export async function createTherapyNotesWithSchedule(contactId: number): Promise<TnV2RunResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 240_000);
  try {
    const res = await fetch("/api/therapy-notes/create-with-schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId }),
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text();
    let body: TnV2RunResult | null = null;
    try { body = text ? JSON.parse(text) as TnV2RunResult : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      throw new Error(body?.error || `${res.status}: ${text || res.statusText}`);
    }
    return body || { status: "success" };
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new Error("TN agent did not respond within 240s. Please try again or contact support.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
