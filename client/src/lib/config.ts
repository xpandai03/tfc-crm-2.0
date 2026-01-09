// Configuration for mock vs live data mode
// Set to true to use live n8n webhooks instead of mock data
export const USE_LIVE_DATA = false;

// n8n webhook URLs (used when USE_LIVE_DATA is true)
export const N8N_ENDPOINTS = {
  contactSnapshot: "https://n8n-familyconnection.agentglu.agency/webhook/get-contact-snapshot",
  waitlistSummary: "https://n8n-familyconnection.agentglu.agency/webhook/get-waitlist-summary",
} as const;
