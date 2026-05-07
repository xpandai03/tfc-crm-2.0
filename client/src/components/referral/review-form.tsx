import { useCallback, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";
import { REASON_CANONICALS } from "@shared/reason-canonicals";

export interface ReferralFormState {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phone: string;
  email: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  gender: string;
  reasonForSeeking: string;
  reasonForTherapy: string;
  diagnosis: string;
  insurancePayer: string;
  referralSource: string;
  referringProvider: string;
  referralAuth: string;
  requestingFor: string;
  modality: string;
  formCompletedBy: string;
}

interface ReviewFormProps {
  value: ReferralFormState;
  onChange: (next: ReferralFormState) => void;
  onSubmit: () => void;
  onStartOver: () => void;
  isSubmitting: boolean;
}

const REQUESTING_FOR_OPTIONS = [
  "Myself",
  "My Child",
  "My Partner & Myself",
  "My Family",
  "Other",
];

const MODALITY_OPTIONS = [
  "Fax Referral (For staff use only)",
  "In Person - Albuquerque",
  "In Person - Los Lunas",
  "In Person - Rio Rancho",
  "Virtual",
  "Either",
];

const GENDER_OPTIONS = [
  { value: "Male", label: "Male" },
  { value: "Female", label: "Female" },
];

type FieldKey = keyof ReferralFormState;

function labelFor(key: FieldKey): string {
  const map: Record<FieldKey, string> = {
    firstName: "First Name",
    lastName: "Last Name",
    dateOfBirth: "Date of Birth",
    phone: "Phone",
    email: "Email",
    streetAddress: "Street Address",
    city: "City",
    state: "State",
    zipCode: "Zip Code",
    gender: "Gender",
    reasonForSeeking: "Reason for Seeking",
    reasonForTherapy: "Reason for Therapy",
    diagnosis: "Diagnosis",
    insurancePayer: "Insurance Payer",
    referralSource: "Referral Source",
    referringProvider: "Referring Provider",
    referralAuth: "Referral / Auth Number",
    requestingFor: "Requesting For",
    modality: "Modality",
    formCompletedBy: "Form Completed By",
  };
  return map[key];
}

/**
 * Parse a comma-separated reasonForTherapy string into selected canonicals
 * + an Other free-text string.
 *
 *   - Canonical values (in REASON_CANONICALS) → added to `selected`.
 *   - "Other: <text>" → "Other" added to `selected`, text → `otherText`.
 *   - "Other (legacy free-text)" → "Other" added, no `otherText`.
 *   - Any other unknown token → silently dropped (manual edits via this
 *     form are expected to clean as they go).
 */
function parseReasonForTherapy(raw: string): { selected: Set<string>; otherText: string } {
  const selected = new Set<string>();
  let otherText = "";
  if (!raw || !raw.trim()) return { selected, otherText };
  const canonicalSet = new Set<string>(REASON_CANONICALS);
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (!t) continue;
    if (canonicalSet.has(t)) {
      selected.add(t);
    } else if (t.startsWith("Other:")) {
      selected.add("Other");
      otherText = t.slice("Other:".length).trim();
    } else if (t === "Other (legacy free-text)" || t === "Other") {
      selected.add("Other");
    }
    // else: drop unknown
  }
  return { selected, otherText };
}

function serializeReasonForTherapy(selected: Set<string>, otherText: string): string {
  const parts: string[] = [];
  for (const canon of REASON_CANONICALS) {
    if (selected.has(canon)) parts.push(canon);
  }
  if (selected.has("Other")) {
    const t = otherText.trim();
    parts.push(t ? `Other: ${t}` : "Other (legacy free-text)");
  }
  return parts.join(", ");
}

/**
 * Multi-select dropdown for reasonForTherapy. Replaces the previous
 * free-text Input (Bucket A — prevents new pollution going forward).
 *
 * Shape contract: receives + emits a single comma-separated string so
 * callers don't need to change their state shape.
 */
function ReasonForTherapyMultiSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { selected, otherText } = useMemo(() => parseReasonForTherapy(value), [value]);

  const toggle = (option: string) => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(serializeReasonForTherapy(next, otherText));
  };

  const updateOtherText = (text: string) => {
    const next = new Set(selected);
    next.add("Other");
    onChange(serializeReasonForTherapy(next, text));
  };

  const display =
    selected.size === 0
      ? "Select reasons…"
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between font-normal"
          data-testid="trigger-reasonForTherapy"
        >
          <span className="truncate">{display}</span>
          <ChevronDown className="h-4 w-4 ml-2 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-h-96 overflow-y-auto p-3">
        <div className="space-y-2">
          {REASON_CANONICALS.map((opt) => (
            <label
              key={opt}
              className="flex items-center gap-2 cursor-pointer hover:bg-accent rounded px-1 py-0.5"
            >
              <Checkbox
                checked={selected.has(opt)}
                onCheckedChange={() => toggle(opt)}
                data-testid={`checkbox-reason-${opt}`}
              />
              <span className="text-sm">{opt}</span>
            </label>
          ))}
          <div className="pt-2 border-t">
            <label className="flex items-center gap-2 cursor-pointer hover:bg-accent rounded px-1 py-0.5">
              <Checkbox
                checked={selected.has("Other")}
                onCheckedChange={() => toggle("Other")}
                data-testid="checkbox-reason-Other"
              />
              <span className="text-sm">Other</span>
            </label>
            {selected.has("Other") && (
              <Input
                value={otherText}
                onChange={(e) => updateOtherText(e.target.value)}
                placeholder="Describe (free text)"
                className="mt-2 h-8 text-sm"
                data-testid="input-reasonForTherapy-other"
              />
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ReviewForm({ value, onChange, onSubmit, onStartOver, isSubmitting }: ReviewFormProps) {
  const set = useCallback(
    <K extends FieldKey>(key: K, next: ReferralFormState[K]) => {
      onChange({ ...value, [key]: next });
    },
    [value, onChange],
  );

  const isValid = useMemo(() => {
    return value.firstName.trim().length > 0 && value.lastName.trim().length > 0;
  }, [value.firstName, value.lastName]);

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (isValid && !isSubmitting) onSubmit();
      }}
    >
      <Section title="Patient">
        <div className="grid grid-cols-2 gap-3">
          <Field label={labelFor("firstName")} required>
            <Input
              value={value.firstName}
              onChange={(e) => set("firstName", e.target.value)}
              data-testid="input-firstName"
            />
          </Field>
          <Field label={labelFor("lastName")} required>
            <Input
              value={value.lastName}
              onChange={(e) => set("lastName", e.target.value)}
              data-testid="input-lastName"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={labelFor("dateOfBirth")}>
            <Input
              type="date"
              value={value.dateOfBirth}
              onChange={(e) => set("dateOfBirth", e.target.value)}
              data-testid="input-dateOfBirth"
            />
          </Field>
          <Field label={labelFor("gender")}>
            <Select
              value={value.gender || "unspecified"}
              onValueChange={(v) => set("gender", v === "unspecified" ? "" : v)}
            >
              <SelectTrigger data-testid="select-gender">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unspecified">Not specified</SelectItem>
                {GENDER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={labelFor("phone")} hint="Digits only">
            <Input
              inputMode="tel"
              value={value.phone}
              onChange={(e) => set("phone", e.target.value)}
              data-testid="input-phone"
            />
          </Field>
          <Field label={labelFor("email")}>
            <Input
              type="email"
              value={value.email}
              onChange={(e) => set("email", e.target.value)}
              data-testid="input-email"
            />
          </Field>
        </div>
      </Section>

      <Section title="Address">
        <Field label={labelFor("streetAddress")}>
          <Input
            value={value.streetAddress}
            onChange={(e) => set("streetAddress", e.target.value)}
            data-testid="input-streetAddress"
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={labelFor("city")}>
            <Input
              value={value.city}
              onChange={(e) => set("city", e.target.value)}
              data-testid="input-city"
            />
          </Field>
          <Field label={labelFor("state")}>
            <Input
              value={value.state}
              onChange={(e) => set("state", e.target.value)}
              data-testid="input-state"
            />
          </Field>
          <Field label={labelFor("zipCode")}>
            <Input
              value={value.zipCode}
              onChange={(e) => set("zipCode", e.target.value)}
              data-testid="input-zipCode"
            />
          </Field>
        </div>
      </Section>

      <Section title="Clinical">
        <Field label={labelFor("reasonForSeeking")}>
          <Input
            value={value.reasonForSeeking}
            onChange={(e) => set("reasonForSeeking", e.target.value)}
            data-testid="input-reasonForSeeking"
          />
        </Field>
        <Field label={labelFor("reasonForTherapy")}>
          <ReasonForTherapyMultiSelect
            value={value.reasonForTherapy}
            onChange={(next) => set("reasonForTherapy", next)}
          />
        </Field>
        <Field label={labelFor("diagnosis")}>
          <Input
            value={value.diagnosis}
            onChange={(e) => set("diagnosis", e.target.value)}
            data-testid="input-diagnosis"
          />
        </Field>
      </Section>

      <Section title="Referral">
        <div className="grid grid-cols-2 gap-3">
          <Field label={labelFor("insurancePayer")}>
            <Input
              value={value.insurancePayer}
              onChange={(e) => set("insurancePayer", e.target.value)}
              data-testid="input-insurancePayer"
            />
          </Field>
          <Field label={labelFor("referralSource")}>
            <Input
              value={value.referralSource}
              onChange={(e) => set("referralSource", e.target.value)}
              data-testid="input-referralSource"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={labelFor("referringProvider")}>
            <Input
              value={value.referringProvider}
              onChange={(e) => set("referringProvider", e.target.value)}
              data-testid="input-referringProvider"
            />
          </Field>
          <Field label={labelFor("referralAuth")}>
            <Input
              value={value.referralAuth}
              onChange={(e) => set("referralAuth", e.target.value)}
              data-testid="input-referralAuth"
            />
          </Field>
        </div>
      </Section>

      <Section title="Intake details">
        <div className="grid grid-cols-2 gap-3">
          <Field label={labelFor("requestingFor")}>
            <Select
              value={value.requestingFor || "Myself"}
              onValueChange={(v) => set("requestingFor", v)}
            >
              <SelectTrigger data-testid="select-requestingFor">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REQUESTING_FOR_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={labelFor("modality")}>
            <Select
              value={value.modality || MODALITY_OPTIONS[0]}
              onValueChange={(v) => set("modality", v)}
            >
              <SelectTrigger data-testid="select-modality">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODALITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label={labelFor("formCompletedBy")}>
          <Input
            value={value.formCompletedBy}
            onChange={(e) => set("formCompletedBy", e.target.value)}
            data-testid="input-formCompletedBy"
          />
        </Field>
      </Section>

      <div className="flex justify-end gap-2 pt-2 border-t sticky bottom-0 bg-background/95 backdrop-blur-sm py-3 -mx-4 px-4">
        <Button
          type="button"
          variant="outline"
          onClick={onStartOver}
          disabled={isSubmitting}
          data-testid="button-start-over"
        >
          Start Over
        </Button>
        <Button
          type="submit"
          disabled={!isValid || isSubmitting}
          data-testid="button-create-contact"
        >
          {isSubmitting ? "Creating…" : "Create Contact"}
        </Button>
      </div>
      {!isValid && (
        <p className="text-xs text-muted-foreground text-right">
          First and last name are required.
        </p>
      )}
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
        {hint && <span className="text-muted-foreground font-normal ml-2">{hint}</span>}
      </Label>
      {children}
    </div>
  );
}
