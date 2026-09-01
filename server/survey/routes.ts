/**
 * PUBLIC: client survey forms.
 * ============================================================================
 *
 * Mounted BEFORE app.use(authMiddleware) in server/index.ts, for exactly the
 * reason the roadmap page and the Resend delivery webhook are (server/index.ts
 * :154-254): a client filling in a survey has no session and no bearer token.
 * server/auth.ts is NOT touched — no path was added to its publicPaths or
 * publicPostPaths lists, and no auth logic changed. Every other route keeps its
 * guard.
 *
 * WHY A SEPARATE BUNDLE RATHER THAN A ROUTE IN THE SPA. Two independent
 * reasons, both already established in this repo:
 *
 *   1. authMiddleware runs before serveStatic, so /assets/* 302s to
 *      /auth/login for anonymous visitors. Serving the survey through the SPA
 *      would mean allow-listing /assets/*, which publishes the entire client
 *      bundle — including the hardcoded staff email allow-lists in
 *      shared/access-control.ts — to anyone with the link. This is the same
 *      finding client/public/roadmap.html:1-30 records.
 *   2. client/src/App.tsx:51-82 wraps the whole router in AuthenticatedApp,
 *      which renders <Login /> whenever isAuthenticated is false. A route added
 *      to App.tsx would show anonymous visitors a login screen.
 *
 * The survey therefore builds to its own bundle under dist/public/survey-app
 * and is served here under its own /survey-assets/ prefix, which can never
 * collide with the main client's /assets/ path. script/assert-survey-bundle.ts
 * fails the build if a staff address ever appears in the emitted output.
 *
 * WHAT THIS SURFACE CAN READ. One roster read (names and locations only, see
 * ./roster.ts) and one write. It holds no session, calls no contact endpoint,
 * and renders nothing it did not receive from the person filling it in.
 */

import express, { type Express, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import {
  SURVEY_FORM_TYPE,
  SURVEY_SOURCE,
  SURVEY_VARIANTS,
  variantFromPath,
  type SurveyVariant,
} from "@shared/survey-questions";
import { insertSubmission } from "../sync/db";
import { logActivity } from "../activity/db";
import { getPublicProviderRoster } from "./roster";
import {
  SURVEY_MAX_BODY_BYTES,
  buildSurveyPayload,
  completionTimingProblem,
  honeypotTripped,
  serverDateOfBirthProblem,
  surveySubmissionSchema,
} from "./schema";
import {
  SURVEY_MAX_PER_DAY,
  SURVEY_MAX_PER_HOUR,
  checkSurveyRateLimit,
  clientIpFromRequest,
  recordSurveySubmission,
} from "./rate-limit";

/**
 * Where the built survey bundle lives. Mirrors how server/index.ts:169-199
 * resolves roadmap.html and how server/static.ts resolves the client: bundled
 * to dist/index.cjs (CJS, so __dirname is dist/), with the survey build
 * emitting to dist/public/survey-app.
 *
 * Unlike the roadmap there is no source fallback — the survey is React and has
 * to be built. In development run `npm run dev:survey` alongside `npm run dev`
 * to rebuild it on change; the route below says so plainly if it is missing,
 * rather than 404ing and leaving a developer guessing.
 */
function resolveSurveyDir(): string | null {
  const candidates = [
    // package.json sets "type": "module", so under tsx (dev) this file is ESM
    // and __dirname is not defined — hence the typeof guard, as in index.ts.
    typeof __dirname !== "undefined"
      ? path.resolve(__dirname, "public", "survey-app")
      : null,
    path.resolve(process.cwd(), "dist", "public", "survey-app"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(path.join(p, "index.html"))) ?? null;
}

/**
 * Headers every survey page carries.
 *
 *  - noindex/nofollow: the survey is handed out by link and QR code, not found
 *    by search. Matches client/public/roadmap.html:36.
 *  - frame-ancestors 'none': no framing headers exist anywhere in this codebase
 *    today, so a public form collecting patient data is currently framable by
 *    any site — an overlay/clickjacking surface. The DrSnip intake app's
 *    api/_lib/frame-policy.ts documents the same finding. Scoped to
 *    frame-ancestors only: a full CSP would need script-src and style-src
 *    decisions this build has not made.
 *  - no-store: a lobby device is shared, and a cached survey page with answers
 *    restored by bfcache is a disclosure to the next person holding the phone.
 */
function setSurveyPageHeaders(res: Response): void {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store, must-revalidate");
}

export function registerSurveyPublicRoutes(app: Express): void {
  const surveyDir = resolveSurveyDir();

  if (surveyDir) {
    console.log(`[survey] Public survey bundle served from ${surveyDir}`);
  } else {
    console.warn(
      "[survey] Survey bundle not found — run `npm run build:survey`. " +
        "/survey/* will return a build notice until it exists.",
    );
  }

  // --------------------------------------------------------------------------
  // Assets. Distinct prefix so this can never reach the main client's /assets/.
  // index.html is excluded: the page is only ever entered through /survey/:variant,
  // which is what applies the headers above.
  // --------------------------------------------------------------------------
  if (surveyDir) {
    app.use(
      "/survey-assets",
      express.static(surveyDir, {
        index: false,
        maxAge: "1y",
        immutable: true,
        setHeaders: (res) => {
          res.setHeader("X-Robots-Tag", "noindex, nofollow");
        },
      }),
    );
  }

  // --------------------------------------------------------------------------
  // The two pages. Client decision: modality comes from the path, so there is
  // no "was it in person or video?" question to get wrong.
  // --------------------------------------------------------------------------
  app.get("/survey/:variant", (req: Request, res: Response) => {
    const variant = variantFromPath(req.params.variant ?? "");
    if (!variant) {
      setSurveyPageHeaders(res);
      res.status(404).type("text/plain").send("Not found");
      return;
    }

    if (!surveyDir) {
      // A missing build must not take the CRM down, and must not look like a
      // client-facing error either.
      setSurveyPageHeaders(res);
      res
        .status(503)
        .type("text/plain")
        .send("This form is not available yet. Please contact the office.");
      return;
    }

    setSurveyPageHeaders(res);
    res.type("text/html; charset=utf-8");
    res.sendFile(path.join(surveyDir, "index.html"));
  });

  // --------------------------------------------------------------------------
  // Roster. Names and locations only — see ./roster.ts.
  // --------------------------------------------------------------------------
  app.get("/api/public/survey/providers", async (_req: Request, res: Response) => {
    try {
      const providers = await getPublicProviderRoster();
      // Count only. A provider roster is not PHI, but there is no reason for a
      // log line to carry a list of names either.
      console.log(`[survey] roster served (${providers.length} active)`);
      return res.json({ providers });
    } catch (error) {
      console.error(
        "[survey] roster lookup failed:",
        error instanceof Error ? error.message : "unknown",
      );
      // The form renders an honest empty state rather than crashing.
      return res.status(200).json({ providers: [], degraded: true });
    }
  });

  // --------------------------------------------------------------------------
  // The one write.
  //
  // NOT POSTed to /api/submissions (server/routes.ts:6266): that endpoint is
  // public and accepts any object as `data`, so it guarantees nothing about the
  // shape of what lands in the row.
  //
  // No survey field value reaches a log line anywhere in this handler. Every
  // console call carries counts, ids and fixed reason strings only — the same
  // discipline as server/routes.ts:6311 and the same reason the request logger
  // at server/index.ts:77-107 stopped capturing bodies. Errors are caught here
  // and answered with fixed strings; nothing is allowed to reach the error
  // handler at server/index.ts:292-298, which re-throws.
  // --------------------------------------------------------------------------
  app.post("/api/public/survey/:variant", async (req: Request, res: Response) => {
    const variant = variantFromPath(req.params.variant ?? "");
    if (!variant) {
      return res.status(404).json({ error: "Unknown form" });
    }

    try {
      // Body size. The global express.json limit is 5mb, sized for the sync
      // endpoint; the body is already parsed by the time this runs, so this
      // bounds what gets STORED rather than what gets buffered. A per-route
      // parser would need to sit above the global one in server/index.ts:34.
      const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (raw && raw.length > SURVEY_MAX_BODY_BYTES) {
        console.warn(`[survey] REJECTED: body over limit (${raw.length} bytes)`);
        return res.status(413).json({ error: "That response is too long to submit." });
      }

      const parsed = surveySubmissionSchema(variant).safeParse(req.body);
      if (!parsed.success) {
        // Field NAMES only, never values — a validation failure is exactly
        // where a route is most likely to echo the submitted record.
        const fields = parsed.error.issues
          .map((i) => i.path.join("."))
          .filter(Boolean)
          .slice(0, 8);
        console.warn(
          `[survey] REJECTED: schema (${variant}) fields=[${fields.join(", ")}]`,
        );
        return res
          .status(400)
          .json({ error: "Some answers were missing or invalid. Please check the form." });
      }
      const input = parsed.data;

      // Honeypot. Silent success: an error message teaches a bot what tripped.
      if (honeypotTripped(input)) {
        console.log("[survey] honeypot tripped — accepted, nothing stored");
        return res.json({ success: true });
      }

      const now = Date.now();
      const timing = completionTimingProblem(input.formLoadedAt, now);
      if (timing === "too-fast") {
        console.warn("[survey] REJECTED: completed implausibly fast");
        return res
          .status(429)
          .json({ error: "That was submitted too quickly. Please try again." });
      }
      if (timing === "stale") {
        console.warn("[survey] REJECTED: stale form load");
        return res.status(400).json({
          error: "This form has been open too long. Please reload and start again.",
        });
      }

      const dobProblem = serverDateOfBirthProblem(input.client.dateOfBirth, new Date(now));
      if (dobProblem) {
        console.warn("[survey] REJECTED: date of birth failed validation");
        return res.status(400).json({ error: dobProblem });
      }

      // Rate limit is checked AFTER validation so a malformed request cannot
      // spend a real client's budget, and recorded only on a stored row.
      const ip = clientIpFromRequest(req);
      const limit = checkSurveyRateLimit(ip, now);
      if (!limit.allowed) {
        // No address in the log line.
        console.warn(`[survey] REJECTED: rate limit (${limit.window} window)`);
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
        return res.status(429).json({
          error:
            "We have received a lot of responses from this network. Please try again later.",
        });
      }

      const submittedAt = new Date(now).toISOString();
      const payload = buildSurveyPayload(variant, input, submittedAt);

      const id = await insertSubmission({
        formType: SURVEY_FORM_TYPE,
        source: SURVEY_SOURCE,
        submittedAt,
        // Matching to a contact is Sept 11 work. Until then a survey row stands
        // alone, which form_submissions already allows — contact_id is nullable
        // (server/sync/db.ts:318-327).
        contactId: null,
        name: input.client.name,
        data: payload,
      });

      recordSurveySubmission(ip, now);

      // Activity log: deliberately NOT the client's name. logActivity persists
      // entity_name (server/activity/db.ts:118-136) and the Activity page
      // renders it, so passing a name here would put "<person> submitted a
      // satisfaction survey" into a feed. The submission id keeps the trail.
      await logActivity({
        type: "submission_received",
        actorEmail: "system",
        entityType: "submission",
        entityId: String(id),
        entityName: `Client survey (${variant === "in-person" ? "In Person" : "Telehealth"})`,
        metadata: { formType: SURVEY_FORM_TYPE, source: SURVEY_SOURCE, variant },
      });

      console.log(`[survey] Ingested: id=${id} variant=${variant} source=${SURVEY_SOURCE}`);
      return res.json({ success: true });
    } catch (error) {
      console.error(
        "[survey] Submission failed:",
        error instanceof Error ? error.message : "unknown",
      );
      return res
        .status(500)
        .json({ error: "We could not save your response. Please try again." });
    }
  });

  console.log(
    `[survey] Public routes mounted for ${SURVEY_VARIANTS.join(", ")} ` +
      `(rate limit ${SURVEY_MAX_PER_HOUR}/hour, ${SURVEY_MAX_PER_DAY}/day per address)`,
  );
}

export type { SurveyVariant };
