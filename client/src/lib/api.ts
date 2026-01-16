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
  const response = await fetch("/api/waitlist-contacts");
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
  const response = await fetch("/api/config");
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
