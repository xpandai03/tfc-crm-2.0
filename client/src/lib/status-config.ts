/**
 * Centralized Status Configuration
 *
 * This file defines all status code semantics for the TFC CRM.
 * All UI logic must reference this file - no inline status logic allowed.
 *
 * Status codes are numeric values from the Excel spreadsheet.
 * The UI groups these codes into 4 umbrella workflow stages.
 *
 * GROUND TRUTH:
 * - WL (Waitlist): 100-104 — Initial contact phase
 * - PS (Pending Scheduling): 200-204 — Provider matched, scheduling in progress
 * - PMR (PM Review): 300 — Requires practice manager attention
 * - INS (Insurance N/A): 400 — Cannot proceed due to insurance
 */

// Status code to human-readable label mapping
// Labels match the exact semantics from the TFC spreadsheet
export const STATUS_LABELS: Record<number, string> = {
  100: "New -- No Outreach",
  101: "Left Voicemail",
  102: "Response Received",
  103: "Declined Services",
  104: "Inactive -- No Response",
  200: "Ready to Schedule",
  201: "Left Voicemail",
  202: "Scheduled",
  203: "No Response",
  204: "Declined",
  300: "Submitted for Review",
  400: "Insurance Not Accepted",
};

// Status code descriptions for the legend modal
export const STATUS_DESCRIPTIONS: Record<number, string> = {
  100: "No outreach yet",
  101: "Initial contact attempted",
  102: "Contact responded",
  103: "Contact declined services",
  104: "No response after attempts",
  200: "Provider matched, ready for scheduling",
  201: "Scheduling outreach attempted",
  202: "Appointment confirmed",
  203: "No response to scheduling attempts",
  204: "Declined scheduling",
  300: "Requires PM attention",
  400: "Cannot proceed due to insurance",
};

/**
 * STATUS UMBRELLAS
 *
 * Each umbrella represents a workflow stage in the pipeline.
 * - codes: All status codes that belong to this stage
 * - entry: The default status code assigned when dragging into this column
 * - label: Display name for the column
 * - color: Tailwind color scheme for the column
 */
export const STATUS_UMBRELLAS = {
  WL: {
    codes: [100, 101, 102, 103, 104],
    entry: 100,
    label: "Waitlist",
    color: "slate"
  },
  PS: {
    codes: [200, 201, 202, 203, 204],
    entry: 200,
    label: "Pending Scheduling",
    color: "amber"
  },
  PMR: {
    codes: [300],
    entry: 300,
    label: "PM Review",
    color: "purple"
  },
  INS: {
    codes: [400],
    entry: 400,
    label: "Insurance N/A",
    color: "red"
  },
} as const;

export type UmbrellaId = keyof typeof STATUS_UMBRELLAS;

// Pipeline columns configuration - 4 umbrella columns
export interface PipelineColumn {
  id: UmbrellaId;
  label: string;
  codes: readonly number[];
  color: string;
}

export const PIPELINE_COLUMNS: PipelineColumn[] = [
  { id: "WL", label: "Waitlist", codes: STATUS_UMBRELLAS.WL.codes, color: "slate" },
  { id: "PS", label: "Pending Scheduling", codes: STATUS_UMBRELLAS.PS.codes, color: "amber" },
  { id: "PMR", label: "PM Review", codes: STATUS_UMBRELLAS.PMR.codes, color: "purple" },
  { id: "INS", label: "Insurance N/A", codes: STATUS_UMBRELLAS.INS.codes, color: "red" },
];

// Column IDs for type safety
export type PipelineColumnId = UmbrellaId;

// Get all active status codes (all codes in the pipeline)
export const ACTIVE_STATUS_CODES = [
  ...STATUS_UMBRELLAS.WL.codes,
  ...STATUS_UMBRELLAS.PS.codes,
  ...STATUS_UMBRELLAS.PMR.codes,
  ...STATUS_UMBRELLAS.INS.codes,
];

// Get all inactive/declined status codes (contacts that may need special handling)
// Note: In the umbrella model, declined (103, 204) still appear in their respective columns
export const INACTIVE_STATUS_CODES: number[] = [103, 104, 204];

/**
 * BACKWARD COMPATIBILITY: STATUS_GROUPS
 * Maps old group names to status code arrays.
 * Used by insights.ts and other legacy code.
 */
export const STATUS_GROUPS = {
  intake: [100] as readonly number[],
  waiting: [101, 102, 103, 104] as readonly number[],
  ready_to_schedule: [200] as readonly number[],
  pending: [201, 203] as readonly number[],
  scheduled: [202] as readonly number[],
  pm_review: [300] as readonly number[],
  declined: [103, 204] as readonly number[],
  inactive: [104, 400] as readonly number[],
} as const;

/**
 * Check if a status code is active (not declined or inactive)
 * Active Waitlist = all contacts NOT in declined (103, 204) or inactive (104, 400)
 */
export function isActiveStatus(statusCode: number | undefined | null): boolean {
  if (statusCode === undefined || statusCode === null) return false;
  return !INACTIVE_STATUS_CODES.includes(statusCode);
}

/**
 * Get the umbrella ID for a given status code.
 * Returns null if the code doesn't match any known umbrella.
 */
export function getUmbrellaForStatus(statusCode: number | undefined | null): UmbrellaId | null {
  if (statusCode === undefined || statusCode === null) return null;

  for (const [umbrellaId, umbrella] of Object.entries(STATUS_UMBRELLAS)) {
    if ((umbrella.codes as readonly number[]).includes(statusCode)) {
      return umbrellaId as UmbrellaId;
    }
  }
  return null;
}

/**
 * Get the entry status code for an umbrella.
 * This is the default status assigned when dragging a contact into this column.
 */
export function getEntryStatusForUmbrella(umbrellaId: UmbrellaId): number {
  return STATUS_UMBRELLAS[umbrellaId].entry;
}

/**
 * Get the column ID for a given status code.
 * Alias for getUmbrellaForStatus for backward compatibility.
 * Returns "other" if the code doesn't match any known group.
 */
export function getColumnForStatus(statusCode: number | undefined | null): PipelineColumnId | "other" {
  const umbrella = getUmbrellaForStatus(statusCode);
  return umbrella ?? "other";
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
