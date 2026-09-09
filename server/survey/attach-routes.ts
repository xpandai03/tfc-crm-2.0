/**
 * INTERNAL: the survey PDF the agent fetches.
 * ============================================================================
 *
 * MOUNTED BEFORE app.use(authMiddleware), and that is the whole point.
 *
 * The agent has no session and no cookie — it fetches the document itself, with
 * an API key. The two internal PDF routes it already uses (contact-intake-pdf,
 * contact-snapshot-pdf) are reachable because they are listed in server/auth.ts's
 * publicPaths. Adding a third entry there would mean editing auth middleware,
 * which this build must not do.
 *
 * So it takes the other route this codebase already established for exactly
 * this: mount above the middleware. The roadmap page (server/index.ts:159),
 * the Resend delivery webhook and the whole public survey surface
 * (./routes.ts) are all mounted this way, for the same reason and with the same
 * reasoning — one route is exposed above the guard, nothing in auth.ts changes,
 * and every other route keeps its guard.
 *
 * "Above the guard" is not "unguarded". This route is gated on X-API-Key against
 * TN_API_KEY, exactly as the two routes it mirrors are, and answers 401 without
 * it. Being above authMiddleware only means the middleware does not get to 302
 * the agent to a login page first.
 *
 * WHY NOT REUSE THE STAFF ROUTE. /api/survey/pdf/:submissionId is session-gated
 * and must stay that way — it is the only route that serves survey content to a
 * browser. Two callers, two gates, one generator.
 *
 * LOGGING: submission id and outcome only. Never the filename, which contains a
 * name.
 */

import type { Express, Request, Response } from "express";
import { SURVEY_FORM_TYPE } from "@shared/survey-questions";
import { getSubmissionById } from "../sync/db";
import { isSurveyPayload } from "../pdf/survey-template";

export function registerSurveyAttachInternalRoutes(app: Express): void {
  app.get("/api/internal/survey-pdf/:submissionId", async (req: Request, res: Response) => {
    const submissionId = parseInt(req.params.submissionId, 10);
    try {
      const apiKey = req.headers["x-api-key"] as string | undefined;
      if (!process.env.TN_API_KEY || apiKey !== process.env.TN_API_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      if (isNaN(submissionId)) {
        return res.status(400).json({ error: "submissionId must be a number" });
      }

      const submission = await getSubmissionById(submissionId);
      if (!submission) {
        console.warn(`[internal-survey-pdf] NOT FOUND: id=${submissionId}`);
        return res.status(404).json({ error: "Submission not found" });
      }
      // Two independent checks, as on the staff route: form_type is what the
      // page switches on, the payload shape is what the builder needs.
      if (submission.formType !== SURVEY_FORM_TYPE || !isSurveyPayload(submission.payload)) {
        console.warn(`[internal-survey-pdf] REJECTED: id=${submissionId} is not a survey`);
        return res.status(400).json({ error: "That submission is not a client survey" });
      }

      // THE SAME GENERATOR THE STAFF DOWNLOAD USES. There is one survey PDF, so
      // what a clinician opens off the chart is what a staff member would have
      // downloaded and attached by hand.
      const pdfmake = require("pdfmake");
      pdfmake.addFonts(require("pdfmake/standard-fonts/Helvetica"));
      const { buildSurveyDocument } = await import("../pdf/survey-template");
      const pdfDoc = pdfmake.createPdf(buildSurveyDocument(submission));

      res.setHeader("Content-Type", "application/pdf");
      // Filename carries the submission id only — the staff download's filename
      // includes the client's name, and this one is fetched by a machine.
      res.setHeader("Content-Disposition", `inline; filename="Client-Survey-Sub${submission.id}.pdf"`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");

      const stream = await pdfDoc.getStream();
      stream.pipe(res);
      stream.end();
      console.log(`[internal-survey-pdf] SERVED: id=${submissionId}`);
    } catch (error) {
      console.error(
        `[internal-survey-pdf] FAILED: id=${submissionId}:`,
        error instanceof Error ? error.message : "unknown",
      );
      if (!res.headersSent) return res.status(500).json({ error: "Failed to generate the survey PDF" });
    }
  });

  console.log("[survey-attach] Internal survey-PDF route mounted (X-API-Key gated)");
}
