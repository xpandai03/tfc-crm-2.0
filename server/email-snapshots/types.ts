export interface EmailSnapshot {
  id: number;
  contactId: number;
  templateId: string;
  subject: string;
  bodyHtml: string;
  sentByEmail: string;
  senderEmail: string | null;
  recipientEmail: string | null;
  ccEmails: string;
  sentAt: string;
}

export interface CreateEmailSnapshotParams {
  contactId: number;
  templateId: string;
  subject: string;
  bodyHtml: string;
  sentByEmail: string;
  senderEmail: string;
  recipientEmail: string;
  ccEmails?: string[];
}
