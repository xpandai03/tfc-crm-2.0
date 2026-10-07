/**
 * Drains the notifications queue to the Power Automate webhook.
 *
 * One POST per row: {"recipient": "<email>", "text": "<message>"}. The flow
 * answers 202 Accepted; any 2xx is taken as delivered (a 200 means the same
 * thing, and retrying it would send the person the message twice). Anything
 * else — a non-2xx, a timeout, a network error — is retried with backoff,
 * 3 retries after the first try, then the row is marked failed.
 *
 * Never on a user's request path: emit enqueues and kicks this; the interval
 * picks up retries. The error column holds the HTTP status and a short reason,
 * never the response body (it could echo the message back).
 */
import {
  MAX_ATTEMPTS,
  claimDueNotifications,
  markNotificationFailed,
  markNotificationRetry,
  markNotificationSent,
  type NotificationRow,
} from "./db";

/** Delay before retry n (n = attempts made so far): 30s, 2m, 8m. */
export function retryDelayMs(attemptsMade: number): number {
  return 30_000 * Math.pow(4, Math.max(0, attemptsMade - 1));
}

export function notificationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.NOTIFICATIONS_ENABLED ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(v);
}

export function teamsNotifyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.TEAMS_NOTIFY_URL ?? "").trim();
  return v ? v : null;
}

export interface DeliveryStore {
  claimDue(limit: number): Promise<NotificationRow[]>;
  markSent(id: number, attempts: number, httpStatus: number): Promise<void>;
  markRetry(id: number, attempts: number, delayMs: number, httpStatus: number | null, error: string): Promise<void>;
  markFailed(id: number, attempts: number, httpStatus: number | null, error: string): Promise<void>;
}

export const pgDeliveryStore: DeliveryStore = {
  claimDue: claimDueNotifications,
  markSent: markNotificationSent,
  markRetry: markNotificationRetry,
  markFailed: markNotificationFailed,
};

export interface DrainDeps {
  store: DeliveryStore;
  fetchFn: typeof fetch;
  url: string | null;
  enabled: boolean;
  timeoutMs?: number;
}

export interface DeliveryOutcome {
  id: number;
  result: "sent" | "retry" | "failed";
  httpStatus: number | null;
}

async function postOnce(
  deps: DrainDeps, url: string, row: NotificationRow,
): Promise<{ ok: boolean; httpStatus: number | null; error: string }> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // Abort the request AND stop waiting: a fetch that ignores its signal must not wedge the worker.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const e = new Error("timeout");
      e.name = "AbortError";
      reject(e);
    }, deps.timeoutMs ?? 10_000);
  });
  try {
    const res = await Promise.race([
      deps.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: row.recipient, text: row.text }),
        signal: controller.signal,
      }),
      timeout,
    ]);
    // Drain the body so the socket is released; its content is not stored.
    await res.text().catch(() => "");
    if (res.status >= 200 && res.status < 300) return { ok: true, httpStatus: res.status, error: "" };
    return { ok: false, httpStatus: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    const reason = name === "AbortError" ? "timeout" : (e instanceof Error ? e.message : "network error");
    return { ok: false, httpStatus: null, error: reason.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/** One pass: claim what is due, POST each, record the outcome. */
export async function drainOnce(deps: DrainDeps, batch = 20): Promise<DeliveryOutcome[]> {
  if (!deps.enabled) return [];
  const rows = await deps.store.claimDue(batch);
  const out: DeliveryOutcome[] = [];
  for (const row of rows) {
    const attempts = row.attempts + 1;
    if (!deps.url) {
      await deps.store.markFailed(row.id, attempts, null, "TEAMS_NOTIFY_URL unset");
      out.push({ id: row.id, result: "failed", httpStatus: null });
      continue;
    }
    const r = await postOnce(deps, deps.url, row);
    if (r.ok) {
      await deps.store.markSent(row.id, attempts, r.httpStatus!);
      out.push({ id: row.id, result: "sent", httpStatus: r.httpStatus });
    } else if (attempts >= MAX_ATTEMPTS) {
      await deps.store.markFailed(row.id, attempts, r.httpStatus, r.error);
      console.error(`[notify] delivery FAILED id=${row.id} attempts=${attempts} ${r.error}`);
      out.push({ id: row.id, result: "failed", httpStatus: r.httpStatus });
    } else {
      await deps.store.markRetry(row.id, attempts, retryDelayMs(attempts), r.httpStatus, r.error);
      console.warn(`[notify] delivery retry id=${row.id} attempt=${attempts} ${r.error}`);
      out.push({ id: row.id, result: "retry", httpStatus: r.httpStatus });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Process-wide runner
// ---------------------------------------------------------------------------

let draining: Promise<DeliveryOutcome[]> | null = null;
let again = false;

function liveDeps(): DrainDeps {
  return { store: pgDeliveryStore, fetchFn: fetch, url: teamsNotifyUrl(), enabled: notificationsEnabled() };
}

/**
 * Drain now. Calls that arrive mid-drain are folded into one follow-up pass, so
 * a burst of events never runs two drains at once.
 */
export function kickNotificationWorker(): Promise<DeliveryOutcome[]> {
  if (draining) {
    again = true;
    return draining;
  }
  draining = (async () => {
    const all: DeliveryOutcome[] = [];
    try {
      do {
        again = false;
        all.push(...(await drainOnce(liveDeps())));
      } while (again);
    } catch (e) {
      console.error(`[notify] drain error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      draining = null;
    }
    return all;
  })();
  return draining;
}

let interval: NodeJS.Timeout | null = null;

export function startNotificationWorker(everyMs = 15_000): void {
  if (interval) return;
  console.log(
    `[notify] worker started: every ${everyMs / 1000}s, enabled=${notificationsEnabled()}, ` +
      `webhook=${teamsNotifyUrl() ? "set" : "UNSET (messages will be dropped)"}`,
  );
  interval = setInterval(() => { void kickNotificationWorker(); }, everyMs);
  interval.unref?.();
}
