/**
 * Send Email Modal
 *
 * Admin-triggered email sending with template selection and preview.
 * - NO auto-sending: requires explicit "Send" click
 * - Templates with requiredFields show dynamic inputs that update preview live
 * - Provider and location dropdowns for qualifying templates
 * - ECC soft-gate: warns if consent missing but doesn't block
 * - Full audit logging via Activity Timeline
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
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
  type: "text" | "datetime" | "provider-select" | "location-select";
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

interface ApiProvider {
  name: string;
  credentials: string;
}

interface LocationEntry {
  id: string;
  label: string;
  address: string | null;
}

interface EmailConfig {
  providerEmails: Record<string, string>;
  locations: LocationEntry[];
}

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
  const [emailConfig, setEmailConfig] = useState<EmailConfig | null>(null);
  const [providerList, setProviderList] = useState<ApiProvider[]>([]);

  const [dynamicFields, setDynamicFields] = useState<Record<string, string>>({});
  const [rawDatetimeValues, setRawDatetimeValues] = useState<Record<string, string>>({});

  const previewAbortRef = useRef<AbortController | null>(null);

  const selectedTpl = useMemo(
    () => templates.find((t) => t.id === selectedTemplate) || null,
    [templates, selectedTemplate]
  );

  // Fetch templates, email config, and provider list when modal opens
  useEffect(() => {
    if (isOpen) {
      if (templates.length === 0) fetchTemplates();
      if (!emailConfig) fetchEmailConfig();
      if (providerList.length === 0) fetchProviderList();
    }
  }, [isOpen]);

  // Fetch base preview when template is selected
  useEffect(() => {
    if (selectedTemplate && contact?.contactId) {
      fetchPreview(selectedTemplate, contact.contactId);
    } else {
      setPreview(null);
    }
  }, [selectedTemplate, contact?.contactId]);

  // Reset state when modal closes
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
      if (!response.ok) throw new Error("Failed to fetch templates");
      const data = await response.json();
      setTemplates(data.templates || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setIsLoadingTemplates(false);
    }
  };

  const fetchEmailConfig = async () => {
    try {
      const response = await fetch("/api/email-config");
      if (!response.ok) throw new Error("Failed to fetch email config");
      const data = await response.json();
      setEmailConfig(data);
    } catch (err) {
      console.error("Failed to fetch email config:", err);
    }
  };

  const fetchProviderList = async () => {
    try {
      const response = await fetch("/api/providers");
      if (!response.ok) throw new Error("Failed to fetch providers");
      const data = await response.json();
      setProviderList(data.providers || []);
    } catch (err) {
      console.error("Failed to fetch provider list:", err);
    }
  };

  const fetchPreview = useCallback(
    async (templateId: string, contactId: number, fields?: Record<string, string>) => {
      if (previewAbortRef.current) previewAbortRef.current.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;

      setIsLoadingPreview(true);
      setError(null);
      try {
        const response = await fetch("/api/email-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ templateId, contactId, dynamicFields: fields }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to generate preview");
        }
        const data = await response.json();
        setPreview(data);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load preview");
        setPreview(null);
      } finally {
        setIsLoadingPreview(false);
      }
    },
    []
  );

  // Re-fetch preview from server when location or provider changes (server renders locationBlock)
  const refetchPreviewWithFields = useCallback(
    (updatedFields: Record<string, string>) => {
      if (selectedTemplate && contact?.contactId) {
        fetchPreview(selectedTemplate, contact.contactId, updatedFields);
      }
    },
    [selectedTemplate, contact?.contactId, fetchPreview]
  );

  const handleTemplateChange = (value: string) => {
    setSelectedTemplate(value || null);
    setDynamicFields({});
    setRawDatetimeValues({});
  };

  const handleTextFieldChange = (key: string, value: string) => {
    setDynamicFields((prev) => ({ ...prev, [key]: value }));
  };

  const handleDatetimeFieldChange = (key: string, rawValue: string) => {
    setRawDatetimeValues((prev) => ({ ...prev, [key]: rawValue }));
    const formatted = formatDatetimeForEmail(rawValue);
    setDynamicFields((prev) => ({ ...prev, [key]: formatted }));
  };

  const handleProviderChange = (providerName: string) => {
    const next = { ...dynamicFields, therapistName: providerName };
    setDynamicFields(next);
    refetchPreviewWithFields(next);
  };

  const handleLocationChange = (locationId: string) => {
    const next = { ...dynamicFields, locationId };
    setDynamicFields(next);
    refetchPreviewWithFields(next);
  };

  // Live preview: client-side replacement of text/datetime/provider placeholders.
  // Location block HTML comes from the server re-fetch.
  const livePreviewHtml = useMemo(() => {
    if (!preview?.bodyHtml || !selectedTpl) return preview?.bodyHtml || "";
    let html = preview.bodyHtml;
    for (const field of selectedTpl.requiredFields) {
      if (field.type === "location-select") continue;
      const value = dynamicFields[field.key];
      if (value && value.trim()) {
        const escaped = field.defaultText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        html = html.replace(new RegExp(escaped, "g"), value.trim());
      }
    }
    return html;
  }, [preview?.bodyHtml, selectedTpl, dynamicFields]);

  const allRequiredFieldsFilled = useMemo(() => {
    if (!selectedTpl || selectedTpl.requiredFields.length === 0) return true;
    return selectedTpl.requiredFields.every(
      (field) => dynamicFields[field.key]?.trim()
    );
  }, [selectedTpl, dynamicFields]);

  const unfilledFields = useMemo(() => {
    if (!selectedTpl) return [];
    return selectedTpl.requiredFields.filter(
      (field) => !dynamicFields[field.key]?.trim()
    );
  }, [selectedTpl, dynamicFields]);

  // Resolve selected provider email for CC display
  const selectedProviderEmail = useMemo(() => {
    if (!emailConfig?.providerEmails || !dynamicFields.therapistName) return null;
    const name = dynamicFields.therapistName;
    // Try exact match, then case-insensitive
    return emailConfig.providerEmails[name]
      || Object.entries(emailConfig.providerEmails).find(
        ([k]) => k.toLowerCase() === name.toLowerCase()
      )?.[1]
      || null;
  }, [emailConfig, dynamicFields.therapistName]);

  const handleSend = async () => {
    if (!selectedTemplate || !contact?.contactId || !preview) return;

    const templateId = selectedTemplate;
    const contactId = contact.contactId;
    const eccStatus = preview.eccStatus;
    const fieldsToSend = { ...dynamicFields };
    onClose();

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

      const text = await response.text();
      let result: { success?: boolean; error?: string } = {};
      if (text) {
        try {
          result = JSON.parse(text);
        } catch {
          if (!response.ok) {
            throw new Error("Server returned an invalid response");
          }
        }
      }

      if (!response.ok || (text && !result.success)) {
        throw new Error(result.error || "Failed to send email");
      }

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

  const renderField = (field: RequiredField) => {
    if (field.type === "provider-select") {
      return (
        <div key={field.key} className="space-y-1.5">
          <Label htmlFor={`field-${field.key}`} className="text-sm">
            {field.label} <span className="text-destructive">*</span>
          </Label>
          <Select
            value={dynamicFields[field.key] || ""}
            onValueChange={handleProviderChange}
          >
            <SelectTrigger id={`field-${field.key}`}>
              <SelectValue placeholder="Select a provider" />
            </SelectTrigger>
            <SelectContent className="max-h-[240px]">
              {providerList.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  {p.name} — {p.credentials}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedProviderEmail && (
            <p className="text-xs text-muted-foreground">
              CC: {selectedProviderEmail}
            </p>
          )}
        </div>
      );
    }

    if (field.type === "location-select") {
      return (
        <div key={field.key} className="space-y-1.5">
          <Label htmlFor={`field-${field.key}`} className="text-sm">
            {field.label} <span className="text-destructive">*</span>
          </Label>
          <Select
            value={dynamicFields[field.key] || ""}
            onValueChange={handleLocationChange}
          >
            <SelectTrigger id={`field-${field.key}`}>
              <SelectValue placeholder="Select a location" />
            </SelectTrigger>
            <SelectContent>
              {(emailConfig?.locations || []).map((loc) => (
                <SelectItem key={loc.id} value={loc.id}>
                  {loc.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    }

    if (field.type === "datetime") {
      return (
        <div key={field.key} className="space-y-1.5">
          <Label htmlFor={`field-${field.key}`} className="text-sm">
            {field.label} <span className="text-destructive">*</span>
          </Label>
          <Input
            id={`field-${field.key}`}
            type="datetime-local"
            value={rawDatetimeValues[field.key] || ""}
            onChange={(e) =>
              handleDatetimeFieldChange(field.key, e.target.value)
            }
            className="w-full"
          />
        </div>
      );
    }

    return (
      <div key={field.key} className="space-y-1.5">
        <Label htmlFor={`field-${field.key}`} className="text-sm">
          {field.label} <span className="text-destructive">*</span>
        </Label>
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
      </div>
    );
  };

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
              {selectedTpl.requiredFields.map(renderField)}
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
                <div className="px-4 py-2 bg-muted border-b">
                  <span className="text-xs text-muted-foreground">Subject: </span>
                  <span className="text-sm font-medium">{preview.subject}</span>
                </div>
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

          {/* Sender Info */}
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
