import { useCallback, useEffect, useMemo, useState } from "react";
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
  bodyHtml: string;
  bodyText: string;
}

const emptyForm: FormState = { name: "", description: "", subject: "", bodyHtml: "", bodyText: "" };

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

  // Access gate — non-editors are redirected away (server still enforces 403).
  const allowed = canEditEmailTemplates(user?.email);

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
    return tokensIn(form.subject, form.bodyHtml, form.bodyText).filter((t) => !known.has(t));
  }, [form, allowedVariables]);

  if (!allowed) {
    return <Redirect to="/waitlist" replace />;
  }

  const startCreate = () => {
    setForm(emptyForm);
    setEditor({ mode: "create" });
  };
  const startEdit = (t: EmailTemplate) => {
    setForm({ name: t.name, description: t.description, subject: t.subject, bodyHtml: t.bodyHtml, bodyText: t.bodyText });
    setEditor({ mode: "edit", template: t });
  };
  const backToList = () => {
    setEditor({ mode: "list" });
    setForm(emptyForm);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.subject.trim() || (!form.bodyHtml.trim() && !form.bodyText.trim())) {
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
                <Mail className="h-6 w-6" /> Email Templates
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Create and edit the templates staff use in the contact send-email dropdown.
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
      <div className="max-w-3xl mx-auto space-y-6">
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

        {/* Allowed variables helper */}
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Allowed variables (substituted at send time)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {allowedVariables.map((v) => (
              <code key={v} className="text-xs px-1.5 py-0.5 rounded bg-background border">{`{{${v}}}`}</code>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Body fields hold the full email HTML / text exactly as sent (branding wrapper included). Only the
            variables above are substituted — any other <code>{`{{token}}`}</code> is rejected on save.
          </p>
        </div>

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
            <Label htmlFor="tpl-html">Email body — HTML <span className="text-destructive">*</span></Label>
            <Textarea id="tpl-html" value={form.bodyHtml} onChange={(e) => setForm({ ...form, bodyHtml: e.target.value })}
              className="min-h-[220px] font-mono text-xs" placeholder="<p>Hi {{firstName}}, …</p>" data-testid="input-bodyhtml" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-text">Email body — plain text</Label>
            <Textarea id="tpl-text" value={form.bodyText} onChange={(e) => setForm({ ...form, bodyText: e.target.value })}
              className="min-h-[140px] font-mono text-xs" placeholder="Hi {{firstName}}, …" />
          </div>

          {/* Read-only required fields (structural — not editable in v1) */}
          {editing && editing.requiredFields.length > 0 && (
            <div className="rounded-lg border p-3 bg-muted/20">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Required fields (structural — read-only)
              </p>
              <div className="space-y-1">
                {editing.requiredFields.map((f) => (
                  <div key={f.key} className="text-xs text-muted-foreground">
                    <code className="text-foreground">{f.key}</code> — {f.label} ({f.type})
                  </div>
                ))}
              </div>
            </div>
          )}

          {unknownTokens.length > 0 && (
            <p className="text-xs text-destructive">
              Unknown variable(s): {unknownTokens.map((t) => `{{${t}}}`).join(", ")} — these won't substitute and will be rejected on save.
            </p>
          )}
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
