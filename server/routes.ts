import type { Express } from "express";
import { createServer, type Server } from "http";

// Configuration for mock vs live data mode
const USE_LIVE_DATA = false;

// n8n webhook URLs
const N8N_ENDPOINTS = {
  contactSnapshot: "https://n8n-familyconnection.agentglu.agency/webhook/get-contact-snapshot",
  waitlistSummary: "https://n8n-familyconnection.agentglu.agency/webhook/get-waitlist-summary",
  updateStatus: "https://n8n-familyconnection.agentglu.agency/webhook/update-status",
  addNote: "https://n8n-familyconnection.agentglu.agency/webhook/add-note",
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
  notes: { date: string; content: string }[];
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

function getMockWaitlistContacts() {
  return mockContacts.map((c) => ({
    name: c.name,
    status: c.status,
    serviceRequested: c.serviceRequested,
    daysOnWaitlist: c.daysOnWaitlist,
    dateAdded: c.dateAdded,
  }));
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Get contact snapshot
  app.post("/api/get-contact-snapshot", async (req, res) => {
    try {
      const { contactName } = req.body;
      
      if (!contactName || typeof contactName !== "string") {
        return res.status(400).json({ error: "contactName is required" });
      }

      if (USE_LIVE_DATA) {
        // Forward to n8n webhook
        const response = await fetch(N8N_ENDPOINTS.contactSnapshot, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactName }),
        });

        if (!response.ok) {
          throw new Error(`n8n webhook returned ${response.status}`);
        }

        const data = await response.json();
        return res.json(data);
      } else {
        // Return mock data
        const contact = getMockContact(contactName);
        if (!contact) {
          return res.status(404).json({ error: "Contact not found" });
        }
        return res.json(contact);
      }
    } catch (error) {
      console.error("Error fetching contact snapshot:", error);
      return res.status(500).json({ error: "Failed to fetch contact snapshot" });
    }
  });

  // Get waitlist summary
  app.post("/api/get-waitlist-summary", async (_req, res) => {
    try {
      if (USE_LIVE_DATA) {
        // Forward to n8n webhook
        const response = await fetch(N8N_ENDPOINTS.waitlistSummary, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          throw new Error(`n8n webhook returned ${response.status}`);
        }

        const data = await response.json();
        return res.json(data);
      } else {
        // Return mock data
        return res.json(getMockWaitlistSummary());
      }
    } catch (error) {
      console.error("Error fetching waitlist summary:", error);
      return res.status(500).json({ error: "Failed to fetch waitlist summary" });
    }
  });

  // Get all waitlist contacts (for pipeline view)
  app.get("/api/waitlist-contacts", async (_req, res) => {
    try {
      if (USE_LIVE_DATA) {
        // In live mode, we'd need to fetch from n8n
        // For now, return mock data as the n8n endpoint may not support full list
        return res.json(getMockWaitlistContacts());
      } else {
        return res.json(getMockWaitlistContacts());
      }
    } catch (error) {
      console.error("Error fetching waitlist contacts:", error);
      return res.status(500).json({ error: "Failed to fetch waitlist contacts" });
    }
  });

  // Get config (for frontend to know if live mode is enabled)
  app.get("/api/config", (_req, res) => {
    res.json({ useLiveData: USE_LIVE_DATA });
  });

  // Update contact status
  app.post("/api/update-status", async (req, res) => {
    try {
      const { contactName, status, statusCode } = req.body;
      
      if (!contactName || typeof contactName !== "string") {
        return res.status(400).json({ error: "contactName is required" });
      }
      if (!status || typeof status !== "string") {
        return res.status(400).json({ error: "status is required" });
      }

      if (USE_LIVE_DATA) {
        const response = await fetch(N8N_ENDPOINTS.updateStatus, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactName, status, statusCode }),
        });

        if (!response.ok) {
          throw new Error(`n8n webhook returned ${response.status}`);
        }

        const data = await response.json();
        return res.json(data);
      } else {
        // Update mock data in memory
        const contact = mockContacts.find(
          (c) => c.name.toLowerCase() === contactName.toLowerCase()
        );
        if (!contact) {
          return res.status(404).json({ error: "Contact not found" });
        }
        contact.status = status;
        return res.json({ success: true, contactName, newStatus: status });
      }
    } catch (error) {
      console.error("Error updating status:", error);
      return res.status(500).json({ error: "Failed to update status" });
    }
  });

  // Add note to contact
  app.post("/api/add-note", async (req, res) => {
    try {
      const { contactName, note } = req.body;
      
      if (!contactName || typeof contactName !== "string") {
        return res.status(400).json({ error: "contactName is required" });
      }
      if (!note || typeof note !== "string") {
        return res.status(400).json({ error: "note is required" });
      }

      if (USE_LIVE_DATA) {
        const response = await fetch(N8N_ENDPOINTS.addNote, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactName, note }),
        });

        if (!response.ok) {
          throw new Error(`n8n webhook returned ${response.status}`);
        }

        const data = await response.json();
        return res.json(data);
      } else {
        // Add note to mock data in memory
        const contact = mockContacts.find(
          (c) => c.name.toLowerCase() === contactName.toLowerCase()
        );
        if (!contact) {
          return res.status(404).json({ error: "Contact not found" });
        }
        
        const newNote = {
          date: new Date().toISOString().split('T')[0],
          content: note,
        };
        
        if (!contact.notes) {
          contact.notes = [];
        }
        contact.notes.unshift(newNote);
        contact.lastContact = newNote.date;
        
        return res.json({ success: true, contactName, note: newNote });
      }
    } catch (error) {
      console.error("Error adding note:", error);
      return res.status(500).json({ error: "Failed to add note" });
    }
  });

  return httpServer;
}
