// Status lifecycle: pending → in_progress → created | failed
export interface TherapyNotesRecord {
  id: number;
  contactId: number;
  contactName: string;
  createdByEmail: string;
  tnStatus: "pending" | "in_progress" | "created" | "failed";
  tnPatientUrl: string | null;
  tnPatientId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTnRecordParams {
  contactId: number;
  contactName: string;
  createdByEmail: string;
}

// Matches the TN agent's expected input schema
export interface TnAgentPayload {
  first_name: string;
  last_name: string;
  dob: string;
  email: string;
  address: string;
  zip: string;
  sex: string;
  eil: string;
  phone: string;
  rfs_url: string;
}

// Matches the TN agent's V2 endpoint (/api/tn/create-patient-with-schedule):
// create patient + upload intake & snapshot PDFs + schedule the appointment.
export interface TnV2AgentPayload {
  first_name: string;
  last_name: string;
  dob: string;              // MM/DD/YYYY
  address: string;
  zip: string;              // 5-digit
  sex: string;              // "Male" | "Female"
  email: string;
  phone: string;
  rfs_url: string;          // kept for V1 backward compat
  intake_pdf_url: string;   // intake referral PDF
  snapshot_pdf_url: string; // appointment-confirmation snapshot PDF
  appointment_date: string; // m/d/yyyy
  appointment_time: string; // h:mm am/pm
  appointment_alert_text: string;
  clinician_name: string;
  // Async progress (TN agent posts phase events to callback_url, tagged with runId)
  runId: string;
  callback_url: string;
}

// Matches the TN agent's response schema
export interface TnAgentResponse {
  status: "success" | "error";
  tn_patient_url?: string;
  tn_patient_id?: string;
  failure_reason?: string;
  logs?: string[];
}
