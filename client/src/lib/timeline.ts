/**
 * Timeline Module
 *
 * Builds timeline events from contact data for the Contact Detail page.
 * Events include notes, milestones, and (future) status changes.
 *
 * DEFENSIVE: All functions are fail-soft and handle malformed data gracefully.
 */

export interface TimelineEvent {
  id: string;
  type: "note" | "status_change" | "milestone" | "system";
  timestamp: string; // ISO date or datetime string

  // Content fields
  content?: string;
  author?: string;

  // Status change specific
  fromStatus?: string;
  toStatus?: string;

  // Milestone specific
  milestoneType?: "added" | "scheduled" | "closed" | "insurance_rejected";

  // Metadata
  source?: "live" | "mock" | "derived";
}

interface ContactSnapshot {
  name?: string;
  status?: string;
  serviceRequested?: string;
  daysOnWaitlist?: number;
  dateAdded?: string | number | null;
  lastContact?: string | null;
  assignedTo?: string | null;
  notes?: Array<{ date?: string; content?: string; author?: string }> | null;
  lastNote?: string; // n8n sometimes returns this instead of notes array
  _source?: "live" | "mock";
}

// Excel epoch is Dec 30, 1899
const EXCEL_EPOCH = new Date(1899, 11, 30).getTime();
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Check if a value looks like an Excel serial date number.
 * Excel dates are typically 5-digit numbers (e.g., 45678 = ~2025)
 */
function isExcelSerialDate(value: unknown): value is number {
  if (typeof value !== "number" && typeof value !== "string") return false;
  const num = typeof value === "string" ? parseFloat(value) : value;
  // Excel dates for 2000-2100 range from ~36526 to ~73415
  return !isNaN(num) && num > 30000 && num < 80000 && Number.isInteger(num);
}

/**
 * Convert Excel serial date to JavaScript Date.
 */
function excelSerialToDate(serial: number): Date {
  return new Date(EXCEL_EPOCH + serial * MS_PER_DAY);
}

/**
 * Safely convert any date-like value to a valid timestamp string.
 * Returns null if the value cannot be parsed.
 */
function safeParseDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  try {
    // Handle Excel serial numbers
    if (isExcelSerialDate(value)) {
      const date = excelSerialToDate(typeof value === "string" ? parseFloat(value) : value);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split("T")[0];
      }
      return null;
    }

    // Handle string dates
    if (typeof value === "string") {
      // Try parsing as-is
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        // Return ISO date string for consistency
        return date.toISOString().split("T")[0];
      }

      // Try MM/DD/YY format
      const mmddyy = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (mmddyy) {
        const [, month, day, year] = mmddyy;
        const fullYear = year.length === 2 ? (parseInt(year) > 50 ? 1900 + parseInt(year) : 2000 + parseInt(year)) : parseInt(year);
        const parsed = new Date(fullYear, parseInt(month) - 1, parseInt(day));
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString().split("T")[0];
        }
      }
    }

    // Handle number (Unix timestamp in seconds or milliseconds)
    if (typeof value === "number") {
      // If it's a reasonable Unix timestamp in seconds (1970-2100)
      if (value > 0 && value < 4102444800) {
        const date = new Date(value * 1000);
        if (!isNaN(date.getTime())) {
          return date.toISOString().split("T")[0];
        }
      }
      // If it's a reasonable Unix timestamp in milliseconds
      if (value > 1000000000000 && value < 4102444800000) {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          return date.toISOString().split("T")[0];
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Generate a stable unique key for an event.
 */
function generateEventKey(type: string, index: number, timestamp: string | null): string {
  const ts = timestamp || "unknown";
  const uniqueSuffix = Math.random().toString(36).substring(2, 8);
  return `${type}-${index}-${ts}-${uniqueSuffix}`;
}

/**
 * Safely truncate content to prevent memory issues.
 */
function safeContent(content: unknown, maxLength = 10000): string {
  if (content === null || content === undefined) return "";
  const str = String(content);
  if (str.length > maxLength) {
    return str.substring(0, maxLength) + "...";
  }
  return str;
}

/**
 * Build timeline events from a contact snapshot.
 * Returns events sorted by timestamp (most recent first).
 *
 * FAIL-SOFT: Always returns an array, never throws.
 */
export function buildTimelineEvents(
  snapshot: ContactSnapshot | null | undefined
): TimelineEvent[] {
  // Guard: null/undefined snapshot
  if (!snapshot || typeof snapshot !== "object") {
    console.warn("[timeline] buildTimelineEvents received invalid snapshot:", typeof snapshot);
    return [];
  }

  const events: TimelineEvent[] = [];
  const source = snapshot._source || "mock";

  // Process notes array
  try {
    if (snapshot.notes && Array.isArray(snapshot.notes)) {
      snapshot.notes.forEach((note, idx) => {
        // Guard: each note must be an object
        if (!note || typeof note !== "object") {
          console.warn(`[timeline] Skipping invalid note at index ${idx}:`, note);
          return;
        }

        const parsedDate = safeParseDate(note.date);
        const content = safeContent(note.content);

        // Only add if we have content (date is optional, will show "Unknown date")
        if (content) {
          events.push({
            id: generateEventKey("note", idx, parsedDate),
            type: "note",
            timestamp: parsedDate || "",
            content,
            author: note.author, // Pass through author initials from parsed note (Phase 6)
            source,
          });
        }
      });
    }
  } catch (e) {
    console.error("[timeline] Error processing notes array:", e);
  }

  // Process lastNote if present and notes array is empty
  try {
    if (events.length === 0 && snapshot.lastNote && typeof snapshot.lastNote === "string") {
      const content = safeContent(snapshot.lastNote);
      if (content) {
        events.push({
          id: generateEventKey("note", 0, null),
          type: "note",
          timestamp: "",
          content,
          source,
        });
      }
    }
  } catch (e) {
    console.error("[timeline] Error processing lastNote:", e);
  }

  // Add "Added to Waitlist" milestone
  try {
    const parsedDateAdded = safeParseDate(snapshot.dateAdded);
    if (parsedDateAdded) {
      const service = snapshot.serviceRequested ? String(snapshot.serviceRequested) : "";
      events.push({
        id: generateEventKey("milestone", 0, parsedDateAdded),
        type: "milestone",
        timestamp: parsedDateAdded,
        milestoneType: "added",
        content: `Added to waitlist${service ? ` for ${service}` : ""}`,
        source: "derived",
      });
    }
  } catch (e) {
    console.error("[timeline] Error creating milestone event:", e);
  }

  // Sort by timestamp (most recent first)
  try {
    events.sort((a, b) => {
      const dateA = parseTimestamp(a.timestamp);
      const dateB = parseTimestamp(b.timestamp);
      return dateB.getTime() - dateA.getTime();
    });
  } catch (e) {
    console.error("[timeline] Error sorting events:", e);
    // Return unsorted if sort fails
  }

  console.log(`[timeline] Built ${events.length} events for contact:`, snapshot.name);
  return events;
}

/**
 * Parse a timestamp string into a Date object.
 * Handles date-only (YYYY-MM-DD), ISO datetime, and fallback.
 *
 * FAIL-SOFT: Returns epoch date (Jan 1, 1970) for invalid input.
 */
function parseTimestamp(timestamp: string | null | undefined): Date {
  if (!timestamp || typeof timestamp !== "string" || timestamp === "") {
    return new Date(0);
  }

  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      return new Date(0);
    }
    return date;
  } catch {
    return new Date(0);
  }
}

/**
 * Format a timestamp for display.
 * Returns relative time for recent events, date for older ones.
 *
 * FAIL-SOFT: Returns "Unknown date" for invalid input.
 */
export function formatRelativeTime(timestamp: string | null | undefined): string {
  if (!timestamp || typeof timestamp !== "string" || timestamp === "") {
    return "Unknown date";
  }

  try {
    const date = parseTimestamp(timestamp);
    if (date.getTime() === 0) {
      return "Unknown date";
    }

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();

    // Guard against future dates or very old dates
    if (diffMs < 0) {
      return formatFullDate(timestamp);
    }

    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return "Today";
    } else if (diffDays === 1) {
      return "Yesterday";
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
    } else if (diffDays < 365) {
      const months = Math.floor(diffDays / 30);
      return `${months} month${months > 1 ? "s" : ""} ago`;
    } else {
      const years = Math.floor(diffDays / 365);
      return `${years} year${years > 1 ? "s" : ""} ago`;
    }
  } catch {
    return "Unknown date";
  }
}

/**
 * Format a timestamp as a full date string.
 *
 * FAIL-SOFT: Returns "Unknown date" for invalid input.
 */
export function formatFullDate(timestamp: string | null | undefined): string {
  if (!timestamp || typeof timestamp !== "string" || timestamp === "") {
    return "Unknown date";
  }

  try {
    const date = parseTimestamp(timestamp);
    if (date.getTime() === 0) {
      return "Unknown date";
    }

    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "Unknown date";
  }
}

/**
 * Get a date group key for grouping events by day.
 *
 * FAIL-SOFT: Returns "Unknown" for invalid input.
 */
export function getDateGroupKey(timestamp: string | null | undefined): string {
  if (!timestamp || typeof timestamp !== "string" || timestamp === "") {
    return "Unknown";
  }

  try {
    const date = parseTimestamp(timestamp);
    if (date.getTime() === 0) {
      return "Unknown";
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const eventDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (eventDate.getTime() === today.getTime()) {
      return "Today";
    } else if (eventDate.getTime() === yesterday.getTime()) {
      return "Yesterday";
    } else {
      return formatFullDate(timestamp);
    }
  } catch {
    return "Unknown";
  }
}

/**
 * Group timeline events by date.
 * Returns array of [groupKey, events[]] pairs.
 *
 * FAIL-SOFT: Returns empty array for invalid input.
 */
export function groupEventsByDate(
  events: TimelineEvent[] | null | undefined
): Array<[string, TimelineEvent[]]> {
  if (!events || !Array.isArray(events)) {
    console.warn("[timeline] groupEventsByDate received invalid events:", typeof events);
    return [];
  }

  try {
    const groups = new Map<string, TimelineEvent[]>();

    for (const event of events) {
      // Guard: each event must be a valid object
      if (!event || typeof event !== "object") {
        console.warn("[timeline] Skipping invalid event in grouping:", event);
        continue;
      }

      const key = getDateGroupKey(event.timestamp);
      const existing = groups.get(key) || [];
      existing.push(event);
      groups.set(key, existing);
    }

    return Array.from(groups.entries());
  } catch (e) {
    console.error("[timeline] Error grouping events:", e);
    return [];
  }
}
