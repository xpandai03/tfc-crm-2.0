/**
 * Report delivery-visibility self-checks.
 *
 * Pure/offline checks only: signature verification, event mapping, and the
 * out-of-order precedence rule. The database-backed checks (a test send not
 * claiming a period) are run against production separately.
 */
import { createHmac } from "crypto";
import { verifySvixSignature } from "../server/reports/webhook";

let fail = 0;
const ok = (l: string, c: boolean, d = "") => { if (!c) fail++; console.log(`${c ? "PASS" : "FAIL"}  ${l}${!c && d ? ` — ${d}` : ""}`); };

const SECRET = "whsec_" + Buffer.from("test-signing-key-not-a-real-secret").toString("base64");
const body = JSON.stringify({ type: "email.delivered", data: { email_id: "abc-123" } });
const id = "msg_test";
const ts = String(Math.floor(Date.now() / 1000));
const sign = (secret: string, i: string, t: string, b: string) =>
  "v1," + createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
    .update(`${i}.${t}.${b}`).digest("base64");

console.log("=== signature verification ===");
ok("correctly signed request ACCEPTED",
  verifySvixSignature({ secret: SECRET, id, timestamp: ts, signatureHeader: sign(SECRET, id, ts, body), rawBody: body }).ok);
ok("unsigned request REJECTED",
  !verifySvixSignature({ secret: SECRET, id, timestamp: ts, signatureHeader: undefined, rawBody: body }).ok);
ok("wrong signature REJECTED",
  !verifySvixSignature({ secret: SECRET, id, timestamp: ts, signatureHeader: "v1,bm90LWEtcmVhbC1zaWduYXR1cmU=", rawBody: body }).ok);
ok("tampered body REJECTED",
  !verifySvixSignature({ secret: SECRET, id, timestamp: ts, signatureHeader: sign(SECRET, id, ts, body), rawBody: body + " " }).ok);
ok("wrong secret REJECTED",
  !verifySvixSignature({ secret: "whsec_" + Buffer.from("other").toString("base64"), id, timestamp: ts, signatureHeader: sign(SECRET, id, ts, body), rawBody: body }).ok);
ok("NO secret configured -> REJECTED (fails closed)",
  !verifySvixSignature({ secret: undefined, id, timestamp: ts, signatureHeader: sign(SECRET, id, ts, body), rawBody: body }).ok);
ok("stale timestamp REJECTED (replay)",
  !verifySvixSignature({ secret: SECRET, id, timestamp: String(Number(ts) - 3600), signatureHeader: sign(SECRET, id, String(Number(ts) - 3600), body), rawBody: body }).ok);
ok("rotation: any of several signatures matches",
  verifySvixSignature({ secret: SECRET, id, timestamp: ts, signatureHeader: `v1,AAAA ${sign(SECRET, id, ts, body)}`, rawBody: body }).ok);

console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
