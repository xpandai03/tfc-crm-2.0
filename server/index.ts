import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { configureAuth, authMiddleware } from "./auth";
import { initRemindersTable, startReminderCron } from "./reminders";
import { initTherapyNotesTable } from "./therapy-notes";
import { initEmailSnapshotsTable } from "./email-snapshots";
import { initAssignmentsTable } from "./assignments/db";
import { initSyncTables } from "./sync/db";
import { initActivityTable } from "./activity/db";

const app = express();
const httpServer = createServer(app);

// CRITICAL: Disable ETag for all routes to prevent 304 responses
// This ensures fresh data is always returned, never cached fallback
app.set("etag", false);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "5mb", // Increased for sync endpoint (500+ contacts payload)
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// CORS: allow intake form (and other cross-origin clients) to reach /api/*
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Provider-Form-Key");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// CRITICAL: Prevent ALL caching for API routes
// This prevents 304 responses that could serve stale fallback data
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Staging-mode detection logging
  const stagingIndicators: string[] = [];
  if (!process.env.AZURE_AD_CLIENT_ID || process.env.AZURE_AD_CLIENT_ID === "disabled") {
    stagingIndicators.push("Azure AD auth BYPASSED");
  }
  if (!process.env.RESEND_API_KEY) {
    stagingIndicators.push("Resend email DISABLED");
  }
  if (!process.env.SYNC_API_KEY) {
    stagingIndicators.push("Sync inbound DISABLED");
  }
  const isN8nOff = (url: string | undefined) => !url || url === "disabled" || url?.startsWith("http://localhost:1");
  if (isN8nOff(process.env.N8N_GET_WAITLIST_BOARD_URL)) {
    stagingIndicators.push("n8n webhooks DISABLED");
  }
  if (isN8nOff(process.env.TN_AGENT_URL) || !process.env.TN_API_KEY) {
    stagingIndicators.push("TherapyNotes DISABLED");
  }

  if (stagingIndicators.length > 0) {
    log("========================================", "staging");
    log("STAGING MODE DETECTED", "staging");
    for (const indicator of stagingIndicators) {
      log(`  → ${indicator}`, "staging");
    }
    log("========================================", "staging");
  }

  configureAuth(app);

  // Apply auth middleware to protect all routes except /auth/*
  app.use(authMiddleware);

  await registerRoutes(httpServer, app);

  // Initialize database tables (Postgres)
  try {
    await initRemindersTable();
    await initTherapyNotesTable();
    await initEmailSnapshotsTable();
    await initAssignmentsTable();
    await initSyncTables();
    await initActivityTable();
    startReminderCron();
    // Phase 3: load the crm_providers-derived email-axis directory, then keep it
    // fresh on an interval (mutations also refresh it on write). Sync resolvers
    // fall back to PROVIDER_LIST until/if this populates, so startup is safe.
    const { refreshCrmDirectory } = await import("./providers/directory");
    const dirN = await refreshCrmDirectory();
    log(`Provider directory loaded (${dirN} active emailed providers)`);
    setInterval(() => { void refreshCrmDirectory(); }, 5 * 60 * 1000);
    log("Database and reminder system initialized (Postgres)");
  } catch (err) {
    log(`Warning: Database initialization failed: ${err}`, "db");
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Default to 3000 to match Fly.io config.
  // Must bind to 0.0.0.0 for Fly.io to route traffic to the container.
  const port = parseInt(process.env.PORT || "3000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
