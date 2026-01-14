# TFC CRM Demo

A lightweight CRM demo for The Family Connection (TFC). This is a working prototype demonstrating:
- A faster, clearer admin workflow than a raw spreadsheet
- How AI can analyze and advise without slowing admins down
- How existing Excel + n8n automations remain the system of record

## Overview

This demo showcases the future state of TFC's CRM without rebuilding the backend. Excel remains the source of truth, with all data access going through n8n webhooks.

## Running the App

```bash
npm run dev
```

The app runs on port 5000.

## Switching Mock → Live Mode

In both `server/routes.ts` and `client/src/lib/config.ts`, toggle the constant:
```typescript
const DATA_MODE: DataMode = "mock"; // Change to "live" for n8n webhooks
```

When `DATA_MODE` is `"live"`, the API routes will:
1. Forward requests to the n8n webhooks
2. Fall back to mock data if live fetch fails
3. Return `_source` field ("mock", "live", or "fallback") with each response

The UI automatically displays:
- Data source indicator in header (Mock data / Live Excel data / Fallback Mode)
- "Last synced" timestamp with Refresh button on each page
- Warning banner when using fallback data

## Project Structure

```
/client
  /src
    /components
      /layout         - Page layout and navigation
      /kanban         - Kanban board components
      /ui             - Reusable UI components (Shadcn)
    /lib              - API client, mock data, utilities
    /pages            - Page components
      home.tsx        - Today View (/)
      waitlist.tsx    - Pipeline View (/waitlist)
      contact-detail.tsx - Contact Page (/contact/[name])
      insights.tsx    - Summary View (/insights)
/server
  routes.ts           - API proxy routes
/shared
  schema.ts           - TypeScript types and Zod schemas
```

## Pages

1. **Home/Today View** (`/`) - Priority queues, metrics, AI suggestions
2. **Waitlist Pipeline** (`/waitlist`) - Kanban-style status columns
3. **Contact Detail** (`/contact/:name`) - Contact info, notes, status, AI panel
4. **Insights** (`/insights`) - Dashboard with analytics

## API Endpoints

- `POST /api/get-contact-snapshot` - Get contact details by name
- `POST /api/get-waitlist-summary` - Get waitlist metrics
- `POST /api/get-waitlist-board` - Get contact rows for Kanban (live Excel data)
- `GET /api/waitlist-contacts` - Get all waitlist contacts (legacy)
- `GET /api/config` - Get app configuration

## n8n Webhook URLs (Production)

Webhook URLs are stored as environment variables (server-only, never exposed to frontend):

```
N8N_GET_CONTACT_SNAPSHOT_URL    - Read contact details
N8N_GET_WAITLIST_SUMMARY_URL    - Read waitlist summary
N8N_GET_WAITLIST_BOARD_URL      - Read contact rows for Kanban
N8N_UPDATE_CONTACT_STATUS_URL   - Update contact status in Excel
N8N_UPDATE_AGENT_NOTES_URL      - Add notes to Excel
```

Default endpoints (if env vars not set):
- Contact snapshot: `https://n8n-familyconnection.agentglu.agency/webhook/get-contact-snapshot`
- Waitlist summary: `https://n8n-familyconnection.agentglu.agency/webhook/get-waitlist-summary`
- Waitlist board: `https://n8n-familyconnection.agentglu.agency/webhook/get-waitlist-board`
- Update status: `https://n8n-familyconnection.agentglu.agency/webhook/update-contact-status`
- Add note: `https://n8n-familyconnection.agentglu.agency/webhook/update-agent-notes`

## New UX Features

### Drag & Drop Status Updates
- Cards can be dragged between columns on the Waitlist Pipeline page
- Status updates immediately (optimistic UI)
- Toast confirms the change
- Background API call persists to server
- Automatic rollback if server write fails

### Quick-Add Note from Card
- Hover over any card to reveal the + button (top-right)
- Click to open a lightweight modal
- Add note without leaving the pipeline view
- Notes appear in the contact detail timeline
- Toast confirms success

### Status Configuration
All status code semantics are centralized in `client/src/lib/status-config.ts`:

```typescript
// Status code to label mapping (matches TFC spreadsheet)
STATUS_LABELS = {
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

// Logical groups for pipeline columns
STATUS_GROUPS = {
  intake: [100],
  waiting: [101, 102],
  ready_to_schedule: [200],
  pending_scheduling: [201, 203],
  scheduled: [202],
  pm_review: [300],
  declined: [103, 204],
  inactive: [104, 400],
};
```

Key functions:
- `isActiveStatus(code)` - Returns true if code is not in declined/inactive
- `getColumnForStatus(code)` - Returns pipeline column ID for a status code
- `getStatusLabel(code)` - Returns human-readable label for a status code
- `stringStatusToCode(status)` - Converts legacy string status to numeric code
- `safeNumber(val)` / `safeString(val)` - Safe display helpers that return "---" for null/undefined

### How Kanban Grouping Works
- Each pipeline column maps to a set of status codes via `STATUS_GROUPS`
- A contact appears in a column if: `STATUS_GROUPS[columnKey].includes(contact.statusCode)`
- Every contact appears in exactly one column
- Unknown status codes go to a "Needs Review" column
- Declined and inactive contacts are filtered out of the active pipeline

### How Insights Avoids Crashes
- All metrics are computed client-side from the contacts array
- Frontend-computed metrics are the source of truth when contacts are loaded
- Summary data is only used as fallback during initial load (before contacts are available)
- Null-safe guards on all data access: `if (!contacts || !Array.isArray(contacts))`
- `safeNumber()` and `safeString()` helpers display "---" instead of undefined
- Never call `Object.values(undefined)` - always check first

### Metric Definitions (Match Spreadsheet)
- **Active Waitlist**: Contacts NOT in declined (103, 204) or inactive (104, 400)
- **Over 60 Days**: `daysOnWaitlist >= 60` AND Active
- **Ready to Schedule**: `statusCode === 200`
- **Average Wait Time**: Average `daysOnWaitlist` across Active Waitlist only

### Honest Data Source Indicators
The UI tracks data sources per-screen to ensure transparency:

```typescript
type DataSource = "live" | "fallback" | "mock";
type DataMode = "mock" | "live";
```

- **dataMode**: User-controlled mode (mock or live)
- **summarySource**: Tracks `/api/get-waitlist-summary` response source
- **contactsSource**: Tracks `/api/waitlist-contacts` response source
- **isFullyLive**: True only when dataMode is "live" AND both summary AND contacts are live

### User-Controlled Data Mode Toggle

The header displays the current data mode with explicit toggle controls:

- **Mock Mode**: Shows "Mock data" indicator with "Enable Live Excel" button
- **Live Mode**: Shows "Live Excel data" indicator with "Use Demo" button
- **Enabling**: Shows loading spinner while testing connection

When user clicks "Enable Live Excel":
1. Tests connection to `/api/get-waitlist-summary`
2. If response has `_source: "live"`, switches to live mode
3. Refetches all data and enables Kanban interactions
4. If connection fails, shows error toast and stays in mock mode

**Key Principles:**
- No silent mode switching - user must explicitly enable/disable
- Refresh button does NOT change modes - only the toggle does
- Demo mode is safe and controllable
- Fallback is recoverable without page reload

Screen-specific behavior:
- **Today/Insights**: Show "Aggregate metrics are live — contact data is demo" when summary is live but contacts are fallback
- **Waitlist Pipeline**: 
  - Shows "Contact-level live data not enabled — showing demo rows. Aggregate metrics are live." when contacts are demo
  - Disables drag-to-status and quick-add note in demo mode
  - Displays toast notifications when attempting disabled actions

This ensures users are never misled about what data is real vs demo.

## Intentionally Left Out

- ❌ Authentication / Permissions
- ❌ Provider matching logic
- ❌ Email sending
- ❌ Full AI reasoning (placeholders only)
- ❌ Spreadsheet editing
- ❌ Direct Excel API connections

This is a visual + functional demo, not a final product.

## Tech Stack

- **Frontend:** React + Vite + Wouter (routing)
- **Styling:** Tailwind CSS + Shadcn/UI
- **State:** React Query + component state
- **Backend:** Express (proxy to n8n)
- **Data:** Mock JSON (matches webhook response shapes)

## User Preferences

- Modern, clean admin interface
- Fast first paint, no blocking spinners for AI
- Spreadsheet should never feel faster than this UI
