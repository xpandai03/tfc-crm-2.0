/**
 * Canonical provider-name normalization for the roster↔override/suppression join.
 *
 * Extracted verbatim from the inline helper that lived in the GET /api/providers
 * availability merge (server/routes.ts) so the SAME normalization is shared by:
 *   - the override lookup (roster provider → provider_overrides row)
 *   - the suppression filter
 *   - the accepting-count assignment match
 *
 * Behavior: take the text before the first comma (drops a ", Credential" suffix),
 * trim, lowercase, and collapse internal whitespace. This is intentionally a
 * SUPERSET of exact string equality — two names that were exactly equal stay
 * equal after normalization, so callers that match exact-first then fall back to
 * normalized are strictly backward-compatible.
 */
export function normalizeProviderName(n: string): string {
  return (n || "").split(",")[0].trim().toLowerCase().replace(/\s+/g, " ");
}
