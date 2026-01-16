import type { ContactSnapshot, WaitlistContact, WaitlistSummary, UmbrellaId } from "@shared/schema";
import { stringStatusToCode } from "./status-config";

// Helper to compute umbrella from status code
function getUmbrellaFromCode(statusCode: number): UmbrellaId {
  if (statusCode >= 100 && statusCode < 200) return "WL";
  if (statusCode >= 200 && statusCode < 300) return "PS";
  if (statusCode >= 300 && statusCode < 400) return "PMR";
  if (statusCode >= 400 && statusCode < 500) return "INS";
  return "unknown";
}

// Mock contacts matching webhook response shape
// contactId and statusCode are REQUIRED - assigned sequentially for mock data
export const mockContacts: ContactSnapshot[] = [
  {
    contactId: 1,
    name: "Emilio Castro",
    email: "emilio.castro@email.com",
    phone: "(555) 123-4567",
    status: "waiting",
    statusCode: 101,
    umbrella: "WL",
    serviceRequested: "Family Counseling",
    daysOnWaitlist: 72,
    dateAdded: "2025-10-28",
    lastContact: "2025-12-15",
    assignedTo: "Sarah Johnson",
    notes: [
      { date: "2025-12-15", content: "Called to check in. Still interested in services." },
      { date: "2025-11-20", content: "Initial intake completed. Waiting for provider availability." },
    ],
  },
  {
    contactId: 2,
    name: "Maria Santos",
    email: "maria.santos@email.com",
    phone: "(555) 234-5678",
    status: "ready_to_schedule",
    statusCode: 200,
    umbrella: "PS",
    serviceRequested: "Child Therapy",
    daysOnWaitlist: 45,
    dateAdded: "2025-11-25",
    lastContact: "2026-01-05",
    assignedTo: "Mike Chen",
    notes: [
      { date: "2026-01-05", content: "Provider available next week. Ready to schedule." },
    ],
  },
  {
    contactId: 3,
    name: "James Wilson",
    email: "james.w@email.com",
    phone: "(555) 345-6789",
    status: "intake",
    statusCode: 100,
    umbrella: "WL",
    serviceRequested: "Couples Counseling",
    daysOnWaitlist: 5,
    dateAdded: "2026-01-04",
    notes: [],
  },
  {
    contactId: 4,
    name: "Linda Thompson",
    email: "linda.t@email.com",
    phone: "(555) 456-7890",
    status: "waiting",
    statusCode: 101,
    umbrella: "WL",
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
    contactId: 5,
    name: "Robert Kim",
    email: "robert.kim@email.com",
    phone: "(555) 567-8901",
    status: "on_hold",
    statusCode: 300,
    umbrella: "PMR",
    serviceRequested: "Family Counseling",
    daysOnWaitlist: 30,
    dateAdded: "2025-12-10",
    lastContact: "2026-01-02",
    notes: [
      { date: "2026-01-02", content: "Requested hold due to travel. Will resume in February." },
    ],
  },
  {
    contactId: 6,
    name: "Jennifer Lopez",
    email: "jen.lopez@email.com",
    phone: "(555) 678-9012",
    status: "waiting",
    statusCode: 101,
    umbrella: "WL",
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
    contactId: 7,
    name: "David Brown",
    email: "david.b@email.com",
    phone: "(555) 789-0123",
    status: "ready_to_schedule",
    statusCode: 200,
    umbrella: "PS",
    serviceRequested: "Individual Therapy",
    daysOnWaitlist: 21,
    dateAdded: "2025-12-19",
    lastContact: "2026-01-07",
    notes: [
      { date: "2026-01-07", content: "Provider matched. Sending appointment options." },
    ],
  },
  {
    contactId: 8,
    name: "Sarah Martinez",
    email: "sarah.m@email.com",
    phone: "(555) 890-1234",
    status: "scheduled",
    statusCode: 202,
    umbrella: "PS",
    serviceRequested: "Couples Counseling",
    daysOnWaitlist: 14,
    dateAdded: "2025-12-26",
    lastContact: "2026-01-08",
    notes: [
      { date: "2026-01-08", content: "First appointment scheduled for Jan 15." },
    ],
  },
  {
    contactId: 9,
    name: "Michael Johnson",
    email: "michael.j@email.com",
    phone: "(555) 901-2345",
    status: "intake",
    statusCode: 100,
    umbrella: "WL",
    serviceRequested: "Family Counseling",
    daysOnWaitlist: 3,
    dateAdded: "2026-01-06",
    notes: [],
  },
  {
    contactId: 10,
    name: "Amanda White",
    email: "amanda.w@email.com",
    phone: "(555) 012-3456",
    status: "waiting",
    statusCode: 101,
    umbrella: "WL",
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
    contactId: 11,
    name: "Christopher Lee",
    email: "chris.lee@email.com",
    phone: "(555) 123-4568",
    status: "closed",
    statusCode: 400,
    umbrella: "INS",
    serviceRequested: "Individual Therapy",
    daysOnWaitlist: 0,
    dateAdded: "2025-09-15",
    lastContact: "2025-11-01",
    notes: [
      { date: "2025-11-01", content: "Successfully completed 8-week program." },
    ],
  },
  {
    contactId: 12,
    name: "Patricia Garcia",
    email: "patricia.g@email.com",
    phone: "(555) 234-5679",
    status: "waiting",
    statusCode: 101,
    umbrella: "WL",
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

// Convert to waitlist contacts - contactId and statusCode are REQUIRED
export const mockWaitlistContacts: WaitlistContact[] = mockContacts.map((c) => ({
  contactId: c.contactId,
  name: c.name,
  status: c.status,
  statusCode: c.statusCode,
  serviceRequested: c.serviceRequested,
  daysOnWaitlist: c.daysOnWaitlist,
  dateAdded: c.dateAdded ?? null,
}));

// Mock waitlist summary
export const mockWaitlistSummary: WaitlistSummary = {
  totalActive: mockContacts.filter((c) => c.status !== "closed").length,
  avgWaitDays: Math.round(
    mockContacts.filter((c) => c.status !== "closed").reduce((sum, c) => sum + c.daysOnWaitlist, 0) /
    mockContacts.filter((c) => c.status !== "closed").length
  ),
  longestWaitDays: Math.max(...mockContacts.map((c) => c.daysOnWaitlist)),
  longestWaitingName: "Jennifer Lopez",
  over30Days: mockContacts.filter((c) => c.daysOnWaitlist > 30 && c.status !== "closed").length,
  over60Days: mockContacts.filter((c) => c.daysOnWaitlist > 60 && c.status !== "closed").length,
  readyToSchedule: mockContacts.filter((c) => c.status === "ready_to_schedule").length,
  needsFollowUp: mockContacts.filter((c) =>
    c.status === "waiting" && c.daysOnWaitlist > 14
  ).length,
  byStatus: {
    intake: mockContacts.filter((c) => c.status === "intake").length,
    waiting: mockContacts.filter((c) => c.status === "waiting").length,
    ready_to_schedule: mockContacts.filter((c) => c.status === "ready_to_schedule").length,
    scheduled: mockContacts.filter((c) => c.status === "scheduled").length,
    on_hold: mockContacts.filter((c) => c.status === "on_hold").length,
    closed: mockContacts.filter((c) => c.status === "closed").length,
  },
};

// Helper to get contact by contactId (canonical lookup)
export function getMockContactById(contactId: number): ContactSnapshot | undefined {
  return mockContacts.find((c) => c.contactId === contactId);
}

// Helper to get contact by name (legacy - for backward compatibility only)
export function getMockContact(name: string): ContactSnapshot | undefined {
  return mockContacts.find(
    (c) => c.name.toLowerCase() === name.toLowerCase()
  );
}
