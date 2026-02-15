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
  address: string;
  zip: string;
  sex: string;
  eil: string;
  phone: string;
  rfs_url: string;
}

// Matches the TN agent's response schema
export interface TnAgentResponse {
  status: "success" | "error";
  tn_patient_url?: string;
  tn_patient_id?: string;
  failure_reason?: string;
  logs?: string[];
}
