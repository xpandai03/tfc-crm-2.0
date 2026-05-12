import { useCallback, useRef, useState } from "react";
import { Upload, FileText, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface UploadZoneProps {
  file: File | null;
  onFileSelected: (file: File) => void;
  onFileCleared: () => void;
  onProcess: () => void;
  isProcessing: boolean;
}

const MAX_SIZE_BYTES = 20 * 1024 * 1024;

export function UploadZone({
  file,
  onFileSelected,
  onFileCleared,
  onProcess,
  isProcessing,
}: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validateAndAccept = useCallback(
    (f: File) => {
      setErrorMessage(null);
      if (f.type !== "application/pdf") {
        setErrorMessage("Only PDF files are accepted.");
        return;
      }
      if (f.size > MAX_SIZE_BYTES) {
        setErrorMessage("File is too large. Maximum size is 20MB.");
        return;
      }
      onFileSelected(f);
    },
    [onFileSelected],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const f = e.dataTransfer.files?.[0];
      if (f) validateAndAccept(f);
    },
    [validateAndAccept],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) validateAndAccept(f);
      e.target.value = "";
    },
    [validateAndAccept],
  );

  if (isProcessing) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-8 rounded-lg border border-dashed bg-muted/20">
        <Loader2 className="h-10 w-10 animate-spin text-primary mb-4" />
        <p className="text-sm font-medium">Reading referral…</p>
        <p className="text-xs text-muted-foreground mt-1">This can take up to 30 seconds.</p>
      </div>
    );
  }

  if (file) {
    return (
      <div className="rounded-lg border bg-card">
        <div className="flex items-center gap-3 p-4">
          <FileText className="h-6 w-6 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {(file.size / 1024).toFixed(0)} KB · PDF
            </p>
          </div>
          <button
            type="button"
            onClick={onFileCleared}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Remove file"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-t p-4 flex justify-end">
          <Button onClick={onProcess} data-testid="button-process-referral">
            Process Referral
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "rounded-lg border-2 border-dashed transition-colors cursor-pointer",
          "flex flex-col items-center justify-center py-16 px-8 text-center",
          isDragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/30 hover:border-muted-foreground/50 bg-muted/20",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        data-testid="referral-drop-zone"
      >
        <Upload className="h-10 w-10 text-muted-foreground/60 mb-4" />
        <p className="text-sm font-medium">Drag and drop a PDF here, or click to browse</p>
        <p className="text-xs text-muted-foreground mt-1">PDF only · Max 20MB</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={onInputChange}
        />
      </div>
      {errorMessage && (
        <p className="text-sm text-destructive mt-3" role="alert">
          {errorMessage}
        </p>
      )}
    </>
  );
}
