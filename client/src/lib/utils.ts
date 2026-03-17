import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Normalize and format a DOB value for display.
 * Handles: Excel serial numbers (e.g. 32211), ISO strings (YYYY-MM-DD),
 * US date strings (M/D/YYYY), null/undefined.
 * Always returns MM/DD/YYYY or "---".
 */
export function formatDob(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "---";

  // If numeric (or numeric string), treat as Excel serial
  const num = typeof value === "number" ? value : parseFloat(value);
  if (!isNaN(num) && num > 15000 && num < 80000) {
    const excelEpoch = new Date(1899, 11, 30);
    const d = new Date(excelEpoch.getTime() + num * 86400000);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getFullYear()}`;
  }

  if (typeof value !== "string") return "---";

  // ISO format YYYY-MM-DD → MM/DD/YYYY
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`;

  // Already MM/DD/YYYY or similar — normalize padding
  const usMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (usMatch) {
    const mm = usMatch[1].padStart(2, "0");
    const dd = usMatch[2].padStart(2, "0");
    const yyyy = usMatch[3].length === 2 ? `19${usMatch[3]}` : usMatch[3];
    return `${mm}/${dd}/${yyyy}`;
  }

  return value; // Unknown format — return as-is
}
