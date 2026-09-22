/**
 * "Open in TherapyNotes" — the chart, in a new tab.
 * ============================================================================
 *
 * The client's ask, verbatim: "if a client has been matched, it'd be really
 * helpful if from the CRM there was a button to just open up that patient chart
 * in TherapyNotes. We do that from the CRM anyway."
 *
 * WORDING, ICON AND BEHAVIOUR ARE THE CONTACT PAGE'S. That control
 * (pages/contact-detail.tsx, the `tnStatus === "created"` branch) is inline JSX
 * rather than a component, and it opens a STORED url rather than building one,
 * so there was nothing to import. This is the componentised version, matched to
 * it field for field: the same `ExternalLink` icon, the same label, the same
 * `window.open(url, "_blank")`, the same green outline treatment.
 *
 * The contact page is deliberately NOT changed to use this — it is staff's
 * daily path and was explicitly out of scope. When someone does get to it, this
 * is the thing it should import, and then there is one control rather than two
 * that happen to agree.
 *
 * RENDERS NOTHING WITHOUT A CHART ID. Not disabled — absent. A disabled control
 * invites a hover to find out why and then says nothing useful; the client has
 * already made that point about a different button. `title` carries the reason
 * only in the case where a row HAS a match but no chart behind it, which is the
 * one case a staff member would otherwise wonder about.
 */

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tnChartUrl } from "@/lib/tn-chart-url";

export function OpenInTherapyNotesButton({
  chartId,
  testId,
  className,
}: {
  /** The TherapyNotes chart id. Anything falsy renders nothing. */
  chartId: string | null | undefined;
  /** data-testid for the rendered button. */
  testId?: string;
  className?: string;
}) {
  const url = tnChartUrl(chartId);
  if (!url) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      className={
        className ??
        "h-7 text-xs border-green-300 text-green-700 hover:bg-green-50"
      }
      // No <a download> and no router link: TherapyNotes is a separate
      // application and a separate session. New tab, same as the contact page.
      onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
      title={
        "Opens this patient's chart in TherapyNotes in a new tab. You need to " +
        "be signed in to TherapyNotes already — a signed-out tab lands on the " +
        "patients list instead."
      }
      data-testid={testId}
    >
      <ExternalLink className="h-3 w-3 mr-1" />
      Open in TherapyNotes
    </Button>
  );
}
