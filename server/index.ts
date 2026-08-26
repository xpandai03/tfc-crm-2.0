import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { configureAuth, authMiddleware } from "./auth";
import { initRemindersTable, startReminderCron, startMonthlyReportCron } from "./reminders";
import { initTherapyNotesTable } from "./therapy-notes";
import { initEmailSnapshotsTable } from "./email-snapshots";
import { initAssignmentsTable } from "./assignments/db";
import { initSyncTables } from "./sync/db";
import { initActivityTable } from "./activity/db";
import { initEmailTemplatesTable } from "./email/templates";
import { initViewPreferencesTable } from "./view-preferences/db";
import { initReportSendsTable } from "./reports/db";

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

// ============================================================================
// API request log — METADATA ONLY. Never a response body.
//
// This middleware used to monkey-patch res.json to capture every /api response
// and append it to the log line in full. On a HIPAA-adjacent system that meant
// every waitlist load wrote the entire contact set — names, emails, phones,
// dates of birth, addresses — to stdout, and from there to the hosting log
// stream. Contact detail views, exports and every other client-data response
// did the same, on every request.
//
// Bodies are now not captured at all. The res.json patch is gone rather than
// made conditional: a capture that exists can be re-enabled by a one-line
// change under deadline pressure, and the retained closure also held every
// response in memory until the request finished.
//
// TRUNCATION WAS CONSIDERED AND REJECTED. A 200-character prefix of a contact
// array still contains names and email addresses; it would have reduced the
// volume of exposure while creating the impression it was solved.
//
// QUERY STRINGS: req.path is the pathname only — Express excludes the query
// string from it, so query values were never logged and still are not. This
// deliberately does NOT switch to req.originalUrl: search and filter endpoints
// carry client names in their parameters (?q=, ?search=), so logging the full
// URL would reintroduce the same class of leak through a different door.
//
// ERROR RESPONSES get the same treatment — status code only, no payload. A
// validation failure is exactly where a route is most likely to echo the
// submitted record straight back. The error MESSAGES are not lost: routes
// already log their own via console.error("[route] Error:", message), where a
// developer chose the string, rather than the middleware serialising whatever
// the response happened to contain.
// ============================================================================
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    if (!path.startsWith("/api")) return;
    const duration = Date.now() - start;
    log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
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

  // ==========================================================================
  // PUBLIC: client-facing roadmap page
  //
  // Mounted HERE — before app.use(authMiddleware) — on purpose. That is the
  // whole reason this page is a standalone HTML file rather than a route in the
  // React app: authMiddleware runs before serveStatic, so anything the SPA
  // needs (including /assets/*) 302s to /auth/login for anonymous visitors.
  // Serving the roadmap through the SPA would have meant allow-listing
  // /assets/*, publishing the entire client bundle — staff email allow-lists
  // included — to anyone with the link. Mounting one inert file above the
  // middleware exposes exactly that file and changes no auth logic: nothing in
  // server/auth.ts was touched, and every other route keeps its guard.
  //
  // The file itself has no JavaScript and makes no requests. See
  // client/public/roadmap.html.
  // ==========================================================================
  const roadmapPath = (() => {
    // Dev serves the SOURCE file so edits show on reload; production serves the
    // copy Vite emitted into dist/public. Ordering matters: a developer with a
    // stale dist/ from an earlier build would otherwise keep seeing the old
    // page and wonder why their edits did nothing.
    const source = path.resolve(process.cwd(), "client", "public", "roadmap.html");
    const built = [
      // Bundled to dist/index.cjs (CJS, so __dirname exists and is dist/), with
      // client/public/* copied to dist/public/* by the Vite build. Mirrors how
      // server/static.ts resolves.
      // package.json sets "type": "module", so under tsx (dev) this file is ESM
      // and __dirname is NOT defined — hence the typeof guard rather than a
      // bare reference, which would throw at startup.
      typeof __dirname !== "undefined"
        ? path.resolve(__dirname, "public", "roadmap.html")
        : null,
      // Fallback keyed off the working directory (the Dockerfile sets
      // WORKDIR /app and starts with `node dist/index.cjs`).
      path.resolve(process.cwd(), "dist", "public", "roadmap.html"),
    ].filter((p): p is string => !!p);

    const candidates =
      process.env.NODE_ENV === "production" ? [...built, source] : [source, ...built];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  })();

  if (roadmapPath) {
    log(`Public roadmap page served from ${roadmapPath}`);
  } else {
    log("Warning: roadmap.html not found; /roadmap will 404", "roadmap");
  }

  app.get("/roadmap", (_req, res) => {
    // Resolved once at startup, but a missing marketing page must never take
    // the CRM down — degrade to a 404 rather than throwing.
    if (!roadmapPath) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.type("text/html; charset=utf-8");
    res.sendFile(roadmapPath);
  });

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
    await initEmailTemplatesTable();
    // Prod creates this via migrations/add-user-view-preferences.sql
    // (schema-before-code, C16); this keeps fresh/non-prod DBs in step.
    await initViewPreferencesTable();
    await initReportSendsTable();
    startReminderCron();
    // Monthly management report. Schedule + timezone are logged on the line
    // below at boot, so the deployed cadence is readable from the startup log
    // rather than inferred from the code.
    startMonthlyReportCron();
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
