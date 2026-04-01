// Configuration for mock vs live data mode
// The client always talks to the server's /api/* routes — never directly to n8n.
// These are only used when DATA_MODE is "live" (currently unused).
export type DataMode = "mock" | "live";
export const DATA_MODE: DataMode = "mock";

export const N8N_ENDPOINTS = {
  contactSnapshot: "/api/get-contact-snapshot",
  waitlistSummary: "/api/waitlist-summary",
} as const;
