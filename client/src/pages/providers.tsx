import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "@/components/layout/page-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageLoader } from "@/components/ui/page-loader";
import { AlertCircle, MapPin, FileText, Shield, Users, Plus, Pencil, Loader2, Check, X, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState, useMemo, useRef, useEffect } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  getProviderInsurances,
  hasProviderInsuranceData,
  PROVIDERS_WITHOUT_INSURANCE_DATA,
} from "@/lib/provider-insurance-data";
import type { InsuranceCategory } from "@/lib/insurance-utils";
import { transformApiProvider, type ProviderWithInsurance } from "@/lib/provider-api";
import { PatientMatchingModal } from "@/components/ui/patient-matching-modal";

/**
 * Provider data structure from the spreadsheet
 * All values are preserved exactly as they appear in Excel
 */
interface Provider {
  id: number;
  nameWithCredentials: string;
  name: string;
  credentials: string;
  location: string;
  ageGroups: {
    "Adults (18+)": Record<string, string>;
    "Adolescents (12-17)": Record<string, string>;
    "Children (6-11)": Record<string, string>;
    "Children (0-5)": Record<string, string>;
  };
  notes: string;
  // CRM-managed provider fields
  _crmManaged?: boolean;
  crmId?: number;
  specialties?: string[];
  crmAgeGroups?: string[];
  insurances?: string[];
  // Override fields (spreadsheet providers with CRM edits)
  _hasOverrides?: boolean;
  _overrideSpecialties?: string[];
  _overrideInsurances?: string[];
  _overridePopulations?: string[];
  _overrideNotes?: string;
}

interface ProvidersResponse {
  providers: Provider[];
  _source: string;
  lastModified?: string;
}

async function getProviders(): Promise<ProvidersResponse> {
  const response = await fetch("/api/providers");
  if (!response.ok) {
    throw new Error(`Failed to fetch providers: ${response.status}`);
  }
  return response.json();
}

/**
 * Render a capability value with appropriate styling
 * Preserves raw values: "x", "x - Slow", "Slow", etc.
 */
function CapabilityBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase().trim();

  // Determine badge variant based on value
  let variant: "default" | "secondary" | "outline" = "default";
  if (normalized.includes("slow")) {
    variant = "secondary";
  } else if (normalized === "x" || normalized === "x ") {
    variant = "default";
  }

  return (
    <Badge
      variant={variant}
      className={
        normalized.includes("slow")
          ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800"
          : "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800"
      }
    >
      {value}
    </Badge>
  );
}

/**
 * Insurance badges section
 * Shows accepted insurances as compact chips
 */
function InsuranceSection({ providerName }: { providerName: string }) {
  const insurances = getProviderInsurances(providerName);
  const hasData = hasProviderInsuranceData(providerName);

  if (!hasData) {
    // Provider not in snapshot - show fallback indicator
    const isMissingFromSnapshot = PROVIDERS_WITHOUT_INSURANCE_DATA.includes(providerName);
    return (
      <div className="pt-3 border-t">
        <div className="flex items-start gap-2">
          <Shield className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Accepted Insurances
            </p>
            <p className="text-xs text-muted-foreground italic">
              {isMissingFromSnapshot
                ? "Insurance data pending (uses clinic defaults)"
                : "No insurance data available"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!insurances || insurances.length === 0) {
    return null;
  }

  // Sort insurances alphabetically for consistent display
  const sortedInsurances = [...insurances].sort((a, b) => a.localeCompare(b));

  return (
    <div className="pt-3 border-t">
      <div className="flex items-start gap-2">
        <Shield className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
            Accepted Insurances ({insurances.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {sortedInsurances.map((insurance) => (
              <Badge
                key={insurance}
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-5 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800"
              >
                {insurance}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Age group section showing specialties
 */
function AgeGroupSection({
  label,
  capabilities
}: {
  label: string;
  capabilities: Record<string, string>;
}) {
  const entries = Object.entries(capabilities);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([specialty, value]) => (
          <div key={specialty} className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">{specialty}:</span>
            <CapabilityBadge value={value} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Provider card component
 */
function ProviderCard({ provider, onFindPatients, onEdit }: { provider: Provider; onFindPatients: () => void; onEdit: () => void }) {
  const hasAnyCapabilities =
    Object.keys(provider.ageGroups["Adults (18+)"]).length > 0 ||
    Object.keys(provider.ageGroups["Adolescents (12-17)"]).length > 0 ||
    Object.keys(provider.ageGroups["Children (6-11)"]).length > 0 ||
    Object.keys(provider.ageGroups["Children (0-5)"]).length > 0;

  const hasAnySpecialtyData = hasAnyCapabilities || !!provider.notes;

  // CRM override data (additional specialties, insurances, populations, notes)
  const overrideSpecialties = provider._overrideSpecialties || provider.specialties || [];
  const overrideInsurances = provider._overrideInsurances || [];
  const overridePopulations = provider._overridePopulations || provider.crmAgeGroups || [];
  const overrideNotes = provider._overrideNotes ?? null;
  const displayNotes = overrideNotes !== null ? overrideNotes : provider.notes;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold">
              {provider.name}
            </CardTitle>
            {provider.credentials && (
              <p className="text-sm text-muted-foreground mt-0.5">
                {provider.name === "Bentley Carbone" ? "LAMFT" : provider.credentials}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {provider.location && (
              <Badge variant="outline" className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {provider.location}
              </Badge>
            )}
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasAnyCapabilities && (
          <>
            <AgeGroupSection
              label="Adults (18+)"
              capabilities={provider.ageGroups["Adults (18+)"]}
            />
            <AgeGroupSection
              label="Adolescents (12-17)"
              capabilities={provider.ageGroups["Adolescents (12-17)"]}
            />
            <AgeGroupSection
              label="Children (6-11)"
              capabilities={provider.ageGroups["Children (6-11)"]}
            />
            <AgeGroupSection
              label="Children (0-5)"
              capabilities={provider.ageGroups["Children (0-5)"]}
            />
          </>
        )}
        {!hasAnySpecialtyData && overrideSpecialties.length === 0 && (
          <p className="text-sm text-muted-foreground italic">No specialty data</p>
        )}

        {/* CRM override specialties */}
        {overrideSpecialties.length > 0 && (
          <div className="pt-2 border-t">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Specialties
            </p>
            <div className="flex flex-wrap gap-1">
              {overrideSpecialties.map((s: string) => (
                <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>
              ))}
            </div>
          </div>
        )}

        {/* CRM override populations */}
        {overridePopulations.length > 0 && (
          <div className="pt-2 border-t">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Populations
            </p>
            <div className="flex flex-wrap gap-1">
              {overridePopulations.map((p: string) => (
                <Badge key={p} variant="outline" className="text-xs">{p}</Badge>
              ))}
            </div>
          </div>
        )}

        {displayNotes && (
          <div className="pt-2 border-t">
            <div className="flex items-start gap-2">
              <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-sm text-muted-foreground">{displayNotes}</p>
            </div>
          </div>
        )}

        {/* Accepted Insurances: CRM overrides take priority over snapshot */}
        {overrideInsurances.length > 0 ? (
          <div className="pt-3 border-t">
            <div className="flex items-start gap-2">
              <Shield className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                  Accepted Insurances ({overrideInsurances.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {[...overrideInsurances].sort().map((ins: string) => (
                    <Badge
                      key={ins}
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 h-5 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800"
                    >
                      {ins}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <InsuranceSection providerName={provider.name} />
        )}

        {/* Find Matching Patients */}
        <div className="pt-3 border-t">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={!hasAnySpecialtyData && overrideSpecialties.length === 0}
            title={!hasAnySpecialtyData && overrideSpecialties.length === 0 ? "Provider must have specialties configured to enable matching" : undefined}
            onClick={(e) => {
              e.preventDefault();
              onFindPatients();
            }}
          >
            <Users className="h-4 w-4 mr-2" />
            Find Matching Patients
          </Button>
          {!hasAnySpecialtyData && overrideSpecialties.length === 0 && (
            <p className="text-xs text-muted-foreground mt-1.5 text-center">
              Matching unavailable — no specialty data configured
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Specialty & Insurance definitions (match spreadsheet structure)
// ============================================================================

type CapState = "" | "x" | "x - Slow";
const CAP_CYCLE: CapState[] = ["", "x", "x - Slow"];

const AGE_GROUP_SPECIALTIES: Record<string, string[]> = {
  "Adults (18+)": ["Anger Issues", "Anxiety", "Couples", "Depression", "Family", "Grief", "Trauma", "Stress Management"],
  "Adolescents (12-17)": ["Anger Issues", "Anxiety", "Depression", "Family", "Grief", "Trauma", "Stress Management"],
  "Children (6-11)": ["Anger Issues", "Anxiety", "Depression", "Family", "Grief", "Trauma", "Stress Management"],
  "Children (0-5)": ["Anxiety", "Depression", "Family", "Grief", "Trauma"],
};

const ALL_INSURANCES = [
  "Aetna",
  "BlueCross BlueShield Commercial",
  "BlueCross BlueShield Turquoise Care",
  "Carelon",
  "ChampVA",
  "ComPsych",
  "Medicare",
  "Molina",
  "Partners Direct Health",
  "Presbyterian Commercial",
  "Presbyterian Turquoise Care",
  "Tricare",
  "UHC Centennial",
  "UHC Commercial",
  "VACCN",
];

// ============================================================================
// Interactive Chip Components
// ============================================================================

/** Clickable specialty chip: cycles through empty → x → x - Slow → empty */
function SpecialtyChip({ specialty, value, onCycle }: {
  specialty: string;
  value: CapState;
  onCycle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCycle}
      className="flex items-center gap-1 group"
    >
      <span className="text-xs text-muted-foreground">{specialty}:</span>
      <span
        className={cn(
          "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium transition-all cursor-pointer select-none",
          value === "x" && "bg-green-100 text-green-800 border border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
          value === "x - Slow" && "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800",
          value === "" && "bg-gray-100 text-gray-400 border border-dashed border-gray-300 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-600",
        )}
      >
        {value || "—"}
      </span>
    </button>
  );
}

/** Toggleable insurance chip */
function InsuranceChip({ name, selected, onToggle }: {
  name: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-all cursor-pointer select-none border",
        selected
          ? "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800"
          : "bg-gray-50 text-gray-400 border-dashed border-gray-300 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-600",
      )}
    >
      {selected && <Check className="h-3 w-3" />}
      {name}
    </button>
  );
}

// ============================================================================
// Provider Edit Modal (card-mirrored layout)
// ============================================================================

/** Internal state for the edit form */
interface EditFormState {
  // CRM-only fields (for new providers)
  name: string;
  credentials: string;
  location: string;
  // Age-group capabilities: { "Adults (18+)": { "Anxiety": "x", "Trauma": "x - Slow" }, ... }
  ageGroupCaps: Record<string, Record<string, CapState>>;
  // Selected insurance names
  selectedInsurances: Set<string>;
  // Notes
  notes: string;
}

function buildInitialState(provider: Provider | null): EditFormState {
  if (!provider) {
    // New provider: everything empty
    const ageGroupCaps: Record<string, Record<string, CapState>> = {};
    for (const [group, specs] of Object.entries(AGE_GROUP_SPECIALTIES)) {
      ageGroupCaps[group] = {};
      for (const s of specs) ageGroupCaps[group][s] = "";
    }
    return { name: "", credentials: "", location: "", ageGroupCaps, selectedInsurances: new Set(), notes: "" };
  }

  // Build caps from provider's existing ageGroups data
  const ageGroupCaps: Record<string, Record<string, CapState>> = {};
  for (const [group, specs] of Object.entries(AGE_GROUP_SPECIALTIES)) {
    ageGroupCaps[group] = {};
    const existing = provider.ageGroups[group as keyof typeof provider.ageGroups] || {};
    for (const s of specs) {
      const raw = existing[s]?.toLowerCase().trim() || "";
      if (raw.includes("slow")) ageGroupCaps[group][s] = "x - Slow";
      else if (raw === "x" || raw === "x ") ageGroupCaps[group][s] = "x";
      else ageGroupCaps[group][s] = "";
    }
  }

  // Insurance: use overrides first, then snapshot
  const overrideInsurances = provider._overrideInsurances || provider.insurances || [];
  let insuranceSet: Set<string>;
  if (overrideInsurances.length > 0) {
    insuranceSet = new Set(overrideInsurances);
  } else {
    const snapshot = getProviderInsurances(provider.name);
    insuranceSet = snapshot ? new Set(snapshot) : new Set();
  }

  const overrideNotes = provider._overrideNotes;
  const notes = overrideNotes !== null && overrideNotes !== undefined ? overrideNotes : provider.notes || "";

  return {
    name: provider.name,
    credentials: provider.credentials || "",
    location: provider.location || "",
    ageGroupCaps,
    selectedInsurances: insuranceSet,
    notes,
  };
}

function ProviderFormModal({
  isOpen,
  onClose,
  editingProvider,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  editingProvider: Provider | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<EditFormState>(() => buildInitialState(null));
  const [isSaving, setIsSaving] = useState(false);
  const [insuranceSearch, setInsuranceSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const isEditing = !!editingProvider;
  const isCrmManaged = !!editingProvider?._crmManaged;
  const isSpreadsheetEdit = isEditing && !isCrmManaged;

  const resetForm = () => {
    setState(buildInitialState(editingProvider));
    setInsuranceSearch("");
  };

  // Cycle a specialty through empty → x → x - Slow → empty
  const cycleSpecialty = (group: string, specialty: string) => {
    setState(prev => {
      const current = prev.ageGroupCaps[group]?.[specialty] || "";
      const idx = CAP_CYCLE.indexOf(current as CapState);
      const next = CAP_CYCLE[(idx + 1) % CAP_CYCLE.length];
      return {
        ...prev,
        ageGroupCaps: {
          ...prev.ageGroupCaps,
          [group]: { ...prev.ageGroupCaps[group], [specialty]: next },
        },
      };
    });
  };

  // Toggle insurance selection
  const toggleInsurance = (name: string) => {
    setState(prev => {
      const next = new Set(prev.selectedInsurances);
      if (next.has(name)) next.delete(name); else next.add(name);
      return { ...prev, selectedInsurances: next };
    });
  };

  // Filter insurances by search
  const filteredInsurances = useMemo(() => {
    if (!insuranceSearch.trim()) return ALL_INSURANCES;
    const q = insuranceSearch.toLowerCase();
    return ALL_INSURANCES.filter(i => i.toLowerCase().includes(q));
  }, [insuranceSearch]);

  const handleSave = async () => {
    if (!isEditing && !state.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }

    setIsSaving(true);
    try {
      // Build ageGroups payload: reconstruct the ageGroups object with only non-empty caps
      const ageGroupsPayload: Record<string, Record<string, string>> = {};
      for (const [group, caps] of Object.entries(state.ageGroupCaps)) {
        ageGroupsPayload[group] = {};
        for (const [spec, val] of Object.entries(caps)) {
          if (val) ageGroupsPayload[group][spec] = val;
        }
      }

      const insurancesArr = [...state.selectedInsurances].sort();

      if (isEditing && editingProvider) {
        if (isCrmManaged && editingProvider.crmId) {
          // CRM-managed: send full payload
          const specialtiesArr = Object.values(state.ageGroupCaps)
            .flatMap(g => Object.entries(g).filter(([, v]) => v).map(([s]) => s));
          const uniqueSpecs = [...new Set(specialtiesArr)];
          await apiRequest("PATCH", `/api/providers/${editingProvider.crmId}`, {
            name: state.name.trim(),
            credentials: state.credentials.trim(),
            location: state.location.trim(),
            specialties: uniqueSpecs,
            ageGroups: [],
            insurances: insurancesArr,
            notes: state.notes.trim(),
          });
        } else {
          // Spreadsheet: save overrides (ageGroups are saved to the override endpoint)
          // We need to send the ageGroups capabilities back via the override route
          // For now, specialties/populations map from the chip selections
          const specialtiesArr = Object.values(state.ageGroupCaps)
            .flatMap(g => Object.entries(g).filter(([, v]) => v).map(([s]) => s));
          const uniqueSpecs = [...new Set(specialtiesArr)];
          await apiRequest("PATCH", "/api/providers/override", {
            providerName: editingProvider.name,
            specialties: uniqueSpecs,
            insurances: insurancesArr,
            populations: [],
            notes: state.notes.trim(),
            ageGroups: ageGroupsPayload,
          });
        }
        toast({ title: "Provider updated" });
      } else {
        // Create new CRM provider
        const specialtiesArr = Object.values(state.ageGroupCaps)
          .flatMap(g => Object.entries(g).filter(([, v]) => v).map(([s]) => s));
        const uniqueSpecs = [...new Set(specialtiesArr)];
        await apiRequest("POST", "/api/providers", {
          name: state.name.trim(),
          credentials: state.credentials.trim(),
          location: state.location.trim(),
          specialties: uniqueSpecs,
          ageGroups: [],
          insurances: insurancesArr,
          notes: state.notes.trim(),
        });
        toast({ title: "Provider created" });
      }

      onSaved();
      onClose();
    } catch (err) {
      toast({
        title: isEditing ? "Failed to update provider" : "Failed to create provider",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const selectedCount = state.selectedInsurances.size;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); else resetForm(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>
            {isEditing ? (
              <div>
                <span>{editingProvider?.name}</span>
                {editingProvider?.credentials && (
                  <span className="text-sm font-normal text-muted-foreground ml-2">
                    {editingProvider.name === "Bentley Carbone" ? "LAMFT" : editingProvider.credentials}
                  </span>
                )}
              </div>
            ) : "Add New Provider"}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-5 pb-4">
            {/* CRM-only: name/credentials/location */}
            {!isSpreadsheetEdit && !isEditing && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">Name *</Label>
                    <Input value={state.name} onChange={(e) => setState(p => ({ ...p, name: e.target.value }))} placeholder="Full name" />
                  </div>
                  <div>
                    <Label className="text-xs">Credentials</Label>
                    <Input value={state.credentials} onChange={(e) => setState(p => ({ ...p, credentials: e.target.value }))} placeholder="e.g. LCSW" />
                  </div>
                  <div>
                    <Label className="text-xs">Location</Label>
                    <Input value={state.location} onChange={(e) => setState(p => ({ ...p, location: e.target.value }))} placeholder="ABQ, LL, RR" />
                  </div>
                </div>
              </>
            )}

            {/* Age Group Specialty Sections */}
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">Click a specialty to cycle: <span className="text-gray-400">— (none)</span> → <span className="text-green-700">x</span> → <span className="text-amber-700">x - Slow</span> → <span className="text-gray-400">—</span></p>
              {Object.entries(AGE_GROUP_SPECIALTIES).map(([group, specs]) => (
                <div key={group}>
                  <p className="text-xs font-semibold text-foreground uppercase tracking-wide mb-2">{group}</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                    {specs.map(spec => (
                      <SpecialtyChip
                        key={`${group}-${spec}`}
                        specialty={spec}
                        value={state.ageGroupCaps[group]?.[spec] || ""}
                        onCycle={() => cycleSpecialty(group, spec)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Notes */}
            <div>
              <Label className="text-xs font-semibold uppercase tracking-wide">Notes</Label>
              <Textarea
                value={state.notes}
                onChange={(e) => setState(p => ({ ...p, notes: e.target.value }))}
                placeholder="Additional notes..."
                className="min-h-[50px] mt-1.5 text-sm"
              />
            </div>

            {/* Insurance Multi-Select */}
            <div>
              <p className="text-xs font-semibold text-foreground uppercase tracking-wide mb-2">
                Accepted Insurances {selectedCount > 0 && `(${selectedCount})`}
              </p>
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  ref={searchRef}
                  value={insuranceSearch}
                  onChange={(e) => setInsuranceSearch(e.target.value)}
                  placeholder="Search insurances..."
                  className="pl-8 h-8 text-sm"
                />
                {insuranceSearch && (
                  <button
                    type="button"
                    onClick={() => { setInsuranceSearch(""); searchRef.current?.focus(); }}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {filteredInsurances.map(ins => (
                  <InsuranceChip
                    key={ins}
                    name={ins}
                    selected={state.selectedInsurances.has(ins)}
                    onToggle={() => toggleInsurance(ins)}
                  />
                ))}
              </div>
            </div>
          </div>
        </ScrollArea>

        <div className="flex justify-end gap-2 pt-3 border-t flex-shrink-0">
          <Button variant="outline" onClick={onClose} disabled={isSaving}>Cancel</Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isEditing ? "Save Changes" : "Create Provider"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Providers Page
 *
 * Displays providers from the Provider Skills Spreadsheet + CRM-managed providers.
 * Supports editing CRM providers and creating new ones.
 */
export default function Providers() {
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] = useState<ProviderWithInsurance | null>(null);
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState<any>(null);

  const {
    data,
    isLoading,
    error,
  } = useQuery<ProvidersResponse>({
    queryKey: ["/api/providers"],
    queryFn: getProviders,
  });

  if (isLoading) {
    return (
      <PageLayout>
        <PageLoader context="providers" />
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-muted-foreground">Failed to load provider data</p>
          <p className="text-xs text-muted-foreground max-w-md text-center">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </PageLayout>
    );
  }

  const providers = data?.providers || [];

  // Normalize location: "Corp" should be treated as "ABQ"
  // TFC only has 3 locations: ABQ, LL, RR
  const normalizeLocation = (location: string | undefined): string => {
    if (!location) return "Unknown";
    if (location.toLowerCase() === "corp" || location.toLowerCase() === "corporate") {
      return "ABQ";
    }
    return location;
  };

  // Group providers by normalized location
  const providersByLocation = providers.reduce((acc, provider) => {
    const location = normalizeLocation(provider.location);
    if (!acc[location]) {
      acc[location] = [];
    }
    // Create a copy with normalized location for display
    acc[location].push({ ...provider, location });
    return acc;
  }, {} as Record<string, Provider[]>);

  // Sort locations alphabetically (ABQ, LL, RR)
  const sortedLocations = Object.keys(providersByLocation).sort((a, b) => {
    return a.localeCompare(b);
  });

  return (
    <PageLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-foreground">Providers</h1>
              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800">
                Beta
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Provider capabilities from the Provider Skills Spreadsheet
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={() => { setEditingProvider(null); setShowProviderForm(true); }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Provider
            </Button>
          </div>
        </div>

        {/* Data source indicator */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">
          <FileText className="h-4 w-4" />
          <span>
            This data is synced from the Provider Skills Spreadsheet.
            {data?.lastModified && (
              <span className="ml-1">
                Last updated: {new Date(data.lastModified).toLocaleString()}
              </span>
            )}
          </span>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 text-sm">
          <span className="font-medium">{providers.length} providers</span>
          <span className="text-muted-foreground">
            across {sortedLocations.length} location{sortedLocations.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Providers by location */}
        {sortedLocations.map((location) => (
          <div key={location} className="space-y-4">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-medium text-foreground">{location}</h2>
              <Badge variant="secondary">{providersByLocation[location].length}</Badge>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {providersByLocation[location].map((provider: any) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  onFindPatients={() => setSelectedProvider(transformApiProvider(provider as any))}
                  onEdit={() => {
                    setEditingProvider(provider);
                    setShowProviderForm(true);
                  }}
                />
              ))}
            </div>
          </div>
        ))}

        {providers.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <p className="text-lg font-medium text-foreground">No Provider Data</p>
            <p className="text-sm text-muted-foreground">
              The Provider Skills Spreadsheet contains no provider records.
            </p>
          </div>
        )}
      </div>

      {/* Patient Matching Modal */}
      <PatientMatchingModal
        isOpen={selectedProvider !== null}
        onClose={() => setSelectedProvider(null)}
        provider={selectedProvider}
      />

      {/* Provider Create/Edit Modal */}
      <ProviderFormModal
        isOpen={showProviderForm}
        onClose={() => { setShowProviderForm(false); setEditingProvider(null); }}
        editingProvider={editingProvider}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/providers"] });
        }}
      />
    </PageLayout>
  );
}
