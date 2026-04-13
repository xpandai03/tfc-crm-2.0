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
  type: "note" | "status_change" | "milestone" | "system" | "email_sent" | "assignment";
  timestamp: string; // ISO date or datetime string

  // Content fields
  content?: string;
  author?: string;

  // Status change specific
  fromStatus?: string;
  toStatus?: string;

  // Milestone specific
  milestoneType?: "added" | "scheduled" | "closed" | "insurance_rejected";

  // Email event specific (v1)
  emailTemplate?: string;
  emailResult?: "sent" | "failed";
  eccStatus?: "present" | "missing";

  // Snapshot download
  snapshotId?: number;

  // Assignment specific (for deletion)
  assignmentId?: number;

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
      // Handle ISO date format (YYYY-MM-DD) - parse as LOCAL date to avoid timezone shifts
      const isoDateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoDateMatch) {
        const [, year, month, day] = isoDateMatch;
        // Parse as local date (not UTC) to avoid timezone conversion issues
        // This ensures "2025-11-25" stays as Nov 25, not Nov 24 in timezones behind UTC
        const parsed = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        if (!isNaN(parsed.getTime())) {
          // Return the original ISO string since we parsed it correctly as local date
          // The date components are what we want, so return as-is
          return value; // Return original ISO string - it's already correct
        }
      }

      // Try parsing as-is (for other formats)
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        // For non-ISO strings, check if it's a date-only value
        // If it looks like a date-only string, parse as local date
        if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(value.trim())) {
          // Already handled by MM/DD/YY pattern below, but fallback here
          return date.toISOString().split("T")[0];
        }
        // Return ISO date string for consistency
        return date.toISOString().split("T")[0];
      }

      // Try MM/DD/YY format
      const mmddyy = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (mmddyy) {
        const [, month, day, year] = mmddyy;
        const fullYear = year.length === 2 ? (parseInt(year) > 50 ? 1900 + parseInt(year) : 2000 + parseInt(year)) : parseInt(year);
        // Parse as local date to avoid timezone shifts
        const parsed = new Date(fullYear, parseInt(month) - 1, parseInt(day));
        if (!isNaN(parsed.getTime())) {
          // Return ISO date string using local date components
          const localYear = parsed.getFullYear();
          const localMonth = String(parsed.getMonth() + 1).padStart(2, '0');
          const localDay = String(parsed.getDate()).padStart(2, '0');
          return `${localYear}-${localMonth}-${localDay}`;
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

// Qualifying email template names → IDs for snapshot matching
const EMAIL_TEMPLATE_NAME_TO_ID: Record<string, string> = {
  "Initial Appointment Confirmation": "appointment-confirmation",
  "Initial Appointment Survey": "post-appointment-survey",
  "Intake Form Reminder": "intake-form-reminder",
};

/** Snapshot metadata shape (from /api/email-snapshots/:contactId) */
export interface EmailSnapshotMeta {
  id: number;
  contactId: number;
  templateId: string;
  subject: string;
  sentByEmail: string;
  sentAt: string;
}

/**
 * Parse an [Email] prefixed note.
 * Returns extracted template name or null if not an email note.
 */
function parseEmailNote(content: string): { templateName: string; templateId: string | null } | null {
  const match = content.match(/^\[Email\]\s*(.+?)\s+sent/);
  if (!match) return null;
  const templateName = match[1];
  const templateId = EMAIL_TEMPLATE_NAME_TO_ID[templateName] ?? null;
  return { templateName, templateId };
}

/**
 * Build timeline events from a contact snapshot.
 * Returns events sorted by timestamp (most recent first).
 *
 * FAIL-SOFT: Always returns an array, never throws.
 */
/** Assignment data shape (from /api/assignments/:contactId) */
export interface AssignmentMeta {
  id: number;
  contactId: number;
  providerName: string;
  credential: string;
  assignmentComment: string | null;
  assignedByInitials: string;
  assignedAt: string;
}

export function buildTimelineEvents(
  snapshot: ContactSnapshot | null | undefined,
  snapshots?: EmailSnapshotMeta[],
  assignments?: AssignmentMeta[],
): TimelineEvent[] {
  // Guard: null/undefined snapshot
  if (!snapshot || typeof snapshot !== "object") {
    console.warn("[timeline] buildTimelineEvents received invalid snapshot:", typeof snapshot);
    return [];
  }

  const events: TimelineEvent[] = [];
  const source = snapshot._source || "mock";
  const claimedSnapshotIds = new Set<number>();

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
          // Detect [Email] prefixed notes and promote to email_sent type
          const emailParsed = parseEmailNote(content);
          if (emailParsed) {
            console.log("[timeline] Email note detected:", {
              templateName: emailParsed.templateName,
              templateId: emailParsed.templateId,
              noteDate: parsedDate,
              snapshotsCount: snapshots?.length ?? 0,
            });
            let matchedSnapshotId: number | undefined;
            if (snapshots && snapshots.length > 0 && parsedDate) {
              const noteTime = new Date(parsedDate).getTime();

              if (emailParsed.templateId) {
                let bestDelta = Infinity;
                for (const snap of snapshots) {
                  if (snap.templateId !== emailParsed.templateId) continue;
                  if (claimedSnapshotIds.has(snap.id)) continue;
                  const delta = Math.abs(new Date(snap.sentAt).getTime() - noteTime);
                  if (delta < bestDelta) {
                    bestDelta = delta;
                    matchedSnapshotId = snap.id;
                  }
                }
              } else {
                const DAY_MS = 24 * 60 * 60 * 1000;
                let bestDelta = Infinity;
                for (const snap of snapshots) {
                  if (claimedSnapshotIds.has(snap.id)) continue;
                  const delta = Math.abs(new Date(snap.sentAt).getTime() - noteTime);
                  if (delta < DAY_MS && delta < bestDelta) {
                    bestDelta = delta;
                    matchedSnapshotId = snap.id;
                  }
                }
              }

              if (matchedSnapshotId != null) {
                claimedSnapshotIds.add(matchedSnapshotId);
              }
            }

            events.push({
              id: generateEventKey("email", idx, parsedDate),
              type: "email_sent",
              timestamp: parsedDate || "",
              content,
              author: note.author,
              emailTemplate: emailParsed.templateName,
              snapshotId: matchedSnapshotId,
              source,
            });
          } else {
            events.push({
              id: generateEventKey("note", idx, parsedDate),
              type: "note",
              timestamp: parsedDate || "",
              content,
              author: note.author,
              source,
            });
          }
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

  // Merge CRM assignment events
  try {
    if (assignments && Array.isArray(assignments)) {
      assignments.forEach((a, idx) => {
        const parsedDate = safeParseDate(a.assignedAt);
        let content = `[Assignment] Provider assigned: ${a.providerName} — ${a.credential}`;
        if (a.assignmentComment) {
          content += `\nReason: ${a.assignmentComment}`;
        }
        events.push({
          id: generateEventKey("assignment", idx, parsedDate),
          type: "assignment",
          timestamp: parsedDate || "",
          content,
          author: a.assignedByInitials,
          assignmentId: a.id,
          source: "derived",
        });
      });
    }
  } catch (e) {
    console.error("[timeline] Error processing assignment events:", e);
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
 * IMPORTANT: ISO date strings (YYYY-MM-DD) are parsed as LOCAL dates to avoid timezone shifts.
 *
 * FAIL-SOFT: Returns epoch date (Jan 1, 1970) for invalid input.
 */
function parseTimestamp(timestamp: string | null | undefined): Date {
  if (!timestamp || typeof timestamp !== "string" || timestamp === "") {
    return new Date(0);
  }

  try {
    // Handle ISO date format (YYYY-MM-DD) - parse as LOCAL date to avoid timezone shifts
    // This prevents "2025-11-25" from showing as "Nov 24" in timezones behind UTC
    const isoDateMatch = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateMatch) {
      const [, year, month, day] = isoDateMatch;
      const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    // For other formats (ISO datetime, etc.), use standard Date parsing
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
