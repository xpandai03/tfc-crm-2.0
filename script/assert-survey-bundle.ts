/**
 * Build gate for the public survey bundle.
 * ============================================================================
 *
 * The survey is the first unauthenticated surface in this app. The single
 * regression that would actually matter is the survey bundle acquiring an
 * import that drags in shared/access-control.ts, whose RESTRICTED_EMAILS and
 * TN_V2_BETA_EMAILS lists are hardcoded staff addresses. That is not a
 * hypothetical: it is exactly why client/public/roadmap.html was built as a
 * standalone file instead of a route in the SPA.
 *
 * A source-level lint would not be enough. Bundlers inline transitive imports,
 * so the only honest check is against the EMITTED JavaScript. This reads every
 * file the survey build produced and fails the build if it finds a staff
 * address — either one of the literals from access-control.ts, or any address
 * on the internal domains — or a marker string that only the CRM app contains.
 *
 * Run automatically as the last step of `npm run build` (script/build.ts) and
 * available on its own as `npm run check:survey-bundle`.
 *
 * IMPORTANT: the address list is SCRAPED from shared/access-control.ts as text
 * at build time rather than copied here or imported from it. Scraping rather
 * than importing matters for two reasons: several of that file's lists —
 * RESTRICTED_EMAILS among them — are module-private and not exported at all, and
 * a staff member added to any list there is covered by this check automatically,
 * with no second list to keep in step.
 */

import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const SURVEY_DIR = path.resolve(process.cwd(), "dist", "public", "survey-app");
const ACCESS_CONTROL = path.resolve(process.cwd(), "shared", "access-control.ts");

/** Internal domains. Any address on one of these has no business being public. */
const STAFF_DOMAINS = ["tfc.health", "tfc.help", "thefamilyconnection.org"];

/**
 * Strings that only exist in the CRM application bundle. If one of these turns
 * up in the survey output, the two bundles have been wired together even if no
 * address leaked yet.
 */
const CRM_ONLY_MARKERS = [
  "RESTRICTED_EMAILS",
  "TN_V2_BETA_EMAILS",
  "isRestrictedUser",
  "canAccessDashboard",
];

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
}

export async function assertSurveyBundleClean(): Promise<void> {
  if (!existsSync(SURVEY_DIR)) {
    throw new Error(
      `[survey-bundle] ${SURVEY_DIR} does not exist — the survey build did not run.`,
    );
  }

  const files = (await filesUnder(SURVEY_DIR)).filter((f) =>
    /\.(js|mjs|cjs|css|html|map)$/i.test(f),
  );

  if (files.length === 0) {
    throw new Error("[survey-bundle] No emitted files found to check.");
  }

  // Every address literal in access-control.ts, exported or not.
  const accessControlSource = await readFile(ACCESS_CONTROL, "utf-8");
  const knownAddresses = Array.from(
    new Set(
      (accessControlSource.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map(
        (e) => e.toLowerCase(),
      ),
    ),
  );

  if (knownAddresses.length === 0) {
    // The scrape returning nothing means the file moved or its shape changed.
    // Fail loudly: a check that silently stopped checking is worse than none.
    throw new Error(
      `[survey-bundle] Found no addresses in ${path.relative(process.cwd(), ACCESS_CONTROL)} — ` +
        "the scrape is broken, so this gate is not actually checking anything.",
    );
  }

  // Any address on an internal domain, whether or not it is on a known list.
  const domainPattern = new RegExp(
    `[a-z0-9._%+-]+@(${STAFF_DOMAINS.map((d) => d.replace(/\./g, "\\.")).join("|")})`,
    "gi",
  );

  const failures: string[] = [];

  for (const file of files) {
    const contents = (await readFile(file, "utf-8")).toLowerCase();
    const rel = path.relative(process.cwd(), file);

    for (const address of knownAddresses) {
      if (contents.includes(address)) {
        // Report the file and the DOMAIN, never the full address — this output
        // goes to CI logs.
        failures.push(`${rel}: contains a known staff address (@${address.split("@")[1]})`);
      }
    }

    const domainHits = contents.match(domainPattern);
    if (domainHits) {
      const domains = Array.from(new Set(domainHits.map((h) => h.split("@")[1])));
      failures.push(
        `${rel}: contains ${domainHits.length} internal-domain address(es) (@${domains.join(", @")})`,
      );
    }

    for (const marker of CRM_ONLY_MARKERS) {
      if (contents.includes(marker.toLowerCase())) {
        failures.push(`${rel}: contains CRM-only symbol "${marker}"`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      "[survey-bundle] PUBLIC BUNDLE CONTAINS STAFF DATA — build refused.\n" +
        failures.map((f) => `  - ${f}`).join("\n") +
        "\n\nThe survey bundle must not import from shared/access-control.ts or " +
        "client/src/. See client-survey/src/main.tsx.",
    );
  }

  console.log(
    `[survey-bundle] OK — ${files.length} emitted file(s) checked, no staff data found.`,
  );
}

// Allow `tsx script/assert-survey-bundle.ts` as a standalone check.
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("assert-survey-bundle.ts");
if (invokedDirectly) {
  assertSurveyBundleClean().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
