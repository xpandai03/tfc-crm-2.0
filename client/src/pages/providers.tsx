import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageLayout } from "@/components/layout/page-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageLoader } from "@/components/ui/page-loader";
import { AlertCircle, MapPin, FileText, Shield, Users, Plus, Pencil, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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
function ProviderCard({ provider, onFindPatients, onEdit }: { provider: Provider & { _crmManaged?: boolean; crmId?: number; specialties?: string[]; crmAgeGroups?: string[]; insurances?: string[] }; onFindPatients: () => void; onEdit?: () => void }) {
  const hasAnyCapabilities =
    Object.keys(provider.ageGroups["Adults (18+)"]).length > 0 ||
    Object.keys(provider.ageGroups["Adolescents (12-17)"]).length > 0 ||
    Object.keys(provider.ageGroups["Children (6-11)"]).length > 0 ||
    Object.keys(provider.ageGroups["Children (0-5)"]).length > 0;

  const hasAnySpecialtyData = hasAnyCapabilities || !!provider.notes;

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
            {onEdit && (
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onEdit}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
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
        {!hasAnySpecialtyData && (
          <p className="text-sm text-muted-foreground italic">No specialty data</p>
        )}

        {provider.notes && (
          <div className="pt-2 border-t">
            <div className="flex items-start gap-2">
              <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-sm text-muted-foreground">{provider.notes}</p>
            </div>
          </div>
        )}

        {/* Accepted Insurances from Provider Insurance Snapshot */}
        <InsuranceSection providerName={provider.name} />

        {/* Find Matching Patients */}
        <div className="pt-3 border-t">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={!hasAnySpecialtyData}
            title={!hasAnySpecialtyData ? "Provider must have specialties configured to enable matching" : undefined}
            onClick={(e) => {
              e.preventDefault();
              onFindPatients();
            }}
          >
            <Users className="h-4 w-4 mr-2" />
            Find Matching Patients
          </Button>
          {!hasAnySpecialtyData && (
            <p className="text-xs text-muted-foreground mt-1.5 text-center">
              Matching unavailable — no specialty data configured
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Provider form state for create/edit modal */
interface ProviderFormData {
  name: string;
  credentials: string;
  location: string;
  specialties: string;
  ageGroups: string;
  insurances: string;
  notes: string;
}

const EMPTY_FORM: ProviderFormData = {
  name: "",
  credentials: "",
  location: "",
  specialties: "",
  ageGroups: "",
  insurances: "",
  notes: "",
};

function ProviderFormModal({
  isOpen,
  onClose,
  editingProvider,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  editingProvider: { crmId: number; name: string; credentials: string; location: string; notes: string; specialties?: string[]; crmAgeGroups?: string[]; insurances?: string[] } | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<ProviderFormData>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);

  // Reset form when modal opens
  const isEditing = !!editingProvider;

  const resetForm = () => {
    if (editingProvider) {
      setForm({
        name: editingProvider.name,
        credentials: editingProvider.credentials || "",
        location: editingProvider.location || "",
        specialties: editingProvider.specialties?.join(", ") || "",
        ageGroups: editingProvider.crmAgeGroups?.join(", ") || "",
        insurances: editingProvider.insurances?.join(", ") || "",
        notes: editingProvider.notes || "",
      });
    } else {
      setForm(EMPTY_FORM);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        credentials: form.credentials.trim(),
        location: form.location.trim(),
        specialties: form.specialties ? form.specialties.split(",").map(s => s.trim()).filter(Boolean) : [],
        ageGroups: form.ageGroups ? form.ageGroups.split(",").map(s => s.trim()).filter(Boolean) : [],
        insurances: form.insurances ? form.insurances.split(",").map(s => s.trim()).filter(Boolean) : [],
        notes: form.notes.trim(),
      };

      if (isEditing && editingProvider) {
        await apiRequest("PATCH", `/api/providers/${editingProvider.crmId}`, payload);
        toast({ title: "Provider updated" });
      } else {
        await apiRequest("POST", "/api/providers", payload);
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

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); else resetForm(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Provider" : "Add New Provider"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Name *</Label>
              <Input value={form.name} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Full name" />
            </div>
            <div>
              <Label className="text-xs">Credentials</Label>
              <Input value={form.credentials} onChange={(e) => setForm(p => ({ ...p, credentials: e.target.value }))} placeholder="e.g. LCSW, LPCC" />
            </div>
          </div>
          <div>
            <Label className="text-xs">Location</Label>
            <Input value={form.location} onChange={(e) => setForm(p => ({ ...p, location: e.target.value }))} placeholder="e.g. ABQ, LL, RR" />
          </div>
          <div>
            <Label className="text-xs">Specialties (comma-separated)</Label>
            <Input value={form.specialties} onChange={(e) => setForm(p => ({ ...p, specialties: e.target.value }))} placeholder="e.g. Anxiety, Trauma, Depression" />
          </div>
          <div>
            <Label className="text-xs">Age Groups (comma-separated)</Label>
            <Input value={form.ageGroups} onChange={(e) => setForm(p => ({ ...p, ageGroups: e.target.value }))} placeholder="e.g. Adults, Adolescents, Children" />
          </div>
          <div>
            <Label className="text-xs">Accepted Insurances (comma-separated)</Label>
            <Input value={form.insurances} onChange={(e) => setForm(p => ({ ...p, insurances: e.target.value }))} placeholder="e.g. BCBS, Presbyterian, Tricare" />
          </div>
          <div>
            <Label className="text-xs">Notes</Label>
            <Textarea value={form.notes} onChange={(e) => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Additional notes..." className="min-h-[60px]" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={isSaving}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isEditing ? "Save Changes" : "Create Provider"}
            </Button>
          </div>
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
                  onEdit={provider._crmManaged ? () => {
                    setEditingProvider(provider);
                    setShowProviderForm(true);
                  } : undefined}
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
