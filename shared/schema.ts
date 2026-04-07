import { z } from "zod";

// Contact status types
export const contactStatuses = [
  "intake",
  "waiting",
  "ready_to_schedule",
  "scheduled",
  "on_hold",
  "closed",
] as const;

export type ContactStatus = (typeof contactStatuses)[number];

// Umbrella status types for pipeline columns
export const umbrellaIds = ["WL", "PS", "PMR", "INS", "unknown"] as const;
export type UmbrellaId = (typeof umbrellaIds)[number];

// Contact snapshot schema (matches expanded server contract)
export const contactSnapshotSchema = z.object({
  // Core identity
  contactId: z.number(),
  name: z.string(),

  // Contact info (from n8n detailed response)
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),

  // Intake info (from n8n detailed response)
  requestingFor: z.string().nullable().optional(),
  reasonForSeeking: z.string().nullable().optional(),
  reasonForTherapy: z.string().nullable().optional(), // Excel column BD: Reason for Therapy MCQ (comma-separated)
  // Provider Matching signal (INTERNAL - not displayed in UI)
  detailedReason: z.string().nullable().optional(),
  formCompletedBy: z.string().nullable().optional(),

  // Additional intake fields (Phase 6)
  modality: z.string().nullable().optional(),        // In-person vs Telehealth
  referralSource: z.string().nullable().optional(),  // How client found TFC
  priorServices: z.string().nullable().optional(),   // Previous service history
  priorProvider: z.string().nullable().optional(),   // Previous provider name

  // Insurance fields (Phase 6.3)
  insurancePayer: z.string().nullable().optional(),  // Insurance company name
  insurancePlan: z.string().nullable().optional(),   // Plan name
  insuranceId: z.string().nullable().optional(),     // Member/Policy ID
  insuranceStatus: z.string().nullable().optional(), // Verification status

  // Referral fields (Phase 6.3)
  referralAuth: z.string().nullable().optional(),    // Authorization number
  referralStatus: z.string().nullable().optional(),  // Referral status

  // Demographics (Phase 6.2)
  patientDob: z.string().nullable().optional(),      // Patient date of birth
  gender: z.string().nullable().optional(),          // Gender / Sex
  age: z.number().nullable().optional(),             // Age (if computed)

  // Address (Phase 6.2)
  streetAddress: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zipCode: z.string().nullable().optional(),
  county: z.string().nullable().optional(),          // County

  // Contact preferences (Phase 6.2)
  preferredContact: z.string().nullable().optional(), // Preferred contact method

  // Consent (Email Automation v1)
  eccConsent: z.boolean().nullable().optional(),      // Electronic Communication Consent

  // Admin / Flags (Phase 6.3)
  custody: z.string().nullable().optional(),         // Custody status
  flags: z.string().nullable().optional(),           // Alert flags
  priority: z.string().nullable().optional(),        // Priority/Urgency

  // Links (Phase 6.3 - CRITICAL)
  rfsLink: z.string().nullable().optional(),         // RFS / SharePoint link
  documentLink: z.string().nullable().optional(),    // Document link

  // Status fields
  statusCode: z.number(),
  umbrella: z.enum(umbrellaIds),
  status: z.enum(contactStatuses).optional(),

  // Waitlist tracking
  serviceRequested: z.string(),
  daysOnWaitlist: z.number(),
  dateAdded: z.string().nullable().optional(),
  lastContact: z.string().nullable().optional(), // Last contact date

  // Assignment and notes
  assignedTo: z.string().nullable().optional(),
  notes: z.array(z.object({
    date: z.string(),
    content: z.string(),
    author: z.string().optional(), // Author initials extracted from note (Phase 6)
  })).optional(),

  // Data source indicator
  _source: z.enum(["live", "fallback", "mock", "derived"]).optional(),
});

export type ContactSnapshot = z.infer<typeof contactSnapshotSchema>;

// Waitlist summary schema (matches n8n webhook response)
export const waitlistSummarySchema = z.object({
  totalActive: z.number(),
  avgWaitDays: z.number(),
  longestWaitDays: z.number(),
  longestWaitingName: z.string(),
  over30Days: z.number(),
  over60Days: z.number(),
  readyToSchedule: z.number(),
  needsFollowUp: z.number(),
  byStatus: z.record(z.string(), z.number()),
});

export type WaitlistSummary = z.infer<typeof waitlistSummarySchema>;

// Waitlist contact (for pipeline view)
// contactId and statusCode are REQUIRED - these are the canonical identifiers
// Any contact without these fields should be rejected/logged as a data integrity error
export const waitlistContactSchema = z.object({
  contactId: z.number(), // REQUIRED - canonical identifier for all operations
  name: z.string(),
  status: z.enum(contactStatuses).optional(), // Legacy string status (deprecated)
  statusCode: z.number(), // REQUIRED - authoritative status from Excel
  serviceRequested: z.string(),
  requestingFor: z.string().nullable().optional(), // "Myself", "My Child", "My Family", "My Partner & Myself"
  daysOnWaitlist: z.number(),
  dateAdded: z.string().nullable(),
  assignedTo: z.string().nullable().optional(), // Staff email address (e.g., "jsmith@tfc.help")
  insurancePayer: z.string().nullable().optional(), // Insurance company name (for insights aggregation)
  modality: z.string().nullable().optional(), // Desired modality/location (for insights aggregation)
  reasonForTherapy: z.array(z.string()).optional(), // Reason(s) for seeking services (for insights aggregation)
  patientDob: z.string().nullable().optional(), // Patient date of birth (YYYY-MM-DD or MM/DD/YYYY)
  assignedProviderName: z.string().nullable().optional(), // Latest assigned provider name (from contact_provider_assignments)
});

export type WaitlistContact = z.infer<typeof waitlistContactSchema>;

// API request/response types
export const getContactSnapshotRequestSchema = z.object({
  contactId: z.number(),
});

export type GetContactSnapshotRequest = z.infer<typeof getContactSnapshotRequestSchema>;

// User types (for future auth features)
export interface User {
  id: string;
  username: string;
  password: string;
}

export interface InsertUser {
  username: string;
  password: string;
}
