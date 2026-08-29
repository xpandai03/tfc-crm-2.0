/**
 * Resend delivery-event webhook.
 *
 * Until this existed, the system's definition of "sent" was "the mail API
 * accepted it". A message quarantined, bounced or dropped after that point was
 * indistinguishable from one that landed — which is why the Aug 25 send could
 * not be traced. This endpoint is what closes that gap.
 *
 * SIGNATURE VERIFICATION
 * ----------------------
 * This is a PUBLIC, unauthenticated URL: anyone can POST to it. Resend signs
 * events with Svix, and verification is implemented here with node's own crypto
 * rather than the `svix` package — one HMAC, no new dependency.
 *
 * It FAILS CLOSED. With no secret configured the endpoint rejects everything,
 * because an endpoint that accepts unsigned events while its secret is missing
 * is worse than one that is simply off: it would let anyone rewrite delivery
 * outcomes.
 *
 * NO PHI. Events carry staff recipient addresses, an event type, and for a
 * bounce a short reason. Nothing else from the body is stored, and the body is
 * never logged.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { applyDeliveryEvent, type DeliveryStatus } from "./send-log";

/** Resend event names → the status we store. */
const EVENT_STATUS: Record<string, DeliveryStatus> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
  "email.clicked": "clicked",
};

/** Tolerate this much clock skew on the signed timestamp, to blunt replays. */
const MAX_SKEW_SECONDS = 5 * 60;

export interface WebhookVerification {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a Svix-signed request.
 *
 * Svix signs `${id}.${timestamp}.${body}` with HMAC-SHA256 using a secret that
 * is base64 after a `whsec_` prefix, and sends one or more space-separated
 * `v1,<base64sig>` values — more than one during a secret rotation, so ANY
 * match is a pass.
 *
 * `rawBody` must be the exact bytes received. A re-serialised object will not
 * match, which is why the route reads the raw body.
 */
export function verifySvixSignature(params: {
  secret: string | undefined;
  id: string | undefined;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  rawBody: string;
  nowSeconds?: number;
}): WebhookVerification {
  const { secret, id, timestamp, signatureHeader, rawBody } = params;

  if (!secret) return { ok: false, reason: "no signing secret configured" };
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: "missing svix headers" };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);

  // A rotation sends several signatures; any one matching is a pass.
  for (const part of signatureHeader.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig);
    if (given.length === expectedBuf.length && timingSafeEqual(given, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature mismatch" };
}

export interface HandledEvent {
  matched: number;
  status: DeliveryStatus | null;
  messageId: string | null;
}

/**
 * Apply one verified event.
 *
 * An event for a message id this system never sent updates nothing and is NOT
 * an error — Resend delivers events for every message on the account, including
 * client-facing template emails that are not report sends.
 */
export async function handleDeliveryEvent(body: unknown): Promise<HandledEvent> {
  const evt = body as {
    type?: string;
    created_at?: string;
    data?: { email_id?: string; bounce?: { message?: string }; reason?: string };
  };

  const status = evt.type ? EVENT_STATUS[evt.type] : undefined;
  const messageId = evt.data?.email_id ?? null;
  if (!status || !messageId) {
    return { matched: 0, status: null, messageId };
  }

  // Keep only a short reason string. Never the event body.
  const rawDetail = evt.data?.bounce?.message ?? evt.data?.reason ?? null;
  const detail = rawDetail ? String(rawDetail).slice(0, 300) : null;

  const matched = await applyDeliveryEvent({
    messageId, status, detail, occurredAt: evt.created_at ?? null,
  });
  return { matched, status, messageId };
}
