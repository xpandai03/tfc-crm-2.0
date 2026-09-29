/**
 * Documents on a contact — upload, view, download, remove.
 *
 * Sits in the contact page's right column just above the Intake Summary (which
 * holds the intake PDF download). Collapsed by default with a count, because
 * the right column is already long; opening it shows the list and the upload
 * form. See server/documents/routes.ts for the rules the server enforces —
 * this card checks size and type first only so the message is immediate.
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, Eye, FolderOpen, Loader2, Trash2, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";
import {
  DOCUMENT_ACCEPT,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_NAME_MAX,
  DOCUMENT_TYPE_LABEL,
  defaultDocumentName,
  formatDocumentSize,
  tooLargeMessage,
  type ContactDocument,
} from "@shared/contact-documents";
import {
  documentContentUrl,
  listContactDocuments,
  removeContactDocument,
  uploadContactDocument,
} from "@/lib/api";

const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const ACCEPTED_EXT = /\.(pdf|jpe?g|png)$/i;

function uploader(d: ContactDocument): string {
  return d.uploadedByName?.trim() || d.uploadedByEmail.split("@")[0];
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function ContactDocumentsCard({ contactId }: { contactId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<ContactDocument | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const queryKey = ["/api/contact", contactId, "documents"];
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => listContactDocuments(contactId),
    staleTime: 30_000,
  });
  const documents = data?.documents ?? [];

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ["/api/activity/contact", contactId] });
  };

  const clearForm = () => {
    setFile(null);
    setName("");
    setFileError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const uploadMutation = useMutation({
    mutationFn: () => uploadContactDocument(contactId, file!, name.trim()),
    onSuccess: (res) => {
      toast({ title: "Document uploaded", description: res.document.displayName });
      clearForm();
      refresh();
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (doc: ContactDocument) => removeContactDocument(contactId, doc.id),
    onSuccess: (_res, doc) => {
      toast({ title: "Document removed", description: doc.displayName });
      refresh();
    },
    onError: (err: Error) => {
      toast({ title: "Could not remove the document", description: err.message, variant: "destructive" });
    },
  });

  const onPick = (picked: File | null) => {
    setFileError(null);
    if (!picked) {
      clearForm();
      return;
    }
    // Checked here for an immediate, specific message. The server enforces the
    // same limits by content, whatever this says.
    if (!ACCEPTED_TYPES.includes(picked.type) && !ACCEPTED_EXT.test(picked.name)) {
      setFile(null);
      setFileError("Only PDF, JPG and PNG files can be uploaded.");
      return;
    }
    if (picked.size > DOCUMENT_MAX_BYTES) {
      setFile(null);
      setFileError(tooLargeMessage(DOCUMENT_MAX_BYTES));
      return;
    }
    setFile(picked);
    setName(defaultDocumentName(picked.name));
  };

  return (
    <Card className="overflow-visible" data-testid="card-documents">
      <CardHeader className="pb-2">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="button-toggle-documents"
        >
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            Documents
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4" data-testid="badge-document-count">
              {isLoading ? "…" : documents.length}
            </Badge>
          </CardTitle>
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </button>
        <p className="text-[10px] text-muted-foreground mt-0.5">Custody orders, VA referrals, the fax referral</p>
      </CardHeader>

      {open && (
        <CardContent className="space-y-3">
          {/* List */}
          {documents.length === 0 && !isLoading && (
            <p className="text-xs text-muted-foreground italic">No documents yet</p>
          )}
          {documents.length > 0 && (
            <ul className="space-y-2" data-testid="list-documents">
              {documents.map((d) => (
                <li key={d.id} className="rounded-md border border-border p-2 text-xs space-y-1" data-testid={`document-${d.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-foreground break-words min-w-0">{d.displayName}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {DOCUMENT_TYPE_LABEL[d.mimeType] ?? d.mimeType} · {formatDocumentSize(d.sizeBytes)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    {d.source === "fax_referral" && (
                      <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">Fax referral</Badge>
                    )}
                    {/* Filed to the TherapyNotes chart by an Add to Schedule run.
                        Documents without it are sent on the next run. */}
                    {d.tnUploadedAt && (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1 py-0 h-4 border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400"
                        title={`Filed to TherapyNotes ${when(d.tnUploadedAt)}`}
                        data-testid={`badge-in-tn-${d.id}`}
                      >
                        In TN
                      </Badge>
                    )}
                    <span>{uploader(d)} · {when(d.uploadedAt)}</span>
                  </div>
                  <div className="flex items-center gap-1 pt-0.5">
                    <Button
                      variant="ghost" size="sm" className="h-7 px-2 text-xs"
                      onClick={() => window.open(documentContentUrl(contactId, d.id, "inline"), "_blank", "noopener,noreferrer")}
                      data-testid={`button-view-document-${d.id}`}
                    >
                      <Eye className="h-3 w-3 mr-1" /> View
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                      <a href={documentContentUrl(contactId, d.id, "attachment")} data-testid={`link-download-document-${d.id}`}>
                        <Download className="h-3 w-3 mr-1" /> Download
                      </a>
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      className="h-7 px-2 text-xs ml-auto text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                      onClick={() => setToRemove(d)}
                      disabled={removeMutation.isPending}
                      data-testid={`button-remove-document-${d.id}`}
                    >
                      <Trash2 className="h-3 w-3 mr-1" /> Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Upload */}
          <div className="space-y-2 pt-2 border-t border-border">
            <Input
              ref={inputRef}
              type="file"
              accept={DOCUMENT_ACCEPT}
              className="h-9 text-xs"
              onChange={(e) => onPick(e.target.files?.[0] ?? null)}
              disabled={uploadMutation.isPending}
              data-testid="input-document-file"
            />
            {fileError && (
              <p className="text-xs text-destructive" role="alert" data-testid="text-document-file-error">{fileError}</p>
            )}
            {file && (
              <>
                <label className="text-xs text-muted-foreground" htmlFor="document-name">Name</label>
                <Input
                  id="document-name"
                  value={name}
                  maxLength={DOCUMENT_NAME_MAX}
                  onChange={(e) => setName(e.target.value)}
                  className="h-8 text-sm"
                  data-testid="input-document-name"
                />
              </>
            )}
            <p className="text-[10px] text-muted-foreground">PDF, JPG or PNG, up to {formatDocumentSize(DOCUMENT_MAX_BYTES)}</p>
            <Button
              size="sm"
              disabled={!file || !name.trim() || uploadMutation.isPending}
              onClick={() => uploadMutation.mutate()}
              data-testid="button-upload-document"
            >
              {uploadMutation.isPending ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <Upload className="h-3 w-3 mr-1.5" />}
              Upload
            </Button>
          </div>
        </CardContent>
      )}

      <AlertDialog open={!!toRemove} onOpenChange={(o) => !o && setToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {toRemove?.displayName} will disappear from this contact. The removal is recorded on the timeline.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (toRemove) removeMutation.mutate(toRemove); setToRemove(null); }}
              data-testid="button-confirm-remove-document"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
