import { useCallback, useState } from "react";
import { Redirect } from "wouter";
import { PageLayout } from "@/components/layout/page-layout";
import { UploadZone } from "@/components/referral/upload-zone";
import { ReviewForm, type ReferralFormState } from "@/components/referral/review-form";
import { PdfPreview } from "@/components/referral/pdf-preview";
import { useAuth } from "@/lib/auth-context";
import { canAccessReferralUpload } from "@shared/access-control";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
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

interface ExtractedData {
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  phone: string | null;
  email: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  gender: string | null;
  reasonForSeeking: string | null;
  reasonForTherapy: string | null;
  diagnosis: string | null;
  insurancePayer: string | null;
  referralSource: string | null;
  referringProvider: string | null;
  referralAuth: string | null;
}

// No default modality. "Fax Referral (For staff use only)" used to be prefilled
// here, which meant every faxed referral was recorded with the intake CHANNEL
// in place of a modality and vanished from location planning. Staff must now
// pick where the client wants to be seen; the review form blocks submit until
// they do. The fax origin is still captured via intake_source.
const DEFAULT_MODALITY = "";
const DEFAULT_REQUESTING_FOR = "Myself";

function emptyForm(): ReferralFormState {
  return {
    firstName: "",
    lastName: "",
    dateOfBirth: "",
    phone: "",
    email: "",
    streetAddress: "",
    city: "",
    state: "",
    zipCode: "",
    gender: "",
    reasonForSeeking: "",
    reasonForTherapy: "",
    diagnosis: "",
    insurancePayer: "",
    referralSource: "",
    referringProvider: "",
    referralAuth: "",
    requestingFor: DEFAULT_REQUESTING_FOR,
    modality: DEFAULT_MODALITY,
    formCompletedBy: "",
  };
}

function applyExtraction(extracted: ExtractedData, staffName: string): ReferralFormState {
  return {
    firstName: extracted.firstName ?? "",
    lastName: extracted.lastName ?? "",
    dateOfBirth: extracted.dateOfBirth ?? "",
    phone: extracted.phone ?? "",
    email: extracted.email ?? "",
    streetAddress: extracted.streetAddress ?? "",
    city: extracted.city ?? "",
    state: extracted.state ?? "",
    zipCode: extracted.zipCode ?? "",
    gender: extracted.gender ?? "",
    reasonForSeeking: extracted.reasonForSeeking ?? "",
    reasonForTherapy: extracted.reasonForTherapy ?? "",
    diagnosis: extracted.diagnosis ?? "",
    insurancePayer: extracted.insurancePayer ?? "",
    referralSource: extracted.referralSource ?? "",
    referringProvider: extracted.referringProvider ?? "",
    referralAuth: extracted.referralAuth ?? "",
    requestingFor: DEFAULT_REQUESTING_FOR,
    modality: DEFAULT_MODALITY,
    formCompletedBy: staffName,
  };
}

export default function Referral() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [formState, setFormState] = useState<ReferralFormState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Access gate — unauthorized users are redirected away
  if (!canAccessReferralUpload(user?.email)) {
    return <Redirect to="/waitlist" replace />;
  }

  const reset = useCallback(() => {
    setFile(null);
    setFormState(null);
    setIsProcessing(false);
    setIsSubmitting(false);
  }, []);

  const handleProcess = useCallback(async () => {
    if (!file) return;
    setIsProcessing(true);
    try {
      const fd = new FormData();
      fd.append("pdf", file);
      const res = await fetch("/api/referral/extract", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) {
        let message = "Failed to process the referral PDF. Please try again.";
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          /* ignore */
        }
        toast({
          title: "Extraction failed",
          description: message,
          variant: "destructive",
        });
        setIsProcessing(false);
        return;
      }
      const extracted: ExtractedData = await res.json();
      setFormState(applyExtraction(extracted, user?.name ?? ""));
      setIsProcessing(false);
    } catch (err) {
      toast({
        title: "Extraction failed",
        description: (err as Error).message || "Network error. Please try again.",
        variant: "destructive",
      });
      setIsProcessing(false);
    }
  }, [file, toast, user?.name]);

  const handleSubmit = useCallback(async () => {
    if (!formState) return;
    setIsSubmitting(true);
    try {
      const payload = {
        source: "uploaded_referral",
        name: `${formState.firstName.trim()} ${formState.lastName.trim()}`.trim(),
        firstName: formState.firstName.trim(),
        lastName: formState.lastName.trim(),
        email: formState.email.trim() || null,
        phone: formState.phone.trim() || null,
        patientDob: formState.dateOfBirth || null,
        gender: formState.gender || null,
        streetAddress: formState.streetAddress.trim() || null,
        city: formState.city.trim() || null,
        state: formState.state.trim() || null,
        zipCode: formState.zipCode.trim() || null,
        reasonForSeeking: formState.reasonForSeeking.trim() || null,
        reasonForTherapy: formState.reasonForTherapy.trim() || null,
        detailedReason: formState.diagnosis.trim() || null,
        insurancePayer: formState.insurancePayer.trim() || null,
        referralSource: formState.referralSource.trim() || null,
        priorProvider: formState.referringProvider.trim() || null,
        referralAuth: formState.referralAuth.trim() || null,
        requestingFor: formState.requestingFor || DEFAULT_REQUESTING_FOR,
        // This surface is single-select (one fax, one modality), so the chosen
        // value IS the first priority. Sent as both so the legacy string and the
        // priority columns stay coherent; the endpoint would derive p1 anyway,
        // but sending it explicitly keeps the intent obvious.
        modality: formState.modality || null,
        modalityP1: formState.modality || null,
        formCompletedBy: formState.formCompletedBy.trim() || user?.name || "",
      };

      const res = await fetch("/api/intake", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let message = "Failed to create contact. Please try again.";
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          /* ignore */
        }
        toast({
          title: "Could not create contact",
          description: message,
          variant: "destructive",
        });
        setIsSubmitting(false);
        return;
      }
      const { contactId } = await res.json();
      toast({
        title: "Contact created",
        description: `${payload.name} · Ready to upload the next referral.`,
        action: (
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`/contact/${contactId}`, "_blank", "noopener,noreferrer")}
          >
            View Contact →
          </Button>
        ),
      });
      reset();
    } catch (err) {
      toast({
        title: "Could not create contact",
        description: (err as Error).message || "Network error. Please try again.",
        variant: "destructive",
      });
      setIsSubmitting(false);
    }
  }, [formState, toast, user?.name, reset]);

  const inReviewState = file !== null && formState !== null;

  return (
    <PageLayout>
      {inReviewState ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-[1400px] mx-auto">
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold tracking-tight">Review extracted data</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Cross-reference the form below against the PDF on the right. Edit any fields that need correction.
              </p>
            </div>
            <ReviewForm
              value={formState}
              onChange={setFormState}
              onSubmit={handleSubmit}
              onStartOver={() => setConfirmReset(true)}
              isSubmitting={isSubmitting}
            />
          </div>
          <div className="lg:sticky lg:top-20 lg:self-start">
            <PdfPreview file={file!} />
          </div>
        </div>
      ) : (
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">Upload Referral</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Upload a fax referral PDF to automatically create a new contact record.
            </p>
          </div>
          <UploadZone
            file={file}
            onFileSelected={setFile}
            onFileCleared={() => setFile(null)}
            onProcess={handleProcess}
            isProcessing={isProcessing}
          />
        </div>
      )}

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start over?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear the current referral and return to the upload screen. Any edits will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                reset();
                setConfirmReset(false);
              }}
            >
              Start over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}
