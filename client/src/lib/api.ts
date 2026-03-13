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
// Sync API
// ============================================================================

export async function syncContactFromExcel(contactId: number): Promise<{ success: boolean; contact: unknown }> {
  const response = await apiRequest("POST", `/api/sync/contact/${contactId}`);
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
