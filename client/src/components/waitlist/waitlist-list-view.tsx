import { useState, useMemo, useEffect } from "react";
import { computeDaysWaiting } from "@/lib/days-waiting";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { OwnerBadge } from "@/components/ui/owner-badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ArrowUpDown, ArrowUp, ArrowDown, Search, X, EyeOff, Shield, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STATUS_UMBRELLAS,
  STATUS_LABELS,
  getUmbrellaForStatus,
  stringStatusToCode,
  isActiveStatus,
  type UmbrellaId,
} from "@/lib/status-config";
import { normalizeInsurance } from "@/lib/insurance-utils";
import { getAttentionFlags } from "@/lib/api";
import type { WaitlistContact } from "@shared/schema";

interface WaitlistListViewProps {
  contacts: WaitlistContact[];
  currentUserEmail?: string;
  // Optional props for URL-driven filtering (drill-down from Insights)
  initialInsuranceFilter?: string | null;
  initialModalityFilter?: string | null;
  initialStatusFilter?: string | null;
  initialUmbrellaFilter?: string | null;
  initialReasonFilter?: string | null;       // matches a reasonForTherapy MCQ token
  initialServiceTypeFilter?: string | null;  // matches requestingFor exactly
}

/**
 * Modality normalization mapping (copied from insights.tsx for consistency)
 * Maps form options and historical values to display categories
 *
 * TODO: consolidate this map with insights.tsx — the two copies have
 * drifted independently in the past. See follow-up PR (D-C2 from
 * insights cleanup audit).
 */
const MODALITY_NORMALIZATION_MAP: Record<string, string> = {
  // Hybrid
  "hybrid": "Hybrid",
  "hybrid - ll": "Hybrid",
  // In Person - Albuquerque (ABQ)
  "in person - albuquerque": "In Person ABQ",
  "in person-abq": "In Person ABQ",
  "in person abq": "In Person ABQ",
  "in person- albuquerque": "In Person ABQ",
  "in person - abq": "In Person ABQ",
  "abq": "In Person ABQ",
  "albuquerque": "In Person ABQ",
  // In Person - Rio Rancho (RR)
  "in person - rio rancho": "In Person RR",
  "in person-rio rancho": "In Person RR",
  "in person- rio rancho": "In Person RR",
  "in person - rr": "In Person RR",
  "in person rr": "In Person RR",
  "rio rancho": "In Person RR",
  // In Person - Los Lunas (LL) — split out from generic per Bucket C
  "in person - los lunas": "In Person LL",
  "in person- los lunas": "In Person LL",
  "in person los lunas": "In Person LL",
  "in-person los lunas": "In Person LL",
  "in person ll": "In Person LL",
  "los lunas": "In Person LL",
  "ll": "In Person LL",
  // In Person (generic)
  "in person": "In Person",
  "in person - albuquerque or rio rancho": "In Person",
  "in person- albuquerque or rio rancho": "In Person",
  "in-person": "In Person",
  // Telehealth
  "telehealth": "Telehealth",
  "th": "Telehealth",
  "tele-health": "Telehealth",
  "tele health": "Telehealth",
  // Flexible/Flex
  "flexible (open to any option)": "Flex",
  "flexible (open to any option).": "Flex",
  "flexible": "Flex",
  "flex": "Flex",
  "open to any option": "Flex",
};

/**
 * Normalize modality to canonical category (consistent with Insights aggregation)
 */
function normalizeModality(rawValue: string | null | undefined): string {
  if (!rawValue) return "Unknown";
  const trimmed = rawValue.trim();
  if (!trimmed) return "Unknown";
  const normalized = trimmed.toLowerCase();
  return MODALITY_NORMALIZATION_MAP[normalized] || "Unknown";
}

// Format date for display: converts YYYY-MM-DD or Excel serial to MM/DD/YYYY
function formatDateForDisplay(dateValue: string | number | null | undefined): string {
  if (!dateValue) return "—";
  
  let dateStr: string | null = null;
  
  // Handle Excel serial numbers (like 45917, 45945)
  if (typeof dateValue === "number" && dateValue > 15000 && dateValue < 80000) {
    // Excel epoch is Dec 30, 1899
    const excelEpoch = new Date(1899, 11, 30);
    const date = new Date(excelEpoch.getTime() + dateValue * 24 * 60 * 60 * 1000);
    dateStr = date.toISOString().split("T")[0]; // Convert to YYYY-MM-DD
  } else if (typeof dateValue === "string") {
    dateStr = dateValue;
  } else {
    return String(dateValue);
  }
  
  // Parse YYYY-MM-DD format and convert to MM/DD/YYYY
  const parts = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (parts) {
    const [, year, month, day] = parts;
    return `${month}/${day}/${year}`;
  }
  
  // If already in MM/DD/YYYY format, return as-is
  if (dateStr.match(/^\d{1,2}\/\d{1,2}\/\d{2,4}$/)) {
    return dateStr;
  }
  
  // Fallback: try to parse and format
  try {
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const year = date.getFullYear();
      return `${month}/${day}/${year}`;
    }
  } catch {
    // If parsing fails, return original
  }
  
  return dateStr || "—";
}

type SortField = "daysOnWaitlist" | "dateAdded" | "name";
type SortDirection = "asc" | "desc";

const umbrellaColors: Record<UmbrellaId, string> = {
  WL: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  PS: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  SCH: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
  PMR: "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300",
  INS: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
};

/** Parse ?status=100 or ?status=100,101,102 — returns null when no status filter (all). */
function parseStatusCodesFromFilter(raw: string | null | undefined): number[] | null {
  if (!raw || raw === "all") return null;
  const parts = raw.split(",").map((p) => parseInt(p.trim(), 10));
  const valid = parts.filter((n) => !Number.isNaN(n));
  return valid.length > 0 ? valid : null;
}

export function WaitlistListView({
  contacts,
  currentUserEmail,
  initialInsuranceFilter,
  initialModalityFilter,
  initialStatusFilter,
  initialUmbrellaFilter,
  initialReasonFilter,
  initialServiceTypeFilter,
}: WaitlistListViewProps) {
  // Attention flags (TanStack Query deduplicates — zero extra network cost)
  const { data: flagsData } = useQuery({
    queryKey: ["/api/attention-flags"],
    queryFn: getAttentionFlags,
    staleTime: 30_000,
  });
  const flaggedIds = useMemo(() => {
    if (!flagsData?.flags) return new Set<number>();
    return new Set(flagsData.flags.map(f => f.contactId));
  }, [flagsData]);

  // Filter state
  const [umbrellaFilter, setUmbrellaFilter] = useState<UmbrellaId | "all">(
    (initialUmbrellaFilter as UmbrellaId) || "all"
  );
  const [statusFilter, setStatusFilter] = useState<string>(initialStatusFilter || "all");
  const [searchQuery, setSearchQuery] = useState("");
  const [hideInactive, setHideInactive] = useState(true);
  const [insuranceFilter, setInsuranceFilter] = useState<string>(initialInsuranceFilter || "all");
  const [modalityFilter, setModalityFilter] = useState<string>(initialModalityFilter || "all");
  const [reasonFilter, setReasonFilter] = useState<string>(initialReasonFilter || "all");
  const [serviceTypeFilter, setServiceTypeFilter] = useState<string>(initialServiceTypeFilter || "all");

  // Update filters when initial props change (e.g., from URL navigation)
  useEffect(() => {
    if (initialInsuranceFilter) setInsuranceFilter(initialInsuranceFilter);
    if (initialModalityFilter) setModalityFilter(initialModalityFilter);
    if (initialStatusFilter) setStatusFilter(initialStatusFilter);
    if (initialUmbrellaFilter) setUmbrellaFilter(initialUmbrellaFilter as UmbrellaId);
    if (initialReasonFilter) setReasonFilter(initialReasonFilter);
    if (initialServiceTypeFilter) setServiceTypeFilter(initialServiceTypeFilter);
  }, [initialInsuranceFilter, initialModalityFilter, initialStatusFilter, initialUmbrellaFilter, initialReasonFilter, initialServiceTypeFilter]);

  // Sort state
  const [sortField, setSortField] = useState<SortField>("daysOnWaitlist");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  // Get effective status code for a contact
  const getStatusCode = (contact: WaitlistContact): number => {
    return contact.statusCode ?? stringStatusToCode(contact.status);
  };

  // Get umbrella for a contact
  const getUmbrella = (contact: WaitlistContact): UmbrellaId | null => {
    return getUmbrellaForStatus(getStatusCode(contact));
  };

  // Get available status codes for current umbrella filter
  const availableStatusCodes = useMemo(() => {
    if (umbrellaFilter === "all") {
      return Object.values(STATUS_UMBRELLAS).flatMap(u => [...u.codes]);
    }
    return [...STATUS_UMBRELLAS[umbrellaFilter].codes];
  }, [umbrellaFilter]);

  const allowedStatusCodes = useMemo(
    () => parseStatusCodesFromFilter(statusFilter),
    [statusFilter],
  );

  const isMultiStatusFromUrl =
    statusFilter !== "all" && allowedStatusCodes !== null && allowedStatusCodes.length > 1;

  // Compute unique insurance options from contacts (normalized)
  const availableInsurances = useMemo(() => {
    const insuranceSet = new Set<string>();
    for (const contact of contacts) {
      const normalized = normalizeInsurance(contact.insurancePayer);
      insuranceSet.add(normalized);
    }
    return Array.from(insuranceSet).sort();
  }, [contacts]);

  // Compute unique modality options from contacts (normalized for consistency with Insights)
  const availableModalities = useMemo(() => {
    const modalitySet = new Set<string>();
    for (const contact of contacts) {
      const normalized = normalizeModality(contact.modality);
      modalitySet.add(normalized);
    }
    return Array.from(modalitySet).sort();
  }, [contacts]);

  // Filter contacts
  const filteredContacts = useMemo(() => {
    return contacts.filter((contact) => {
      const umbrella = getUmbrella(contact);
      const statusCode = getStatusCode(contact);

      // Hide inactive filter
      if (hideInactive && !isActiveStatus(statusCode)) {
        return false;
      }

      // Umbrella filter
      if (umbrellaFilter !== "all" && umbrella !== umbrellaFilter) {
        return false;
      }

      // Status code filter — single code or comma-separated list (Insights drill-down)
      if (allowedStatusCodes !== null && !allowedStatusCodes.includes(statusCode)) {
        return false;
      }

      // Insurance filter (use normalized comparison for consistency with Insights)
      if (insuranceFilter !== "all") {
        const contactInsurance = normalizeInsurance(contact.insurancePayer);
        if (contactInsurance !== insuranceFilter) {
          return false;
        }
      }

      // Modality filter (use normalized comparison for consistency with Insights)
      if (modalityFilter !== "all") {
        const contactModality = normalizeModality(contact.modality);
        if (contactModality !== modalityFilter) {
          return false;
        }
      }

      // Reason for Therapy filter — multi-value field stored as comma-separated
      // string OR array. Match if the selected reason appears as one of the
      // contact's tokens (per Bucket A migration, all tokens are canonical
      // or "Other (legacy free-text)" so exact-string compare is reliable).
      if (reasonFilter !== "all") {
        const raw = (contact as { reasonForTherapy?: string | string[] | null }).reasonForTherapy;
        const tokens: string[] = Array.isArray(raw)
          ? raw.map((s) => String(s).trim()).filter(Boolean)
          : typeof raw === "string"
            ? raw.split(",").map((s) => s.trim()).filter(Boolean)
            : [];
        if (!tokens.includes(reasonFilter)) {
          return false;
        }
      }

      // Service Type filter — single-value, matches contact.requestingFor exactly
      if (serviceTypeFilter !== "all") {
        const requestingFor = (contact as { requestingFor?: string | null }).requestingFor?.trim() ?? "";
        if (requestingFor !== serviceTypeFilter) {
          return false;
        }
      }

      // Search filter (case-insensitive substring match)
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const name = contact.name.toLowerCase();
        if (!name.includes(query)) {
          return false;
        }
      }

      return true;
    });
  }, [contacts, umbrellaFilter, allowedStatusCodes, searchQuery, hideInactive, insuranceFilter, modalityFilter, reasonFilter, serviceTypeFilter]);

  // Sort contacts
  const sortedContacts = useMemo(() => {
    return [...filteredContacts].sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case "daysOnWaitlist":
          comparison = computeDaysWaiting(a.dateAdded, a.daysOnWaitlist) - computeDaysWaiting(b.dateAdded, b.daysOnWaitlist);
          break;
        case "dateAdded":
          const dateA = a.dateAdded ? new Date(a.dateAdded).getTime() : 0;
          const dateB = b.dateAdded ? new Date(b.dateAdded).getTime() : 0;
          comparison = dateA - dateB;
          break;
        case "name":
          comparison = (a.name || "").localeCompare(b.name || "");
          break;
      }

      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [filteredContacts, sortField, sortDirection]);

  // Toggle sort
  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection(field === "name" ? "asc" : "desc");
    }
  };

  // Render sort icon
  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-4 w-4 text-muted-foreground/50" />;
    }
    return sortDirection === "asc" ? (
      <ArrowUp className="h-4 w-4" />
    ) : (
      <ArrowDown className="h-4 w-4" />
    );
  };

  // Reset status filter when umbrella changes
  const handleUmbrellaChange = (value: string) => {
    setUmbrellaFilter(value as UmbrellaId | "all");
    setStatusFilter("all");
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Umbrella:</span>
          <Select value={umbrellaFilter} onValueChange={handleUmbrellaChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Umbrellas</SelectItem>
              {(Object.keys(STATUS_UMBRELLAS) as UmbrellaId[]).map((id) => (
                <SelectItem key={id} value={id}>
                  {STATUS_UMBRELLAS[id].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Status:</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {isMultiStatusFromUrl && (
                <SelectItem value={statusFilter}>
                  From link ({allowedStatusCodes?.length ?? 0} codes)
                </SelectItem>
              )}
              {availableStatusCodes.map((code) => (
                <SelectItem key={code} value={code.toString()}>
                  {code} - {STATUS_LABELS[code] || `Status ${code}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Insurance Filter */}
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <Select value={insuranceFilter} onValueChange={setInsuranceFilter}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="All Insurances" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Insurances</SelectItem>
              {availableInsurances.map((insurance) => (
                <SelectItem key={insurance} value={insurance}>
                  {insurance}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Modality Filter */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Modality:</span>
          <Select value={modalityFilter} onValueChange={setModalityFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All Modalities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Modalities</SelectItem>
              {availableModalities.map((modality) => (
                <SelectItem key={modality} value={modality}>
                  {modality}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Search Input */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 w-[200px]"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Hide Inactive Toggle */}
        <div className="flex items-center gap-2 bg-white/60 dark:bg-gray-900/60 backdrop-blur-sm rounded-lg px-3 py-2 border border-white/20 dark:border-gray-700/30">
          <EyeOff className="h-4 w-4 text-muted-foreground" />
          <Switch
            id="list-hide-inactive"
            checked={hideInactive}
            onCheckedChange={setHideInactive}
          />
          <Label htmlFor="list-hide-inactive" className="text-sm cursor-pointer">
            Hide Inactive
          </Label>
        </div>

        <div className="ml-auto text-sm text-muted-foreground">
          {sortedContacts.length} contact{sortedContacts.length !== 1 ? "s" : ""}
          {!hideInactive && (() => {
            const inactiveCount = sortedContacts.filter(c => !isActiveStatus(getStatusCode(c))).length;
            const activeCount = sortedContacts.length - inactiveCount;
            return inactiveCount > 0 ? ` (${activeCount} active, ${inactiveCount} inactive)` : "";
          })()}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-white/40 dark:border-gray-700/40 bg-white/60 dark:bg-gray-900/60 backdrop-blur-xl shadow-lg overflow-hidden">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md border-b border-white/40 dark:border-gray-700/40 shadow-sm">
            <TableRow className="hover:bg-transparent">
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 h-8"
                  onClick={() => toggleSort("name")}
                >
                  Name
                  <SortIcon field="name" />
                </Button>
              </TableHead>
              <TableHead>Umbrella</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 h-8"
                  onClick={() => toggleSort("daysOnWaitlist")}
                >
                  Days Waiting
                  <SortIcon field="daysOnWaitlist" />
                </Button>
              </TableHead>
              <TableHead>Service</TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 h-8"
                  onClick={() => toggleSort("dateAdded")}
                >
                  Date Added
                  <SortIcon field="dateAdded" />
                </Button>
              </TableHead>
              <TableHead>Assigned To</TableHead>
              <TableHead>Assigned Provider</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedContacts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  No contacts match the current filters
                </TableCell>
              </TableRow>
            ) : (
              sortedContacts.map((contact) => {
                const statusCode = getStatusCode(contact);
                const umbrella = getUmbrella(contact);
                const umbrellaLabel = umbrella ? STATUS_UMBRELLAS[umbrella].label : "Unknown";
                const statusLabel = STATUS_LABELS[statusCode] || `Status ${statusCode}`;
                const isInactive = !isActiveStatus(statusCode);

                return (
                  <TableRow
                    key={contact.contactId || contact.name}
                    className={cn(
                      "cursor-pointer transition-all duration-200",
                      "bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm",
                      "hover:bg-white/90 dark:hover:bg-gray-800/90 hover:backdrop-blur-md hover:shadow-md hover:-translate-y-0.5",
                      isInactive && "opacity-60"
                    )}
                  >
                    <TableCell className="font-medium">
                      <Link href={`/contact/${contact.contactId}`}>
                        <span className={cn(
                          "hover:underline",
                          isInactive ? "text-muted-foreground italic" : "text-primary"
                        )}>
                          {contact.name}
                        </span>
                      </Link>
                      {flaggedIds.has(contact.contactId) && (
                        <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0 h-4 text-amber-600 border-amber-400/50 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-600/30">
                          <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                          Attn
                        </Badge>
                      )}
                      {isInactive && (
                        <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0 h-4 text-muted-foreground border-muted-foreground/30">
                          Inactive
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {umbrella && (
                        <Badge className={cn("font-normal", umbrellaColors[umbrella])}>
                          {umbrellaLabel}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{statusCode}</span>
                        <span className={cn("text-sm", isInactive && "italic")}>{statusLabel}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const dw = computeDaysWaiting(contact.dateAdded, contact.daysOnWaitlist);
                        return (
                          <span
                            className={cn(
                              "font-medium",
                              !isInactive && dw >= 60 && "text-red-600 dark:text-red-400",
                              !isInactive && dw >= 30 && dw < 60 && "text-amber-600 dark:text-amber-400"
                            )}
                          >
                            {dw}
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {contact.requestingFor ?? contact.serviceRequested ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateForDisplay(contact.dateAdded)}
                    </TableCell>
                    <TableCell>
                      <OwnerBadge
                        email={contact.assignedTo}
                        currentUserEmail={currentUserEmail}
                        showUnassigned={false}
                        size="sm"
                      />
                    </TableCell>
                    <TableCell className="text-sm">
                      {contact.assignedProviderName ? (
                        <span className="text-foreground font-medium">{contact.assignedProviderName}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
