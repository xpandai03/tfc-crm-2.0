export interface EmailSnapshot {
  id: number;
  contactId: number;
  templateId: string;
  subject: string;
  bodyHtml: string;
  sentByEmail: string;
  sentAt: string;
}

export interface CreateEmailSnapshotParams {
  contactId: number;
  templateId: string;
  subject: string;
  bodyHtml: string;
  sentByEmail: string;
}
