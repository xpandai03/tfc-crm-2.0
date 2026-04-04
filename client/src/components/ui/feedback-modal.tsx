/**
 * Feedback Modal
 *
 * Allows users to submit bug reports or feedback with optional screenshot.
 * Sends email to admin + confirmation to user via backend.
 */

import { useState, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ImagePlus, X, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface FeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  userEmail: string;
}

export function FeedbackModal({ isOpen, onClose, userEmail }: FeedbackModalProps) {
  const [comment, setComment] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setComment("");
    setScreenshot(null);
    setPreviewUrl(null);
    setError(null);
    setSuccess(false);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please upload an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Screenshot must be under 5MB");
      return;
    }
    setScreenshot(file);
    setPreviewUrl(URL.createObjectURL(file));
    setError(null);
  };

  const removeScreenshot = () => {
    setScreenshot(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) {
      if (file.size > 5 * 1024 * 1024) {
        setError("Screenshot must be under 5MB");
        return;
      }
      setScreenshot(file);
      setPreviewUrl(URL.createObjectURL(file));
      setError(null);
    }
  }, []);

  const handleSubmit = async () => {
    if (!comment.trim()) {
      setError("Please add a comment describing your feedback");
      return;
    }

    setIsSending(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("comment", comment.trim());
      formData.append("context", JSON.stringify({
        userEmail,
        pageUrl: window.location.href,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
      }));
      if (screenshot) {
        formData.append("screenshot", screenshot);
      }

      const res = await fetch("/api/feedback", {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed (${res.status})`);
      }

      setSuccess(true);
      setTimeout(() => {
        handleClose();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send feedback");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
        </DialogHeader>

        {success ? (
          <div className="flex flex-col items-center py-6 gap-3">
            <CheckCircle2 className="h-10 w-10 text-green-500" />
            <p className="text-sm font-medium text-foreground">Feedback sent!</p>
            <p className="text-xs text-muted-foreground">Thank you - we'll look into it.</p>
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            {/* Comment */}
            <div>
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="What went wrong or what feedback do you have?"
                className="min-h-[100px] text-sm"
                autoFocus
              />
            </div>

            {/* Screenshot */}
            {!screenshot ? (
              <div
                className={cn(
                  "border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors",
                  "hover:border-primary/50 hover:bg-muted/30",
                  "border-border"
                )}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
              >
                <ImagePlus className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
                <p className="text-xs text-muted-foreground">
                  Click or drag to add a screenshot (optional)
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
            ) : (
              <div className="relative rounded-lg overflow-hidden border">
                <img
                  src={previewUrl!}
                  alt="Screenshot preview"
                  className="w-full max-h-40 object-cover"
                />
                <button
                  onClick={removeScreenshot}
                  className="absolute top-1.5 right-1.5 bg-black/60 text-white rounded-full p-1 hover:bg-black/80"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* Context info */}
            <p className="text-[10px] text-muted-foreground">
              Sending as {userEmail} from {window.location.pathname}
            </p>

            {error && (
              <Alert variant="destructive">
                <AlertDescription className="text-xs">{error}</AlertDescription>
              </Alert>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={handleClose} disabled={isSending}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={isSending || !comment.trim()}>
                {isSending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Send Feedback
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
