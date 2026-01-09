/**
 * Centralized Status Configuration
 * 
 * This file defines all status code semantics for the TFC CRM.
 * All UI logic must reference this file - no inline status logic allowed.
 * 
 * Status codes are numeric values from the Excel spreadsheet.
 * The UI groups these codes into logical pipeline columns.
 */

// Status code to human-readable label mapping
export const STATUS_LABELS: Record<number, string> = {
  100: "New",
  101: "Left Voicemail",
  102: "Response Received",
  103: "Declined",
  104: "Inactive",
  200: "Ready to Schedule",
  201: "Left Voicemail",
  202: "Scheduled",
  203: "No Response",
  204: "Declined",
  300: "PM Review",
  400: "Insurance Not Accepted",
};

// Logical groups for pipeline columns
// Each group maps to an array of status codes that belong to that stage
export const STATUS_GROUPS = {
  // Initial contact and intake
  intake: [100],
  
  // Waiting for response or follow-up needed
  waiting: [101, 102],
  
  // Ready to be scheduled with a provider
  ready_to_schedule: [200],
  
  // Appointment scheduled
  scheduled: [202],
  
  // Pending scheduling actions (voicemail, no response)
  pending_scheduling: [201, 203],
  
  // Under PM/management review
  pm_review: [300],
  
  // Declined contacts (not shown in active pipeline)
  declined: [103, 204],
  
  // Inactive/closed contacts (not shown in active pipeline)
  inactive: [104, 400],
} as const;

// Pipeline columns configuration - order matters for display
export const PIPELINE_COLUMNS = [
  { id: "intake", label: "Intake", codes: STATUS_GROUPS.intake },
  { id: "waiting", label: "Waiting", codes: STATUS_GROUPS.waiting },
  { id: "ready_to_schedule", label: "Ready to Schedule", codes: STATUS_GROUPS.ready_to_schedule },
  { id: "pending_scheduling", label: "Pending Scheduling", codes: STATUS_GROUPS.pending_scheduling },
  { id: "scheduled", label: "Scheduled", codes: STATUS_GROUPS.scheduled },
  { id: "pm_review", label: "PM Review", codes: STATUS_GROUPS.pm_review },
] as const;

// Column IDs for type safety
export type PipelineColumnId = typeof PIPELINE_COLUMNS[number]["id"];

// Get all active status codes (not declined or inactive)
export const ACTIVE_STATUS_CODES = [
  ...STATUS_GROUPS.intake,
  ...STATUS_GROUPS.waiting,
  ...STATUS_GROUPS.ready_to_schedule,
  ...STATUS_GROUPS.pending_scheduling,
  ...STATUS_GROUPS.scheduled,
  ...STATUS_GROUPS.pm_review,
];

// Get all inactive/declined status codes
export const INACTIVE_STATUS_CODES: number[] = [
  ...STATUS_GROUPS.declined,
  ...STATUS_GROUPS.inactive,
];

/**
 * Check if a status code is active (not declined or inactive)
 * Active Waitlist = all contacts NOT in declined (103, 204) or inactive (104, 400)
 */
export function isActiveStatus(statusCode: number | undefined | null): boolean {
  if (statusCode === undefined || statusCode === null) return false;
  return !INACTIVE_STATUS_CODES.includes(statusCode);
}

/**
 * Get the column ID for a given status code
 * Returns "other" if the code doesn't match any known group
 */
export function getColumnForStatus(statusCode: number | undefined | null): PipelineColumnId | "other" {
  if (statusCode === undefined || statusCode === null) return "other";
  
  for (const column of PIPELINE_COLUMNS) {
    if ((column.codes as readonly number[]).includes(statusCode)) {
      return column.id;
    }
  }
  return "other";
}

/**
 * Get the human-readable label for a status code
 */
export function getStatusLabel(statusCode: number | undefined | null): string {
  if (statusCode === undefined || statusCode === null) return "Unknown";
  return STATUS_LABELS[statusCode] || `Status ${statusCode}`;
}

/**
 * Convert legacy string status to numeric code (for backward compatibility)
 * Maps mock data string statuses to their primary numeric codes
 * Handles various casing and formatting variations
 */
export function stringStatusToCode(status: string | undefined | null): number {
  if (!status) return 100;
  
  // Normalize: lowercase, trim, replace spaces with underscores
  const normalized = status.toLowerCase().trim().replace(/\s+/g, '_');
  
  const mapping: Record<string, number> = {
    // Intake
    intake: 100,
    new: 100,
    
    // Waiting (maps to primary code 101)
    waiting: 101,
    left_voicemail: 101,
    leftvoicemail: 101,
    response_received: 102,
    responsereceived: 102,
    
    // Ready to schedule
    ready_to_schedule: 200,
    readytoschedule: 200,
    ready: 200,
    
    // Pending scheduling
    pending_scheduling: 201,
    pendingscheduling: 201,
    no_response: 203,
    noresponse: 203,
    
    // Scheduled
    scheduled: 202,
    
    // PM Review
    on_hold: 300,
    onhold: 300,
    pm_review: 300,
    pmreview: 300,
    
    // Declined
    declined: 103,
    
    // Inactive/Closed
    inactive: 104,
    closed: 400,
    insurance_not_accepted: 400,
    insurancenotaccepted: 400,
  };
  
  return mapping[normalized] || 100;
}

/**
 * Convert numeric status code to display label
 */
export function statusCodeToLabel(statusCode: number | undefined | null): string {
  if (statusCode === undefined || statusCode === null) return "Unknown";
  return STATUS_LABELS[statusCode] || `Status ${statusCode}`;
}

/**
 * Safe number display - returns "---" for undefined/null values
 */
export function safeNumber(value: number | undefined | null, fallback = "---"): string | number {
  if (value === undefined || value === null || isNaN(value)) return fallback;
  return value;
}

/**
 * Safe string display - returns "---" for undefined/null values
 */
export function safeString(value: string | undefined | null, fallback = "---"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}
