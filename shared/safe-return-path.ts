/**
 * Where to send a user after Microsoft sign-in (2026-10-15).
 *
 * Teams messages link straight to a contact or a submission. A logged-out
 * click used to land on the home page after sign-in, because the requested
 * path was dropped. Only these pages are honoured, as same-origin relative
 * paths — anything else (another site, "//host", a backslash, an unknown page)
 * is null and the user goes home, so the login route cannot become an open
 * redirect:
 *
 *   /contact/<digits>
 *   /submissions
 *   /submissions?submission=<digits>
 *
 * Pure: shared by the server (login + callback) and the client login screen.
 */
const ALLOWED = [
  /^\/contact\/\d{1,12}$/,
  /^\/submissions$/,
  /^\/submissions\?submission=\d{1,12}$/,
];

export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 64) return null;
  return ALLOWED.some((re) => re.test(s)) ? s : null;
}

/** "/auth/login?returnTo=…" when the path is allowed, else "/auth/login". */
export function loginUrlFor(path: unknown): string {
  const safe = safeReturnPath(path);
  return safe ? `/auth/login?returnTo=${encodeURIComponent(safe)}` : "/auth/login";
}
