/**
 * ============================================================================
 * PUBLIC CLIENT SURVEY — SEPARATE BUNDLE, NOT PART OF THE CRM SPA
 * ============================================================================
 *
 * This is a second, independently built front end. It exists as its own bundle
 * for the same reason client/public/roadmap.html exists as a standalone file,
 * and the reasoning is worth repeating here because it is the whole point of
 * this directory:
 *
 *   server/auth.ts's authMiddleware runs before serveStatic, so /assets/* 302s
 *   to /auth/login for anonymous visitors. Serving a public page through the
 *   CRM's SPA would have meant allow-listing /assets/*, which publishes the
 *   ENTIRE client bundle — including the hardcoded staff email allow-lists in
 *   shared/access-control.ts — to anyone with the link.
 *
 * A second reason applies here that did not to the roadmap: client/src/App.tsx
 * wraps its whole router in AuthenticatedApp, which renders <Login /> whenever
 * isAuthenticated is false. A <Route path="/survey"> inside that app would show
 * anonymous visitors a login screen.
 *
 * SO, THE RULES FOR EVERYTHING IN client-survey/:
 *
 *   1. NEVER import from shared/access-control.ts, directly or transitively.
 *   2. NEVER import from client/src/ — not a page, not a component, not a hook,
 *      not a lib helper. The "@" alias is deliberately NOT configured in
 *      vite.survey.config.ts, so such an import fails the build rather than
 *      succeeding quietly.
 *   3. Imports from shared/ are allowed only for modules that are themselves
 *      free of staff data. Today that is exactly shared/survey-questions.ts.
 *
 * script/assert-survey-bundle.ts enforces rules 1 and 3 against the EMITTED
 * JavaScript, not the source, and fails `npm run build` if a staff address ever
 * appears in the output.
 *
 * This bundle serves both survey variants; which one renders is decided by the
 * URL path, matching the client's decision that in-person and telehealth are
 * two separate links.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { variantFromPath } from "@shared/survey-questions";
import { SurveyForm } from "./SurveyForm";
import "./survey.css";

/** /survey/in-person -> "in-person". Anything else renders the notice below. */
function variantFromLocation(): ReturnType<typeof variantFromPath> {
  const parts = window.location.pathname.split("/").filter(Boolean);
  // ["survey", "<variant>"]
  return variantFromPath(parts[1] ?? "");
}

function UnknownForm() {
  return (
    <div className="shell">
      <header className="shell__header">
        <div className="shell__header-inner">
          <img className="shell__logo" src="/tfc-logo.jpg" alt="The Family Connection" />
        </div>
      </header>
      <main className="shell__main">
        <div className="card">
          <h1 className="card__title">This link doesn&rsquo;t look right</h1>
          <p className="card__description">
            Please check the link from your email, or scan the code again. If it
            still doesn&rsquo;t work, contact the office and we will take your
            feedback directly.
          </p>
        </div>
      </main>
    </div>
  );
}

const variant = variantFromLocation();
const container = document.getElementById("survey-root");

if (container) {
  createRoot(container).render(
    <StrictMode>
      {variant ? <SurveyForm variant={variant} /> : <UnknownForm />}
    </StrictMode>,
  );
}
