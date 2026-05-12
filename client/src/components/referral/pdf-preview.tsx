import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";

interface PdfPreviewProps {
  file: File;
}

export function PdfPreview({ file }: PdfPreviewProps) {
  const [renderError, setRenderError] = useState(false);

  const objectUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => {
    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  if (renderError) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] p-8 text-center bg-muted/30 rounded-md border border-dashed">
        <FileText className="h-10 w-10 text-muted-foreground/50 mb-3" />
        <p className="text-sm font-medium">{file.name}</p>
        <p className="text-xs text-muted-foreground mt-2 max-w-xs">
          PDF preview not available in this browser — please reference your original file.
        </p>
      </div>
    );
  }

  return (
    <iframe
      src={objectUrl}
      className="w-full h-full min-h-[calc(100vh-12rem)] rounded-md border bg-white"
      title="Referral PDF"
      onError={() => setRenderError(true)}
    />
  );
}
