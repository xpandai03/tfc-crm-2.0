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
import { Search, X, EyeOff, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STATUS_UMBRELLAS,
  STATUS_LABELS,
  getUmbrellaForStatus,
  stringStatusToCode,
  isActiveStatus,
  type UmbrellaId,
} from "@/lib/status-config";
import {
  WAITLIST_COLUMNS,
  buildProviderDisplayMap,
  type SortField,
  type SortDirection,
  type WaitlistCellCtx,
} from "./waitlist-columns";
import { CANONICAL_INSURANCES, matchesInsurance } from "@shared/insurance";
import {
  getPrimaryModality,
  matchesPrimaryModality,
  isRetiredModality,
} from "@shared/modality-utils";
import { getAttentionFlags } from "@/lib/api";
import type { WaitlistContact } from "@shared/schema";

/**
 * The list view's live filter state, surfaced to the parent so the Export button
 * (which lives in waitlist.tsx) can export exactly what's on screen. Field names
 * match the server's WaitlistExportFilters.
 */
export interface WaitlistFilterState {
  hideInactive: boolean;
  umbrella: string | null;
  statusCodes: number[] | null;
  insurance: string | null;
  modality: string | null;
  language: string | null;
  reason: string | null;
  serviceType: string | null;
  search: string | null;
}

interface WaitlistListViewProps {
  contacts: WaitlistContact[];
  currentUserEmail?: string;
  /** Fired whenever the filter state changes, so the parent can export the current view. */
  onFiltersChange?: (filters: WaitlistFilterState) => void;
  // Optional props for URL-driven filtering (drill-down from Insights)
  initialInsuranceFilter?: string | null;
  initialModalityFilter?: string | null;
  initialStatusFilter?: string | null;
  initialUmbrellaFilter?: string | null;
  initialReasonFilter?: string | null;       // matches a reasonForTherapy MCQ token
  initialServiceTypeFilter?: string | null;  // matches requestingFor exactly
}

// Modality normalization now comes from @shared/modality-utils (single source of
// truth). The local copy that lived here was byte-identical to the shared map;
// consolidating it also picks up the comma-token split, so multi-modality
// contacts stop collapsing into "Unknown".

// (formatDateForDisplay removed: the Date Added column it served was replaced
// by the Modality badge column. dateAdded is still a sort field.)





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
  onFiltersChange,
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
  // Language filter (Lane): exact match on dropdown-constrained "English"/"Spanish".
  const [languageFilter, setLanguageFilter] = useState<string>("all");
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

  // Publish the live filter state upward so the parent's Export button can send
  // it to the server. Keyed on the same values as the filter memo below, so the
  // two can't disagree about what's currently applied.
  useEffect(() => {
    onFiltersChange?.({
      hideInactive,
      umbrella: umbrellaFilter === "all" ? null : umbrellaFilter,
      statusCodes: allowedStatusCodes,
      insurance: insuranceFilter === "all" ? null : insuranceFilter,
      modality: modalityFilter === "all" ? null : modalityFilter,
      language: languageFilter === "all" ? null : languageFilter,
      reason: reasonFilter === "all" ? null : reasonFilter,
      serviceType: serviceTypeFilter === "all" ? null : serviceTypeFilter,
      search: searchQuery.trim() || null,
    });
  }, [
    onFiltersChange,
    hideInactive,
    umbrellaFilter,
    allowedStatusCodes,
    insuranceFilter,
    modalityFilter,
    languageFilter,
    reasonFilter,
    serviceTypeFilter,
    searchQuery,
  ]);

  // Insurance options are the CANONICAL 16, not values derived from the data.
  // Deriving from data would resurface the ~114 legacy strings as filter
  // choices, which is exactly what this batch removes. Records holding a legacy
  // payer are reachable under "All Insurances" only.
  const availableInsurances = CANONICAL_INSURANCES;

  // Compute unique modality options from contacts. Built from the UNION of each
  // contact's tokens (not just its primary bucket) so a modality only one
  // multi-select contact asked for is still offered in the dropdown. Contacts
  // whose value resolves to nothing contribute "Unknown".
  // Options are built from each contact's PRIMARY modality, because that is what
  // the filter now matches on — offering a value that filters to zero rows would
  // read as a bug. Retired values (Flex / Hybrid / generic In Person) are
  // excluded even where historical records still carry them; those records keep
  // displaying their value, they just aren't filterable by it.
  // Columns in their default order. The refactor keeps every column visible so
  // behavior is identical to before; user-configurable visibility/order arrives
  // in the next commit and replaces only this line.
  const visibleColumns = useMemo(
    () => WAITLIST_COLUMNS.slice().sort((a, b) => a.order - b.order),
    [],
  );

  // Built from ALL contacts, not just the filtered set, so a provider's
  // abbreviation doesn't change as the user filters — a name that reads
  // "Anna A." in one view and "Anna Alvarez" in another is worse than either.
  const providerDisplayNames = useMemo(
    () =>
      buildProviderDisplayMap(
        contacts.map((c) => c.assignedProviderName ?? "").filter(Boolean),
      ),
    [contacts],
  );

  const availableModalities = useMemo(() => {
    const modalitySet = new Set<string>();
    for (const contact of contacts) {
      const primary = getPrimaryModality(contact);
      if (!isRetiredModality(primary)) modalitySet.add(primary);
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

      // Insurance filter — EXACT canonical match via the shared predicate (the
      // export predicate calls the same function, so the two can't drift).
      // Legacy payer strings match no specific filter by design; see
      // matchesInsurance in @shared/insurance.
      if (insuranceFilter !== "all" && !matchesInsurance(contact.insurancePayer, insuranceFilter)) {
        return false;
      }

      // Modality filter — PRIORITY-1 ONLY, matching reports, Insights and the
      // export (all four go through the same shared predicate). A contact whose
      // p1 is Albuquerque and p2 is Rio Rancho is returned by an Albuquerque
      // filter and not by a Rio Rancho one; their row still displays both.
      if (modalityFilter !== "all" && !matchesPrimaryModality(contact, modalityFilter)) {
        return false;
      }

      // Language filter — exact match on stored "English"/"Spanish" (dropdown-constrained,
      // consistent with the manual field + form mapping). NULL/unset never matches a
      // specific-language filter (those contacts appear only under "all").
      if (languageFilter !== "all") {
        const contactLanguage = (contact as { language?: string | null }).language ?? "";
        if (contactLanguage !== languageFilter) {
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
  }, [contacts, umbrellaFilter, allowedStatusCodes, searchQuery, hideInactive, insuranceFilter, modalityFilter, languageFilter, reasonFilter, serviceTypeFilter]);

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

        {/* Language Filter — fixed options (dropdown-constrained values). */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Language:</span>
          <Select value={languageFilter} onValueChange={setLanguageFilter}>
            <SelectTrigger className="w-[150px]" data-testid="select-language-filter">
              <SelectValue placeholder="All Languages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Languages</SelectItem>
              <SelectItem value="English">English</SelectItem>
              <SelectItem value="Spanish">Spanish</SelectItem>
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
              {visibleColumns.map((col) => (
                <TableHead key={col.id} className={col.widthClass}>
                  {col.header
                    ? col.header({ sortField, sortDirection, toggleSort })
                    : col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedContacts.length === 0 ? (
              <TableRow>
                {/* colSpan follows the visible column count so the empty state
                    always spans the full table, whatever the user has on. */}
                <TableCell colSpan={visibleColumns.length} className="h-24 text-center text-muted-foreground">
                  No contacts match the current filters
                </TableCell>
              </TableRow>
            ) : (
              sortedContacts.map((contact) => {
                const statusCode = getStatusCode(contact);
                const umbrella = getUmbrella(contact);
                // Derived once per row and handed to every cell renderer, so no
                // column recomputes them and none can drift from another.
                const ctx: WaitlistCellCtx = {
                  statusCode,
                  umbrella,
                  umbrellaLabel: umbrella ? STATUS_UMBRELLAS[umbrella].label : "Unknown",
                  statusLabel: STATUS_LABELS[statusCode] || `Status ${statusCode}`,
                  isInactive: !isActiveStatus(statusCode),
                  daysWaiting: computeDaysWaiting(contact.dateAdded, contact.daysOnWaitlist),
                  flaggedIds,
                  providerDisplayNames,
                  currentUserEmail,
                };

                return (
                  <TableRow
                    key={contact.contactId || contact.name}
                    className={cn(
                      "cursor-pointer transition-all duration-200",
                      "bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm",
                      "hover:bg-white/90 dark:hover:bg-gray-800/90 hover:backdrop-blur-md hover:shadow-md hover:-translate-y-0.5",
                      ctx.isInactive && "opacity-60"
                    )}
                  >
                    {visibleColumns.map((col) => (
                      <TableCell key={col.id} className={col.cellClass}>
                        {col.render(contact, ctx)}
                      </TableCell>
                    ))}
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
