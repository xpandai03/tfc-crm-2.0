import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Redirect } from "wouter";
import { PageLayout } from "@/components/layout/page-layout";
import { useAuth } from "@/lib/auth-context";
import { canEditEmailTemplates } from "@shared/access-control";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Mail, Plus, Pencil, Trash2, Lock, Loader2, ArrowLeft } from "lucide-react";

interface RequiredField {
  key: string;
  label: string;
  type: string;
  defaultText: string;
}

interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  subject: string;
  contentFormat: "html" | "text";
  bodyContent: string;
  bodyHtml: string;
  bodyText: string;
  variables: string[];
  requiredFields: RequiredField[];
}

interface FullResponse {
  templates: EmailTemplate[];
  systemIds: string[];
  allowedVariables: string[];
}

type EditorState =
  | { mode: "list" }
  | { mode: "create" }
  | { mode: "edit"; template: EmailTemplate };

interface FormState {
  name: string;
  description: string;
  subject: string;
  bodyContent: string;
}

const emptyForm: FormState = { name: "", description: "", subject: "", bodyContent: "" };

/** Tokens referenced in the form content (for the live unknown-variable hint). */
function tokensIn(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    for (const m of Array.from((t || "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g))) found.add(m[1]);
  }
  return Array.from(found);
}

export default function EmailTemplates() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [editor, setEditor] = useState<EditorState>({ mode: "list" });
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [systemIds, setSystemIds] = useState<string[]>([]);
  const [allowedVariables, setAllowedVariables] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<EmailTemplate | null>(null);

  // Live preview (rendered server-side: branding wrapper + sample substitution)
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewSubject, setPreviewSubject] = useState("");

  // Cursor-insertion into the single Body field.
  const contentRef = useRef<HTMLTextAreaElement>(null);

  const allowed = canEditEmailTemplates(user?.email);

  // Content format drives newline handling: new templates are plain-text; an
  // existing template keeps its stored format (system templates are HTML).
  const contentFormat: "html" | "text" = editor.mode === "edit" ? editor.template.contentFormat : "text";

  const loadTemplates = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/email-templates/full", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load templates");
      const data: FullResponse = await res.json();
      setTemplates(data.templates || []);
      setSystemIds(data.systemIds || []);
      setAllowedVariables(data.allowedVariables || []);
    } catch (err) {
      toast({ title: "Could not load templates", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (allowed) void loadTemplates();
  }, [allowed, loadTemplates]);

  const isSystem = useCallback((id: string) => systemIds.includes(id), [systemIds]);

  const unknownTokens = useMemo(() => {
    const known = new Set(allowedVariables);
    return tokensIn(form.subject, form.bodyContent).filter((t) => !known.has(t));
  }, [form, allowedVariables]);

  // Live mirror of the server's deriveRequiredFields — the quick-fill inputs the
  // Send Email modal will show the sender, auto-detected from the fill-me
  // variables in the body. Read-only transparency; auto-derive owns the actual
  // required_fields on save.
  const derivedQuickFill = useMemo(() => {
    const FILL_ME_LABELS: Record<string, string> = {
      therapistName: "Provider Name",
      appointmentDatetime: "Appointment Date & Time",
      locationBlock: "Location",
      locationBlockText: "Location",
    };
    const used = new Set(tokensIn(form.subject, form.bodyContent));
    const labels: string[] = [];
    for (const [v, label] of Object.entries(FILL_ME_LABELS)) {
      if (used.has(v) && !labels.includes(label)) labels.push(label);
    }
    return labels;
  }, [form.subject, form.bodyContent]);

  const inForm = editor.mode === "create" || editor.mode === "edit";

  // Debounced live preview while editing — server renders the branded shell with
  // the SAME newline handling the sent email will have (truthful preview).
  useEffect(() => {
    if (!inForm) return;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch("/api/email-templates/preview", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: form.subject, bodyContent: form.bodyContent, contentFormat }),
        });
        if (!res.ok) return;
        const data = await res.json();
        setPreviewHtml(data.html || "");
        setPreviewSubject(data.subject || "");
      } catch {
        /* preview is best-effort */
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [inForm, form.subject, form.bodyContent, contentFormat]);

  if (!allowed) {
    return <Redirect to="/waitlist" replace />;
  }

  const startCreate = () => {
    setForm(emptyForm);
    setPreviewHtml("");
    setPreviewSubject("");
    setEditor({ mode: "create" });
  };
  const startEdit = (t: EmailTemplate) => {
    setForm({ name: t.name, description: t.description, subject: t.subject, bodyContent: t.bodyContent });
    setPreviewHtml("");
    setPreviewSubject("");
    setEditor({ mode: "edit", template: t });
  };
  const backToList = () => {
    setEditor({ mode: "list" });
    setForm(emptyForm);
  };

  // Insert {{token}} at the cursor of the Body field.
  const insertVariable = (varName: string) => {
    const token = `{{${varName}}}`;
    const ref = contentRef.current;
    const current = form.bodyContent;
    if (!ref) {
      setForm({ ...form, bodyContent: current + token });
      return;
    }
    const start = ref.selectionStart ?? current.length;
    const end = ref.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    setForm({ ...form, bodyContent: next });
    requestAnimationFrame(() => {
      ref.focus();
      const pos = start + token.length;
      ref.setSelectionRange(pos, pos);
    });
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.subject.trim() || !form.bodyContent.trim()) {
      toast({ title: "Missing required fields", description: "Name, subject, and a body are required.", variant: "destructive" });
      return;
    }
    if (unknownTokens.length > 0) {
      toast({
        title: "Unknown variables",
        description: `Remove or fix: ${unknownTokens.map((t) => `{{${t}}}`).join(", ")}`,
        variant: "destructive",
      });
      return;
    }
    setIsSaving(true);
    try {
      const isEdit = editor.mode === "edit";
      const url = isEdit ? `/api/email-templates/${(editor as { template: EmailTemplate }).template.id}` : "/api/email-templates";
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        let msg = "Save failed.";
        try {
          const b = await res.json();
          if (b?.error) msg = b.error;
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      toast({ title: isEdit ? "Template updated" : "Template created" });
      await loadTemplates();
      backToList();
    } catch (err) {
      toast({ title: "Could not save", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (t: EmailTemplate) => {
    setConfirmDelete(null);
    try {
      const res = await fetch(`/api/email-templates/${t.id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        let msg = "Delete failed.";
        try {
          const b = await res.json();
          if (b?.error) msg = b.error;
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      toast({ title: "Template deleted", description: t.name });
      await loadTemplates();
    } catch (err) {
      toast({ title: "Could not delete", description: (err as Error).message, variant: "destructive" });
    }
  };

  // ---- List view ----
  if (editor.mode === "list") {
    return (
      <PageLayout>
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <Mail className="h-6 w-6" /> Templates
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Create and edit the email templates staff use in the contact send-email dropdown.
              </p>
            </div>
            <Button onClick={startCreate} data-testid="button-new-template">
              <Plus className="h-4 w-4 mr-2" /> New Template
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading…
            </div>
          ) : (
            <div className="space-y-3">
              {templates.map((t) => (
                <Card key={t.id} className="hover:shadow-sm transition-shadow">
                  <CardContent className="p-4 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{t.name}</p>
                        {isSystem(t.id) ? (
                          <Badge variant="secondary" className="text-[10px]">
                            <Lock className="h-2.5 w-2.5 mr-1" /> System
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">Custom</Badge>
                        )}
                      </div>
                      {t.description && <p className="text-sm text-muted-foreground mt-0.5 truncate">{t.description}</p>}
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        <span className="font-medium">Subject:</span> {t.subject}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => startEdit(t)} data-testid={`button-edit-${t.id}`}>
                        <Pencil className="h-4 w-4 mr-1" /> Edit
                      </Button>
                      {!isSystem(t.id) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setConfirmDelete(t)}
                          data-testid={`button-delete-${t.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
              {templates.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">No templates yet.</p>
              )}
            </div>
          )}
        </div>

        <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this template?</AlertDialogTitle>
              <AlertDialogDescription>
                “{confirmDelete?.name}” will be removed from the send-email dropdown for all staff. This can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => confirmDelete && handleDelete(confirmDelete)}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </PageLayout>
    );
  }

  // ---- Create / Edit form ----
  const editing = editor.mode === "edit" ? editor.template : null;
  const editingSystem = editing ? isSystem(editing.id) : false;

  return (
    <PageLayout>
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={backToList}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <h1 className="text-xl font-bold tracking-tight">
            {editing ? `Edit: ${editing.name}` : "New Template"}
          </h1>
          {editingSystem && (
            <Badge variant="secondary" className="text-[10px]">
              <Lock className="h-2.5 w-2.5 mr-1" /> System template
            </Badge>
          )}
        </div>

        {/* Clickable variable chips — insert at cursor in the Body field */}
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Variables — click to insert at cursor in the body
          </p>
          <div className="flex flex-wrap gap-1.5">
            {allowedVariables.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => insertVariable(v)}
                className="text-xs px-1.5 py-0.5 rounded bg-background border hover:bg-accent hover:border-primary transition-colors font-mono"
                data-testid={`chip-${v}`}
              >{`{{${v}}}`}</button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Just type the message — press Enter for a new line and leave a blank line between paragraphs; those breaks
            appear in the email (see live preview). The branded header/footer and the plain-text version are added
            automatically. Only the variables above substitute; any other <code>{`{{token}}`}</code> is rejected on save.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: form fields */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">Name <span className="text-destructive">*</span></Label>
              <Input id="tpl-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Waitlist Status" data-testid="input-name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-desc">Description</Label>
              <Input id="tpl-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Short description shown in the dropdown" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-subject">Subject <span className="text-destructive">*</span></Label>
              <Input id="tpl-subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="Email subject line" data-testid="input-subject" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-content">Body <span className="text-destructive">*</span></Label>
              <Textarea
                id="tpl-content"
                ref={contentRef}
                value={form.bodyContent}
                onChange={(e) => setForm({ ...form, bodyContent: e.target.value })}
                className="min-h-[300px] text-sm"
                placeholder={"Hi {{firstName}},\n\nThanks for your patience on our waitlist…\n\nWarm regards,\nThe Family Connection Team"}
                data-testid="input-bodycontent"
              />
            </div>

            {derivedQuickFill.length > 0 && (
              <div className="rounded-lg border p-3 bg-muted/20">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  At send time, the sender will be asked for
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {derivedQuickFill.map((label) => (
                    <Badge key={label} variant="secondary" className="text-[11px]">{label}</Badge>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">
                  Auto-detected from the variables in your body — the Send Email quick-fill form appears automatically. Not editable.
                </p>
              </div>
            )}

            {unknownTokens.length > 0 && (
              <p className="text-xs text-destructive">
                Unknown variable(s): {unknownTokens.map((t) => `{{${t}}}`).join(", ")} — these won't substitute and will be rejected on save.
              </p>
            )}
          </div>

          {/* Right: live rendered preview */}
          <div className="space-y-2">
            <Label>Live preview (sample values)</Label>
            <div className="border rounded-lg overflow-hidden lg:sticky lg:top-20">
              <div className="px-4 py-2 bg-muted border-b">
                <span className="text-xs text-muted-foreground">Subject: </span>
                <span className="text-sm font-medium">{previewSubject || form.subject || "—"}</span>
              </div>
              <div
                className="bg-white text-sm max-h-[480px] overflow-y-auto"
                dangerouslySetInnerHTML={{ __html: previewHtml || "<p style='padding:24px;color:#9ca3af'>Start typing the body to see the rendered preview…</p>" }}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" onClick={backToList} disabled={isSaving}>Cancel</Button>
          <Button onClick={handleSave} disabled={isSaving || unknownTokens.length > 0} data-testid="button-save">
            {isSaving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…</> : editing ? "Save changes" : "Create template"}
          </Button>
        </div>
      </div>
    </PageLayout>
  );
}
