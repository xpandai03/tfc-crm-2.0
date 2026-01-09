// Configuration for mock vs live data mode
// Change to "live" to use real n8n webhooks instead of mock data
export type DataMode = "mock" | "live";
export const DATA_MODE: DataMode = "mock";

// n8n webhook URLs (used when DATA_MODE is "live")
export const N8N_ENDPOINTS = {
  contactSnapshot: "https://n8n-familyconnection.agentglu.agency/webhook/get-contact-snapshot",
  waitlistSummary: "https://n8n-familyconnection.agentglu.agency/webhook/get-waitlist-summary",
} as const;
