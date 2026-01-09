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

In `server/routes.ts`, toggle the constant:
```typescript
const USE_LIVE_DATA = false; // Set to true for live n8n webhooks
```

When `USE_LIVE_DATA` is `true`, the API routes will forward requests to the n8n webhooks. When `false` (default), mock data is used.

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
- `GET /api/waitlist-contacts` - Get all waitlist contacts
- `GET /api/config` - Get app configuration

## n8n Webhook URLs (Production)

- Contact snapshot: `https://n8n-familyconnection.agentglu.agency/webhook/get-contact-snapshot`
- Waitlist summary: `https://n8n-familyconnection.agentglu.agency/webhook/get-waitlist-summary`

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

### Status Mapping
Status codes are defined in `client/src/lib/status-config.ts`:
```typescript
const STATUS_MAP = {
  intake: 100,
  waiting: 101,
  ready_to_schedule: 200,
  scheduled: 202,
  on_hold: 300,
  closed: 400,
};
```

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
