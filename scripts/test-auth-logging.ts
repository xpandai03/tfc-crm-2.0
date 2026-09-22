/**
 * Self-checks — the [AUTH] log lines carry no credential, and cannot throw.
 *
 * Run: npx tsx scripts/test-auth-logging.ts
 *
 * No database, no network, no browser. Every value below is invented.
 *
 * WHY THIS FILE EXISTS. The auth logging was rewritten to print field names and
 * outcomes instead of values. Two things can go wrong with that kind of change
 * and neither shows up in a type check:
 *
 *   1. a value creeps back in — someone "just needs the session id for one
 *      afternoon" and it is still there a year later
 *   2. a log line throws. The verify callback's logging runs INSIDE the login
 *      path, so a null-dereference in a console.log is a login outage. The
 *      sentinel test against the deployed build cannot reach those lines,
 *      because they only run on a genuine Azure AD response.
 *
 * [2] asserts the source. [3] evaluates the exact expressions the rewritten
 * lines use, against a real-shaped profile, an empty one, and nothing at all.
 */
import { readFileSync } from "fs";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const src = readFileSync("server/auth.ts", "utf8");
// The log statements alone — comments explain what was removed and naming the
// old expression in prose must not fail the scan.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ===========================================================================
console.log("\n[1] The values that used to be logged are gone");
{
  const banned: [string, RegExp][] = [
    ["req.sessionID",                 /console\.[a-z]+\([^)]*req\.sessionID/],
    ["req.headers.cookie as a value", /console\.[a-z]+\([^)]*req\.headers\.cookie(?!\s*\))/],
    ["req.url",                       /console\.[a-z]+\([^)]*req\.url/],
    ["req.query serialised",          /console\.[a-z]+\([^)]*JSON\.stringify\(req\.query/],
    ["the profile object",            /console\.[a-z]+\([^)]*JSON\.stringify\(profile/],
    // The identifier is allowed; the VALUE is not. `!!profile?._json` is a
    // boolean and is the point of the rewrite, so ban only an un-negated use.
    ["the claims object",             /console\.[a-z]+\([^)]*(?<!!!)profile\?\._json/],
    ["the id token",                  /console\.[a-z]+\([^)]*idToken\?\.substring/],
    ["the authorization code",        /console\.[a-z]+\([^)]*req\.query\.code as string/],
    ["the OIDC handshake serialised", /console\.[a-z]+\([^)]*JSON\.stringify\(\(req\.session/],
    ["the extracted user object",     /console\.[a-z]+\([^)]*JSON\.stringify\(user/],
  ];
  for (const [label, re] of banned) check(`no longer logs ${label}`, !re.test(code));

  check("no truncation of any credential",
    !/substring\(0,\s*\d+\)/.test(code) && !/\.slice\(0,\s*\d+\)/.test(code));
  check("no hashing of any credential",
    !/createHash|sha256|md5/i.test(code));
}

// ===========================================================================
console.log("\n[2] What it logs instead — names and outcomes");
{
  for (const [label, re] of [
    ["session presence, not the id",   /Session exists:", !!req\.session/],
    ["cookie presence, not the value", /Session cookie present:", !!req\.headers\.cookie/],
    ["OIDC state presence",            /OIDC state in session:",\s*\n?\s*!!\(req\.session/],
    ["the callback PATH, not the url", /Callback path:", req\.path/],
    ["query KEY NAMES, not values",    /Query params present:", Object\.keys\(req\.query\)/],
    ["code presence only",             /Authorization code received: yes/],
    ["the user's email",               /User logged in successfully:", user\.email/],
    ["token presence only",            /Access Token exists:", !!accessToken/],
  ] as [string, RegExp][]) check(`logs ${label}`, re.test(code));

  check("errors are logged by .message, never as objects",
    (code.match(/instanceof Error \? \w+\.message : "unknown"/g) || []).length >= 5);
  check("the known 'Error: null' line is left alone, as instructed",
    /console\.log\("\[AUTH\]   Error:", err\);/.test(code));
}

// ===========================================================================
console.log("\n[3] No rewritten log line can throw — the login path runs through them");
{
  // The exact expressions the rewritten lines evaluate, applied to the three
  // shapes Azure AD can hand the verify callback.
  const shapes: [string, any, any, any][] = [
    ["a real-shaped response",
      { _json: { oid: "zz-oid", preferred_username: "zz@tfc.health", tid: "zz-tid", name: "Zz Person" },
        id: "zz-id", displayName: "Zz Person", emails: [{ value: "zz@tfc.health" }] },
      "zz.id.token", "zz-access-token"],
    ["a profile with no claims", { id: "zz-id" }, undefined, undefined],
    ["nothing at all", undefined, undefined, undefined],
  ];

  for (const [label, profile, idToken, accessToken] of shapes) {
    let threw: string | null = null;
    try {
      // Mirrors auth.ts lines 151-183, logging suppressed.
      void [!!profile, !!profile?._json];
      void !!idToken;
      void !!accessToken;
      const claims = profile?._json || {};
      const user = {
        id: claims.oid || claims.sub || profile?.id || "",
        email: claims.preferred_username || claims.email || profile?.emails?.[0]?.value || "",
        name: claims.name || profile?.displayName || "",
        tenant: claims.tid || "zz-tenant",
      };
      void (user.email || "(no email)");
      void user.email.split("@")[1]?.toLowerCase();
    } catch (e) {
      threw = e instanceof Error ? e.message : "unknown";
    }
    check(`${label}: no log expression throws`, threw === null, threw ?? "");
  }

  // The callback-route expressions, against a request with and without each field.
  for (const [label, req] of [
    ["a full callback request", { session: { "openidconnect:azure-ad": { state: "zz" } },
      headers: { cookie: "tfc.sid=zz" }, path: "/auth/callback",
      query: { code: "zz", state: "zz" } }],
    ["a bare request", { session: {}, headers: {}, path: "/auth/callback", query: {} }],
  ] as [string, any][]) {
    let threw: string | null = null;
    try {
      void !!req.session;
      void !!req.headers.cookie;
      void !!(req.session as any)["openidconnect:azure-ad"];
      void req.path;
      void (Object.keys(req.query).join(",") || "(none)");
      void (req.query.code ? "yes" : undefined);
      void ((undefined as any)?.email ?? "(none)");
      void ((undefined as any)?.message ?? "none");
    } catch (e) {
      threw = e instanceof Error ? e.message : "unknown";
    }
    check(`${label}: no log expression throws`, threw === null, threw ?? "");
  }
}

// ===========================================================================
console.log("\n[4] Authentication itself is untouched");
{
  check("publicPaths is intact",
    /const publicPaths = \[[\s\S]*?"\/auth\/login",[\s\S]*?"\/api\/internal\/tn-progress\/",[\s\S]*?\];/.test(code));
  check("requireAuth still gates /api/ with a 401",
    /req\.path\.startsWith\("\/api\/"\)[\s\S]{0,140}res\.status\(401\)/.test(code));
  check("requireAuth still redirects pages to the login route",
    /res\.redirect\("\/auth\/login"\);/.test(code));
  check("the allowed-domain list is unchanged",
    /\["tfc\.help", "thefamilyconnection\.org", "tfc\.health"\]/.test(code));
  check("the session cookie is still httpOnly and secure in production",
    /httpOnly: true,\s*\n\s*secure: isProduction,/.test(code));
  // Grouped: the previous form let `|` split the whole pattern, so the second
  // branch matched `if (!clientSecret || !tenantID || !sessionSecret) {` — a
  // control-flow line, not a log line.
  check("no secret is logged",
    !/console\.[a-z]+\([^)]*(clientSecret|sessionSecret|CLIENT_SECRET|SESSION_SECRET)/.test(code));
}

console.log(`\n${"=".repeat(62)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (failures.length) for (const f of failures) console.log(`    - ${f}`);
console.log(`${"=".repeat(62)}\n`);
process.exit(fail ? 1 : 0);
