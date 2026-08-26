/**
 * Monthly report orchestration: build → render → guard → send → record.
 *
 * RECIPIENTS ARE LANE ONLY, hardcoded.
 *
 * Not an oversight and not a placeholder: the client was explicit that every
 * send goes to Lane until the content is approved, so that nothing half-finished
 * reaches the CEO. Adding a recipient is a deliberate one-line edit plus a
 * deploy, made once Lane signs off — not a config toggle someone flips by
 * accident. The cadence/recipient control panel is next week's work.
 */

import {
  buildMonthlyReport, previousPeriod, resolvePeriod, type MonthlyReport,
} from "./monthly";
import {
  renderMonthlyReportHtml, renderMonthlyReportSubject,
  renderMonthlyReportXlsx, monthlyReportFilename,
} from "./render";
import { sendReportEmail } from "../email/service";
import {
  reportKey, claimReportSend, releaseReportClaim, recordManualSend, wasReportSent,
  type SendTrigger,
} from "./db";

/** THE recipient list. See the module header before changing this. */
export const MONTHLY_REPORT_RECIPIENTS = [
  "lsego@tfc.health", // Lane — sole recipient until content is approved
];

export const MONTHLY_REPORT_KIND = "monthly";

export interface SendOutcome {
  ok: boolean;
  skipped?: "already-sent";
  period: string;
  recipients: string[];
  emailId?: string;
  error?: string;
  alreadySentAt?: string;
}

/** Build + render without sending. Used by the preview endpoint. */
export async function previewMonthlyReport(period: string): Promise<{
  report: MonthlyReport; subject: string; html: string;
}> {
  const report = await buildMonthlyReport(period);
  return {
    report,
    subject: renderMonthlyReportSubject(report),
    html: renderMonthlyReportHtml(report),
  };
}

/**
 * Send the report for `period`.
 *
 * trigger="cron"   — honours the duplicate-send guard. Claims the period BEFORE
 *                    sending, so two concurrent senders cannot both win.
 * trigger="manual" — bypasses the guard (an explicit human action) but LOGS
 *                    loudly that it did, and records the send.
 */
export async function sendMonthlyReport(params: {
  period?: string;
  trigger: SendTrigger;
  actor?: string | null;
}): Promise<SendOutcome> {
  const period = params.period ?? previousPeriod();
  resolvePeriod(period); // validates format, throws on junk
  const key = reportKey(MONTHLY_REPORT_KIND, period);
  const recipients = MONTHLY_REPORT_RECIPIENTS;
  const trigger = params.trigger;
  const actor = params.actor ?? null;

  if (trigger === "cron") {
    const claimed = await claimReportSend(key, period, recipients, trigger, actor);
    if (!claimed) {
      const prior = await wasReportSent(key);
      console.log(
        `[monthly-report] SKIP ${period} — already sent at ${prior?.sentAt ?? "unknown"} ` +
        `via ${prior?.trigger ?? "unknown"}. Duplicate-send guard held.`,
      );
      return {
        ok: true, skipped: "already-sent", period, recipients,
        alreadySentAt: prior?.sentAt,
      };
    }
  } else {
    const prior = await wasReportSent(key);
    if (prior) {
      console.warn(
        `[monthly-report] MANUAL SEND BYPASSING GUARD — ${period} was already sent at ` +
        `${prior.sentAt} via ${prior.trigger}. Re-sending at the explicit request of ${actor ?? "unknown"}.`,
      );
    }
  }

  try {
    const report = await buildMonthlyReport(period);
    const html = renderMonthlyReportHtml(report);
    const subject = renderMonthlyReportSubject(report);
    const xlsx = renderMonthlyReportXlsx(report);

    console.log(
      `[monthly-report] ${period}: cohort=${report.cohort.size} ` +
      `(active=${report.cohort.nowActive} closed=${report.cohort.nowInactive}) ` +
      `snapshot active=${report.snapshot.totals.active} pipeline=${report.snapshot.totals.pipeline}`,
    );

    const result = await sendReportEmail({
      to: recipients,
      subject,
      html,
      attachments: [{ filename: monthlyReportFilename(report), content: xlsx }],
    });

    if (!result.success) {
      // Release the claim so the next cron tick can retry a transient failure.
      if (trigger === "cron") await releaseReportClaim(key);
      console.error(`[monthly-report] SEND FAILED for ${period}: ${result.error}`);
      return { ok: false, period, recipients, error: result.error };
    }

    if (trigger === "manual") await recordManualSend(key, period, recipients, actor);

    console.log(`[monthly-report] SENT ${period} to ${recipients.join(", ")} (${trigger})`);
    return { ok: true, period, recipients, emailId: result.emailId };
  } catch (error) {
    if (trigger === "cron") await releaseReportClaim(key);
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[monthly-report] BUILD/SEND ERROR for ${period}: ${message}`);
    return { ok: false, period, recipients, error: message };
  }
}
