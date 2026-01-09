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

// Contact snapshot schema (matches n8n webhook response)
export const contactSnapshotSchema = z.object({
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  status: z.enum(contactStatuses),
  serviceRequested: z.string(),
  daysOnWaitlist: z.number(),
  dateAdded: z.string(),
  notes: z.array(z.object({
    date: z.string(),
    content: z.string(),
  })).optional(),
  lastContact: z.string().optional(),
  assignedTo: z.string().optional(),
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
export const waitlistContactSchema = z.object({
  name: z.string(),
  status: z.enum(contactStatuses),
  serviceRequested: z.string(),
  daysOnWaitlist: z.number(),
  dateAdded: z.string(),
});

export type WaitlistContact = z.infer<typeof waitlistContactSchema>;

// API request/response types
export const getContactSnapshotRequestSchema = z.object({
  contactName: z.string(),
});

export type GetContactSnapshotRequest = z.infer<typeof getContactSnapshotRequestSchema>;
