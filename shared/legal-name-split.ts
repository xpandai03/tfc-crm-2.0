/**
 * Split the legal name a client typed on the survey into first and last, for
 * the staff-only export (Data sheet). Casing and spelling are kept as typed.
 *
 * Reads a name the way the matcher's legalNameKey does (server/survey/
 * matching.ts), so the export and the match agree on who "the legal name" is:
 *   "Rosalind Ashgrove"          -> Rosalind | Ashgrove
 *   "Mary Anne Ashgrove"         -> Mary Anne | Ashgrove   (last word = surname)
 *   "Ashgrove, Rosalind"         -> Rosalind | Ashgrove   (comma form)
 *   "Rosie (Rosalind) Ashgrove"  -> Rosalind | Ashgrove   (preferred (legal) last)
 *   "Rosalind Ashgrove (dad)"    -> Rosalind | Ashgrove   (trailing note dropped)
 *   "Rosalind"                   -> Rosalind | ""
 */
export function splitLegalName(raw: string | null | undefined): { first: string; last: string } {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { first: "", last: "" };

  // "Preferred (Legal) Last": a bracketed group FOLLOWED by more name is the
  // legal first name; a group at the end is a note.
  const m = /^(.*?)\(([^()]*)\)\s*(.*)$/.exec(s);
  if (m && m[3].trim() && !m[3].includes("(")) {
    const legalFirst = m[2].trim();
    const rest = m[3].trim();
    if (legalFirst) return splitPlain(`${legalFirst} ${rest}`);
  }
  const noNotes = s.replace(/\s*\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  return splitPlain(noNotes);
}

function splitPlain(s: string): { first: string; last: string } {
  const comma = s.indexOf(",");
  if (comma !== -1) {
    const last = s.slice(0, comma).trim();
    const first = s.slice(comma + 1).trim();
    if (last && first) return { first, last };
    return { first: first || last, last: "" };
  }
  const parts = s.split(" ").filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}
