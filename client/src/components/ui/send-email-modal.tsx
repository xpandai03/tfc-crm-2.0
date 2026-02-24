/**
 * Send Email Modal
 *
 * Admin-triggered email sending with template selection and preview.
 * - NO auto-sending: requires explicit "Send" click
 * - Templates with requiredFields show dynamic inputs that update preview live
 * - ECC soft-gate: warns if consent missing but doesn't block
 * - Full audit logging via Activity Timeline
 */

import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Mail, Send, Loader2 } from "lucide-react";
import type { ContactSnapshot } from "@shared/schema";

interface SendEmailModalProps {
  isOpen: boolean;
  onClose: () => void;
  contact: ContactSnapshot | null;
  userEmail: string;
  onSend: (result: { success: boolean; error?: string }) => void;
}

interface RequiredField {
  key: string;
  label: string;
  type: "text" | "datetime";
  defaultText: string;
}

interface TemplateMetadata {
  id: string;
  name: string;
  description: string;
  requiredFields: RequiredField[];
}

interface RenderedEmail {
  templateId: string;
  templateName: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  recipientEmail: string;
  recipientName: string;
  eccStatus: "present" | "missing";
}

/**
 * Format a datetime-local value into a human-readable string for the email
 */
function formatDatetimeForEmail(datetimeLocalValue: string): string {
  const date = new Date(datetimeLocalValue);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function SendEmailModal({
  isOpen,
  onClose,
  contact,
  userEmail,
  onSend,
}: SendEmailModalProps) {
  const [templates, setTemplates] = useState<TemplateMetadata[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [preview, setPreview] = useState<RenderedEmail | null>(null);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dynamic field values (formatted strings ready for email substitution)
  const [dynamicFields, setDynamicFields] = useState<Record<string, string>>({});
  // Raw datetime-local input values (YYYY-MM-DDTHH:mm format for controlled inputs)
  const [rawDatetimeValues, setRawDatetimeValues] = useState<Record<string, string>>({});

  // Get the selected template's metadata
  const selectedTpl = useMemo(
    () => templates.find((t) => t.id === selectedTemplate) || null,
    [templates, selectedTemplate]
  );

  // Fetch templates when modal opens
  useEffect(() => {
    if (isOpen && templates.length === 0) {
      fetchTemplates();
    }
  }, [isOpen]);

  // Fetch preview when template is selected (base preview with default placeholders)
  useEffect(() => {
    if (selectedTemplate && contact?.contactId) {
      fetchPreview(selectedTemplate, contact.contactId);
    } else {
      setPreview(null);
    }
  }, [selectedTemplate, contact?.contactId]);

  // Reset all state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedTemplate(null);
      setPreview(null);
      setError(null);
      setDynamicFields({});
      setRawDatetimeValues({});
    }
  }, [isOpen]);

  const fetchTemplates = async () => {
    setIsLoadingTemplates(true);
    setError(null);
    try {
      const response = await fetch("/api/email-templates");
      if (!response.ok) {
        throw new Error("Failed to fetch templates");
      }
      const data = await response.json();
      setTemplates(data.templates || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setIsLoadingTemplates(false);
    }
  };

  const fetchPreview = async (templateId: string, contactId: number) => {
    setIsLoadingPreview(true);
    setError(null);
    try {
      const response = await fetch("/api/email-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, contactId }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to generate preview");
      }
      const data = await response.json();
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load preview");
      setPreview(null);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  // Handle template selection change — reset dynamic fields
  const handleTemplateChange = (value: string) => {
    setSelectedTemplate(value || null);
    setDynamicFields({});
    setRawDatetimeValues({});
  };

  // Handle text field change
  const handleTextFieldChange = (key: string, value: string) => {
    setDynamicFields((prev) => ({ ...prev, [key]: value }));
  };

  // Handle datetime field change — stores formatted string in dynamicFields
  const handleDatetimeFieldChange = (key: string, rawValue: string) => {
    setRawDatetimeValues((prev) => ({ ...prev, [key]: rawValue }));
    const formatted = formatDatetimeForEmail(rawValue);
    setDynamicFields((prev) => ({ ...prev, [key]: formatted }));
  };

  // Live preview: replace default placeholder text with admin's input
  const livePreviewHtml = useMemo(() => {
    if (!preview?.bodyHtml || !selectedTpl) return preview?.bodyHtml || "";
    let html = preview.bodyHtml;
    for (const field of selectedTpl.requiredFields) {
      const value = dynamicFields[field.key];
      if (value && value.trim()) {
        // Replace all occurrences of the default placeholder text with the admin's value
        // Escape special regex chars in defaultText
        const escaped = field.defaultText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        html = html.replace(new RegExp(escaped, "g"), value.trim());
      }
    }
    return html;
  }, [preview?.bodyHtml, selectedTpl, dynamicFields]);

  // Check if all required fields are filled
  const allRequiredFieldsFilled = useMemo(() => {
    if (!selectedTpl || selectedTpl.requiredFields.length === 0) return true;
    return selectedTpl.requiredFields.every(
      (field) => dynamicFields[field.key]?.trim()
    );
  }, [selectedTpl, dynamicFields]);

  // Find unfilled required fields for validation message
  const unfilledFields = useMemo(() => {
    if (!selectedTpl) return [];
    return selectedTpl.requiredFields.filter(
      (field) => !dynamicFields[field.key]?.trim()
    );
  }, [selectedTpl, dynamicFields]);

  const handleSend = async () => {
    if (!selectedTemplate || !contact?.contactId || !preview) return;

    // Close modal immediately for better UX - don't make user wait
    const templateId = selectedTemplate;
    const contactId = contact.contactId;
    const eccStatus = preview.eccStatus;
    const fieldsToSend = { ...dynamicFields };
    onClose();

    // Fire off send in background - parent will show toast with result
    try {
      const response = await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId,
          contactId,
          eccStatus,
          dynamicFields: fieldsToSend,
        }),
      });

      // Defensive: handle empty or non-JSON responses gracefully.
      // The backend may close the connection before sending a body
      // (e.g., proxy timeout on Fly.io after slow n8n calls).
      const text = await response.text();
      let result: { success?: boolean; error?: string } = {};
      if (text) {
        try {
          result = JSON.parse(text);
        } catch {
          // Response was not valid JSON — treat 2xx as success
          if (!response.ok) {
            throw new Error("Server returned an invalid response");
          }
        }
      }

      if (!response.ok || (text && !result.success)) {
        throw new Error(result.error || "Failed to send email");
      }

      // Success - notify parent (will show toast)
      onSend({ success: true });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to send email";
      onSend({ success: false, error: errorMessage });
    }
  };

  const handleClose = () => {
    onClose();
  };

  const hasEmail = !!contact?.email;
  const canSend =
    selectedTemplate &&
    preview &&
    hasEmail &&
    !isLoadingPreview &&
    allRequiredFieldsFilled;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Send Email
          </DialogTitle>
          <DialogDescription>
            Send a templated email to {contact?.name || "this contact"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* No Email Warning */}
          {!hasEmail && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                This contact does not have an email address on file.
                Email cannot be sent.
              </AlertDescription>
            </Alert>
          )}

          {/* Recipient Info */}
          {hasEmail && (
            <div className="text-sm">
              <span className="text-muted-foreground">To: </span>
              <span className="font-medium">{contact?.name}</span>
              <span className="text-muted-foreground"> &lt;{contact?.email}&gt;</span>
            </div>
          )}

          {/* Template Selector */}
          <div className="space-y-2">
            <Label htmlFor="template-select">Email Template</Label>
            <Select
              value={selectedTemplate || ""}
              onValueChange={handleTemplateChange}
              disabled={!hasEmail || isLoadingTemplates}
            >
              <SelectTrigger id="template-select">
                <SelectValue placeholder={
                  isLoadingTemplates ? "Loading templates..." : "Select a template"
                } />
              </SelectTrigger>
              <SelectContent>
                {templates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    <div className="flex flex-col">
                      <span>{template.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {template.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Dynamic Required Fields */}
          {selectedTpl && selectedTpl.requiredFields.length > 0 && (
            <div className="space-y-3 rounded-lg border p-3 bg-muted/30">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Required Information
              </p>
              {selectedTpl.requiredFields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`field-${field.key}`} className="text-sm">
                    {field.label} <span className="text-destructive">*</span>
                  </Label>
                  {field.type === "datetime" ? (
                    <Input
                      id={`field-${field.key}`}
                      type="datetime-local"
                      value={rawDatetimeValues[field.key] || ""}
                      onChange={(e) =>
                        handleDatetimeFieldChange(field.key, e.target.value)
                      }
                      className="w-full"
                    />
                  ) : (
                    <Input
                      id={`field-${field.key}`}
                      type="text"
                      value={dynamicFields[field.key] || ""}
                      onChange={(e) =>
                        handleTextFieldChange(field.key, e.target.value)
                      }
                      placeholder={`Enter ${field.label.toLowerCase()}`}
                      className="w-full"
                    />
                  )}
                </div>
              ))}
              {/* Validation: show unfilled fields */}
              {unfilledFields.length > 0 && selectedTemplate && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {unfilledFields.map((f) => f.label).join(", ")}{" "}
                  {unfilledFields.length === 1 ? "is" : "are"} required before sending
                </p>
              )}
            </div>
          )}

          {/* ECC Warning */}
          {preview && preview.eccStatus === "missing" && (
            <Alert className="border-amber-500 bg-amber-50 dark:bg-amber-950/30">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-800 dark:text-amber-200">
                Electronic Communication Consent not on file.
                Email can still be sent but will be logged.
              </AlertDescription>
            </Alert>
          )}

          {/* Preview Section */}
          {isLoadingPreview && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading preview...</span>
            </div>
          )}

          {preview && !isLoadingPreview && (
            <div className="space-y-3">
              <Label>Preview</Label>
              <div className="border rounded-lg overflow-hidden">
                {/* Subject Line */}
                <div className="px-4 py-2 bg-muted border-b">
                  <span className="text-xs text-muted-foreground">Subject: </span>
                  <span className="text-sm font-medium">{preview.subject}</span>
                </div>
                {/* Body Preview — uses live-substituted HTML */}
                <div
                  className="p-4 bg-white dark:bg-gray-950 text-sm max-h-[300px] overflow-y-auto"
                  dangerouslySetInnerHTML={{ __html: livePreviewHtml }}
                />
              </div>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Sender Info - shows actual system sender, not admin login */}
          <p className="text-xs text-muted-foreground">
            From: <span className="font-medium">The Family Connection &lt;no-reply@hipaacheck.ai&gt;</span>
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={!canSend}>
            <Send className="h-4 w-4 mr-2" />
            Send Email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
