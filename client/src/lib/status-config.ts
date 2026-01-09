import type { ContactStatus } from "@shared/schema";

export const STATUS_MAP: Record<ContactStatus, number> = {
  intake: 100,
  waiting: 101,
  ready_to_schedule: 200,
  scheduled: 202,
  on_hold: 300,
  closed: 400,
};

export const STATUS_LABELS: Record<ContactStatus, string> = {
  intake: "Intake",
  waiting: "Waiting",
  ready_to_schedule: "Ready to Schedule",
  scheduled: "Scheduled",
  on_hold: "On Hold",
  closed: "Closed",
};

export const PIPELINE_COLUMNS: ContactStatus[] = [
  "intake",
  "waiting",
  "ready_to_schedule",
  "scheduled",
  "on_hold",
];
