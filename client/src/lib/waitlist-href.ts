/**
 * THE waitlist drill-down URL builder.
 *
 * Promoted out of insights.tsx, where it lived as a module-private function, so
 * the dashboard's click-through uses the same builder rather than a second one
 * that would drift from it. The waitlist reads exactly these six params
 * (client/src/pages/waitlist.tsx:118-124); anything else is silently ignored,
 * which is why the shape is closed rather than a free-form record.
 */

export interface WaitlistFilterParams {
  insurance?: string | null;
  /** The waitlist's location axis: a canonical modality P1 bucket. */
  modality?: string | null;
  reason?: string | null;
  serviceType?: string | null;
  umbrella?: string | null;
  /** Comma-joined status codes. */
  status?: string | null;
}

/** Build a `/waitlist?...` href. Empty and null values are dropped. */
export function buildWaitlistHref(filters: WaitlistFilterParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.trim() !== "") params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/waitlist?${qs}` : "/waitlist";
}

/**
 * The Insights-page signature, preserved verbatim so its call sites are
 * unchanged. A thin wrapper over buildWaitlistHref.
 */
export function buildInsightWaitlistHref(
  filterType: "insurance" | "modality" | "reason" | "serviceType",
  value: string,
  statusList: string,
): string {
  return buildWaitlistHref({ [filterType]: value, status: statusList });
}
