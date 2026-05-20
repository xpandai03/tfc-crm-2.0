/**
 * Assign Provider Modal
 *
 * Lets admins assign a provider to a contact with an optional comment.
 * Provider can be selected from dropdown or entered manually.
 * CRM-only — does NOT write to Excel or trigger external workflows.
 */

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserPlus } from "lucide-react";

interface EmailConfigProvider {
  name: string;
  credentials: string;
  email: string;
}

interface AssignProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  contact: { contactId: number; name: string } | null;
  userEmail: string;
  authorInitials: string;
  onAssigned: () => void;
}

export function AssignProviderModal({
  isOpen,
  onClose,
  contact,
  userEmail,
  authorInitials,
  onAssigned,
}: AssignProviderModalProps) {
  const [mode, setMode] = useState<"dropdown" | "manual">("dropdown");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualCredential, setManualCredential] = useState("");
  const [comment, setComment] = useState("");
  const [providers, setProviders] = useState<EmailConfigProvider[]>([]);
  // name → effective accepting count, sourced from /api/providers (same as
  // the Providers page). Display-only; a name with no entry shows no count.
  const [acceptingCounts, setAcceptingCounts] = useState<Record<string, number>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch provider list when modal opens
  useEffect(() => {
    if (isOpen && providers.length === 0) {
      fetch("/api/email-config", { credentials: "include" })
        .then((res) => res.json())
        .then((data) => setProviders(data.providers || []))
        .catch((err) => console.error("Failed to fetch providers:", err));

      // Accepting counts come from /api/providers (the Providers page
      // source). Best-effort: if this fails, the dropdown simply shows no
      // counts — the assign flow is unaffected.
      fetch("/api/providers", { credentials: "include" })
        .then((res) => res.json())
        .then((data) => {
          const counts: Record<string, number> = {};
          for (const p of data.providers || []) {
            const count = p.effectiveAcceptingClients ?? p.acceptingClients;
            if (typeof p.name === "string" && typeof count === "number") {
              counts[p.name.trim()] = count;
            }
          }
          setAcceptingCounts(counts);
        })
        .catch((err) => console.error("Failed to fetch accepting counts:", err));
    }
  }, [isOpen]);

  // Parenthetical accepting-count suffix for a dropdown row. Empty string
  // when the provider has no availability data.
  const acceptingLabel = (name: string): string => {
    const count = acceptingCounts[name.trim()];
    if (count === undefined) return "";
    if (count === 0) return " (not accepting new patients)";
    return ` (${count} new patient${count === 1 ? "" : "s"})`;
  };

  const resetForm = () => {
    setMode("dropdown");
    setSelectedProvider("");
    setManualName("");
    setManualCredential("");
    setComment("");
    setError(null);
    setIsSubmitting(false);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const getProviderDetails = (): { name: string; credential: string } | null => {
    if (mode === "dropdown") {
      const provider = providers.find((p) => p.name === selectedProvider);
      if (!provider) return null;
      return { name: provider.name, credential: provider.credentials };
    }
    if (!manualName.trim() || !manualCredential.trim()) return null;
    return { name: manualName.trim(), credential: manualCredential.trim() };
  };

  const isValid = getProviderDetails() !== null;

  const handleSubmit = async () => {
    if (!contact || !isValid) return;

    const details = getProviderDetails()!;
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          contactId: contact.contactId,
          contactName: contact.name,
          providerName: details.name,
          credential: details.credential,
          assignmentComment: comment.trim() || undefined,
          assignedByEmail: userEmail,
          assignedByInitials: authorInitials,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to assign provider");
      }

      onAssigned();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign provider");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Assign Provider
          </DialogTitle>
          <DialogDescription>
            Assign a provider to {contact?.name || "this contact"}.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <Button
              variant={mode === "dropdown" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("dropdown")}
            >
              Select Provider
            </Button>
            <Button
              variant={mode === "manual" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("manual")}
            >
              Manual Entry
            </Button>
          </div>

          {mode === "dropdown" ? (
            <div className="space-y-1.5">
              <Label htmlFor="provider-select">Provider</Label>
              <Select value={selectedProvider} onValueChange={setSelectedProvider}>
                <SelectTrigger id="provider-select">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent className="max-h-[240px]">
                  {providers.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.name} — {p.credentials}{acceptingLabel(p.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="manual-name">Provider Name</Label>
                <Input
                  id="manual-name"
                  placeholder="e.g. Jane Smith"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="manual-credential">Credential</Label>
                <Input
                  id="manual-credential"
                  placeholder="e.g. LMHC, LCSW, LPCC"
                  value={manualCredential}
                  onChange={(e) => setManualCredential(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="assignment-comment">Assignment Comment (optional)</Label>
            <Textarea
              id="assignment-comment"
              placeholder="Reason for assignment, notes, preferences..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="min-h-[80px] resize-none"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isSubmitting}>
            {isSubmitting ? "Assigning..." : "Assign Provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
