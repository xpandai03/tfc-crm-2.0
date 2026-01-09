import { apiRequest } from "./queryClient";
import type { ContactSnapshot, WaitlistContact, WaitlistSummary, ContactStatus } from "@shared/schema";
import { STATUS_MAP } from "./status-config";

export async function getContactSnapshot(contactName: string): Promise<ContactSnapshot> {
  const response = await apiRequest("POST", "/api/get-contact-snapshot", { contactName });
  return response.json();
}

export async function getWaitlistSummary(): Promise<WaitlistSummary> {
  const response = await apiRequest("POST", "/api/get-waitlist-summary");
  return response.json();
}

export async function getWaitlistContacts(): Promise<WaitlistContact[]> {
  const response = await fetch("/api/waitlist-contacts");
  if (!response.ok) {
    throw new Error("Failed to fetch waitlist contacts");
  }
  return response.json();
}

export async function getConfig(): Promise<{ useLiveData: boolean }> {
  const response = await fetch("/api/config");
  if (!response.ok) {
    throw new Error("Failed to fetch config");
  }
  return response.json();
}

export async function updateContactStatus(
  contactName: string, 
  status: ContactStatus
): Promise<{ success: boolean; contactName: string; newStatus: string }> {
  const response = await apiRequest("POST", "/api/update-status", { 
    contactName, 
    status,
    statusCode: STATUS_MAP[status],
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
