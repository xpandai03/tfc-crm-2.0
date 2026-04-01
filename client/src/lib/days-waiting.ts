/**
 * Compute "Days Waiting" dynamically from dateAdded.
 *
 * Production behavior: Days Waiting = TODAY() - date_added
 * This replaces the static daysOnWaitlist snapshot imported from Excel.
 *
 * Falls back to the static daysOnWaitlist value when dateAdded is missing/invalid.
 */
export function computeDaysWaiting(
  dateAdded: string | null | undefined,
  fallback?: number | null
): number {
  if (dateAdded) {
    // Handle both YYYY-MM-DD and MM/DD/YYYY formats
    let added: Date;
    const isoMatch = dateAdded.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const usMatch = dateAdded.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);

    if (isoMatch) {
      added = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    } else if (usMatch) {
      added = new Date(Number(usMatch[3]), Number(usMatch[1]) - 1, Number(usMatch[2]));
    } else {
      return fallback ?? 0;
    }

    if (isNaN(added.getTime())) return fallback ?? 0;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const addedDay = new Date(added.getFullYear(), added.getMonth(), added.getDate());

    const diffMs = today.getTime() - addedDay.getTime();
    if (diffMs < 0) return 0; // future date
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }

  return fallback ?? 0;
}
