import type { ContactSnapshot, WaitlistContact, WaitlistSummary } from "@shared/schema";

// Mock contacts matching webhook response shape
export const mockContacts: ContactSnapshot[] = [
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
      { date: "2025-12-15", content: "Called to check in. Still interested in services." },
      { date: "2025-11-20", content: "Initial intake completed. Waiting for provider availability." },
    ],
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
      { date: "2026-01-05", content: "Provider available next week. Ready to schedule." },
    ],
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

// Convert to waitlist contacts
export const mockWaitlistContacts: WaitlistContact[] = mockContacts.map((c) => ({
  name: c.name,
  status: c.status,
  serviceRequested: c.serviceRequested,
  daysOnWaitlist: c.daysOnWaitlist,
  dateAdded: c.dateAdded,
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

// Helper to get contact by name
export function getMockContact(name: string): ContactSnapshot | undefined {
  return mockContacts.find(
    (c) => c.name.toLowerCase() === name.toLowerCase()
  );
}
