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
import { cn, formatDob } from "@/lib/utils";
import {
  STATUS_UMBRELLAS,
  STATUS_LABELS,
  getUmbrellaForStatus,
  stringStatusToCode,
  isActiveStatus,
  type UmbrellaId,
} from "@/lib/status-config";
import {
  CANONICAL_INSURANCES,
  abbreviateInsurance,
  matchesInsurance,
} from "@shared/insurance";
import {
  getModalityPriorities,
  getPrimaryModality,
  matchesPrimaryModality,
  isRetiredModality,
  MODALITY_SHORT_LABELS,
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

type SortField = "daysOnWaitlist" | "dateAdded" | "name";
type SortDirection = "asc" | "desc";

const umbrellaColors: Record<UmbrellaId, string> = {
  WL: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  PS: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  SCH: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
  REF: "bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300",
  PMR: "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300",
  INS: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
};

/**
 * Abbreviate a provider name to "First L." for the list view's Assigned
 * Provider column, which is tight on horizontal space.
 *
 * DISPLAY LAYER ONLY, and only here. Contact cards, assignment modals, provider
 * management and the CSV export all keep full names — a CSV has no space
 * constraint and abbreviating there would destroy information.
 *
 * Names that don't fit "First Last" (single word, or three+ parts) are returned
 * untouched rather than guessed at.
 */
function abbreviateProviderName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return fullName.trim();
  const first = parts[0];
  const last = parts[parts.length - 1];
  const initial = last[0];
  if (!initial) return fullName.trim();
  return `${first} ${initial.toUpperCase()}.`;
}

/**
 * Build fullName -> displayName for a set of providers, keeping full names for
 * any pair that would abbreviate to the same thing.
 *
 * Without this, two providers sharing a first name and last initial would both
 * render "Anna A." and staff couldn't tell which contact went to whom — the
 * exact confusion the column exists to prevent.
 */
function buildProviderDisplayMap(fullNames: string[]): Record<string, string> {
  // Plain objects/arrays rather than Map/Set: this tsconfig targets below ES2015
  // without downlevelIteration, so for-of over a Map or Set is a type error.
  const byAbbrev: Record<string, string[]> = {};
  fullNames.forEach((name) => {
    const clean = name.trim();
    if (!clean) return;
    const abbrev = abbreviateProviderName(clean);
    const group = byAbbrev[abbrev] ?? (byAbbrev[abbrev] = []);
    if (group.indexOf(clean) === -1) group.push(clean);
  });

  const out: Record<string, string> = {};
  Object.keys(byAbbrev).forEach((abbrev) => {
    const originals = byAbbrev[abbrev];
    // Collision: more than one distinct full name abbreviates to this, so
    // everyone in the group falls back to their full name.
    const collides = originals.length > 1;
    originals.forEach((original) => {
      out[original] = collides ? original : abbrev;
    });
  });
  return out;
}

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
              <TableHead className="w-[104px]">Umbrella</TableHead>
              {/* Column tightening (client request): Status, Days Waiting,
                  Service, Modality and Assigned To are width-capped and given
                  tighter horizontal padding so every column fits at 1440px
                  without horizontal scroll. No column was removed — Days
                  Waiting and Household are both in active use. Name is
                  deliberately left unconstrained so it stays fully readable. */}
              <TableHead className="w-[168px] px-2">Status</TableHead>
              <TableHead className="w-[76px] px-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 h-8 px-1"
                  onClick={() => toggleSort("daysOnWaitlist")}
                  title="Days Waiting"
                >
                  Days
                  <SortIcon field="daysOnWaitlist" />
                </Button>
              </TableHead>
              <TableHead className="w-[116px] px-2">Service</TableHead>
              {/* Replaced the Date Added column: Days Waiting already covers
                  recency, and staff need to see at a glance which locations a
                  contact will attend. dateAdded remains the default sort field
                  (see SortField) — only its header button is gone. */}
              <TableHead className="w-[104px] px-2">Insurance</TableHead>
              <TableHead className="w-[120px] px-2">Modality</TableHead>
              <TableHead className="w-[92px] px-2">Assigned To</TableHead>
              <TableHead className="w-[124px] px-2">Assigned Provider</TableHead>
              <TableHead className="w-[92px] px-2">Paperwork</TableHead>
              <TableHead>Household</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedContacts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
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
                    <TableCell className="px-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-muted-foreground">{statusCode}</span>
                        <span className={cn("text-xs leading-tight", isInactive && "italic")}>{statusLabel}</span>
                      </div>
                    </TableCell>
                    <TableCell className="px-2">
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
                    <TableCell className="px-2 text-xs text-muted-foreground">
                      {contact.requestingFor ?? contact.serviceRequested ?? "—"}
                    </TableCell>
                    <TableCell className="px-2">
                      {contact.insurancePayer ? (
                        <span
                          className="text-xs text-foreground whitespace-nowrap"
                          // Full stored value on hover — the column abbreviates,
                          // but staff must be able to see exactly what a record
                          // holds, especially for legacy strings.
                          title={contact.insurancePayer}
                        >
                          {abbreviateInsurance(contact.insurancePayer)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="px-2">
                      {(() => {
                        const list = getModalityPriorities(contact);
                        if (list.length === 0) {
                          return <span className="text-xs text-muted-foreground italic">Unknown</span>;
                        }
                        return (
                          <div className="flex flex-wrap items-center gap-1">
                            {list.map((m, i) => (
                              <Badge
                                key={m}
                                variant="outline"
                                className={cn(
                                  "text-[10px] px-1.5 py-0 h-4 font-normal",
                                  // P1 is the choice reports and Insights count,
                                  // so it reads as primary; the rest are muted.
                                  i === 0
                                    ? "border-primary/40 bg-primary/10 text-primary font-medium"
                                    : "text-muted-foreground border-muted-foreground/30"
                                )}
                                title={i === 0 ? `${m} (first priority)` : `${m} (priority ${i + 1})`}
                              >
                                {MODALITY_SHORT_LABELS[m] ?? m}
                              </Badge>
                            ))}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="px-2">
                      <OwnerBadge
                        email={contact.assignedTo}
                        currentUserEmail={currentUserEmail}
                        showUnassigned={false}
                        size="sm"
                      />
                    </TableCell>
                    <TableCell className="px-2 text-xs">
                      {contact.assignedProviderName ? (
                        <span
                          className="text-foreground font-medium whitespace-nowrap"
                          // Full name stays available on hover, so abbreviating
                          // costs nothing when someone needs to be certain.
                          title={contact.assignedProviderName}
                        >
                          {providerDisplayNames[contact.assignedProviderName] ??
                            abbreviateProviderName(contact.assignedProviderName)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">No provider</span>
                      )}
                    </TableCell>
                    <TableCell className="px-2">
                      {contact.paperworkStatus ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 h-4 font-normal whitespace-nowrap text-muted-foreground border-muted-foreground/30"
                        >
                          {contact.paperworkStatus}
                        </Badge>
                      ) : (
                        // Blank, not a dash: "not tracked yet" should read as
                        // absence, not as a value staff need to interpret.
                        <span />
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {contact.householdMembers && contact.householdMembers.length > 0 ? (
                        <div className="space-y-0.5">
                          {contact.householdMembers.map((m, i) => {
                            const conflict = !!m.assignedProviderName && !!contact.assignedProviderName
                              && m.assignedProviderName === contact.assignedProviderName;
                            return (
                              <div key={i} className="whitespace-nowrap">
                                <span className="text-foreground font-medium">
                                  {m.name}{m.dob ? ` (${formatDob(m.dob)})` : ""}
                                </span>
                                {m.assignedProviderName && (
                                  <span className={cn(
                                    "ml-1",
                                    conflict ? "text-red-600 dark:text-red-400 font-semibold" : "text-muted-foreground"
                                  )}>
                                    · {conflict ? "⚠ same: " : ""}{m.assignedProviderName}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
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
