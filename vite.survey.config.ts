import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * Build config for the PUBLIC client survey bundle.
 * ============================================================================
 *
 * Separate from vite.config.ts on purpose. The main config's root is client/
 * and it emits to dist/public with assets under /assets/, which authMiddleware
 * gates. This one emits a self-contained bundle to dist/public/survey-app with
 * its assets addressed under /survey-assets/, which server/survey/routes.ts
 * serves publicly. The two asset paths can never collide, so making the survey
 * public never widens access to the CRM's bundle.
 *
 * NOTE THE ALIASES. Only "@shared" is defined. "@" (client/src) and "@assets"
 * are deliberately absent, so an accidental `import ... from "@/components/..."`
 * in this bundle is a BUILD FAILURE rather than a silent inclusion of the CRM's
 * component tree — and, through it, shared/access-control.ts. That omission is
 * load-bearing; do not add "@" here for convenience.
 */
export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname, "client-survey"),
  // Emitted asset URLs. Must match the express.static mount in
  // server/survey/routes.ts.
  base: "/survey-assets/",
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public/survey-app"),
    // False on purpose: script/build.ts runs this AFTER the main client build,
    // and the main build empties all of dist/public. Emptying again here would
    // be harmless today but would silently delete the survey output if the
    // build order were ever reversed.
    emptyOutDir: false,
    // Assets land flat beside index.html so /survey-assets/<file> resolves
    // directly, with no nested directory to mount separately.
    assetsDir: ".",
    // Public forms get filled in on old phones in waiting rooms.
    target: "es2019",
    sourcemap: false,
  },
});
