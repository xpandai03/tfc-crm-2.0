/**
 * One-off: send surveys with an impossible year of birth to review.
 * See server/survey/dob-review.ts for the rule and what it never touches.
 *
 * Dry run by default. --apply writes the review rows.
 *   npx tsx scripts/route-implausible-dob-to-review.ts [--apply]
 *
 * Prints submission ids and years only.
 */

import { routeImplausibleDobsToReview } from "../server/survey/dob-review";
import { getPool } from "../server/db/pool";

const apply = process.argv.includes("--apply");

routeImplausibleDobsToReview({ dryRun: !apply })
  .then(async (decisions) => {
    const n = (a: string) => decisions.filter((d) => d.action === a).length;
    console.log(`[survey-dob] ${apply ? "APPLIED" : "DRY RUN"}: ${decisions.length} implausible; ` +
      `route=${n("route")} already-routed=${n("already-routed")} report-only=${n("report-only")}`);
    await getPool().end();
  })
  .catch((e) => { console.error("[survey-dob] failed:", e.message); process.exit(1); });
