import { apiRequest } from "./queryClient";
import type { ContactSnapshot, WaitlistContact, WaitlistSummary } from "@shared/schema";
import type { DataSource, DataMode } from "./data-source-context";

export type WithSource<T> = T & { _source?: DataSource };

export async function getContactSnapshot(contactName: string): Promise<WithSource<ContactSnapshot>> {
  const response = await apiRequest("POST", "/api/get-contact-snapshot", { contactName });
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
  contactName: string, 
  statusCode: number
): Promise<{ success: boolean; contactName: string; newStatus: number }> {
  const response = await apiRequest("POST", "/api/update-status", { 
    contactName, 
    statusCode,
  });
  return response.json();
}

export async function addNoteToContact(
  contactName: string, 
  note: string
): Promise<{ success: boolean; contactName: string; note: { date: string; content: string } }> {
  const response = await apiRequest("POST", "/api/add-note", { contactName, note });
  return response.json();
}
