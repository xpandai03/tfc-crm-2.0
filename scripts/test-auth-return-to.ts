/**
 * Sign-in returns to the page that was asked for (2026-10-15).
 *
 * Run: npx tsx scripts/test-auth-return-to.ts
 *
 * [1] the allow-list: contact and submission pages only, same-origin, no open redirect
 * [2] end to end through the REAL /auth/login and /auth/callback (configureAuth),
 *     with Microsoft replaced by a stand-in strategy that signs in at once:
 *     logged out -> login -> callback -> back on the page; logged in -> straight there;
 *     hostile returnTo values -> home. No network, no database.
 */
import express from "express";
import passport from "passport";
import type { AddressInfo } from "net";
import { loginUrlFor, safeReturnPath } from "../shared/safe-return-path";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

async function main() {
  console.log("\n[1] The allow-list");
  for (const p of ["/contact/900713", "/submissions", "/submissions?submission=467"]) eq(`allowed ${p}`, safeReturnPath(p), p);
  for (const p of [
    "/", "/providers", "/contact/abc", "/contact/12/notes", "/contact/12?x=1", "/submissions?submission=1&x=2",
    "//evil.example", "/\\evil.example", "https://evil.example/contact/1", "http:/contact/1", "javascript:alert(1)",
    "/contact/1/../../x", "%2F%2Fevil.example", "/contact/1%0d%0aSet-Cookie:x", " /contact/1x", "", null, undefined, 42,
    "/contact/" + "9".repeat(20),
  ]) eq(`refused ${JSON.stringify(p)}`, safeReturnPath(p), null);
  eq("loginUrlFor a contact", loginUrlFor("/contact/9"), "/auth/login?returnTo=%2Fcontact%2F9");
  eq("loginUrlFor a submission", loginUrlFor("/submissions?submission=7"), "/auth/login?returnTo=%2Fsubmissions%3Fsubmission%3D7");
  eq("loginUrlFor anything else", loginUrlFor("//evil.example"), "/auth/login");

  console.log("\n[2] End to end: the real login and callback routes");
  process.env.AZURE_AD_CLIENT_ID = "zztest-client";
  process.env.AZURE_AD_CLIENT_SECRET = "zztest-secret";
  process.env.AZURE_AD_TENANT_ID = "zztest-tenant";
  process.env.SESSION_SECRET = "zztest-session-secret";
  (process.env as Record<string, string>).NODE_ENV = "test";
  const { configureAuth, authMiddleware } = await import("../server/auth");

  const app = express();
  configureAuth(app);
  // Stand-in for Microsoft: /auth/login "goes to Microsoft" and comes straight
  // back to the callback; the callback "returns" a user.
  class FakeAzure extends (passport.Strategy as any) {
    name = "azure-ad";
    authenticate(req: express.Request) {
      if (req.path === "/auth/login") return (this as any).redirect("/auth/callback?code=zz");
      return (this as any).success({ id: "zz", email: "zz@tfc.health", name: "Zz Staff", tenant: "zz" });
    }
  }
  passport.use("azure-ad", new FakeAzure() as any);
  app.use(authMiddleware);
  app.get("/api/me", (req, res) => res.json({ email: (req.user as any)?.email ?? null }));
  app.get("*", (req, res) => res.send(`page ${req.originalUrl}`));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A tiny browser: manual redirects, one cookie jar.
  const visit = async (path: string, jar: { cookie?: string }) => {
    const hops: string[] = [];
    let url = path;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(base + url, { redirect: "manual", headers: jar.cookie ? { cookie: jar.cookie } : {} });
      const set = r.headers.get("set-cookie");
      if (set) jar.cookie = set.split(";")[0];
      if (r.status >= 300 && r.status < 400) {
        url = r.headers.get("location")!;
        if (/^https?:/.test(url)) { hops.push(url); return { hops, final: url, body: "" }; } // left the site
        hops.push(url);
        continue;
      }
      return { hops, final: url, body: await r.text(), status: r.status };
    }
    return { hops, final: url, body: "" };
  };

  let jar: { cookie?: string } = {};
  let v = await visit("/contact/900713", jar);
  eq("logged out, contact link: login -> callback -> the contact",
    v.hops, ["/auth/login?returnTo=%2Fcontact%2F900713", "/auth/callback?code=zz", "/contact/900713"]);
  eq("…and the contact page is served", v.body, "page /contact/900713");
  v = await visit("/contact/900714", jar);
  eq("logged in: a contact link opens directly", [v.hops, v.body], [[], "page /contact/900714"]);

  jar = {};
  v = await visit("/submissions?submission=467", jar);
  eq("logged out, submission link: back on that submission",
    v.hops.slice(-1).concat(v.body), ["/submissions?submission=467", "page /submissions?submission=467"]);

  jar = {};
  v = await visit("/providers", jar);
  eq("logged out, another page: home after sign-in (not allow-listed)", v.hops, ["/auth/login", "/auth/callback?code=zz", "/"]);

  for (const hostile of ["https://evil.example/contact/1", "//evil.example", "/\\evil.example", "/contact/1x"]) {
    jar = {};
    v = await visit(`/auth/login?returnTo=${encodeURIComponent(hostile)}`, jar);
    eq(`hostile returnTo ${JSON.stringify(hostile)} -> home, never off-site`, v.hops, ["/auth/callback?code=zz", "/"]);
  }

  jar = {};
  v = await visit("/auth/login?returnTo=%2Fcontact%2F5", jar);
  ok("the stored path is used once", v.hops[v.hops.length - 1] === "/contact/5");
  v = await visit("/auth/login", jar);
  eq("…a later plain sign-in goes home", v.hops.slice(-1), ["/"]);

  const api = await fetch(base + "/api/contacts", { redirect: "manual" });
  eq("an API call logged out is still a 401, not a redirect", api.status, 401);

  server.close();
  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
