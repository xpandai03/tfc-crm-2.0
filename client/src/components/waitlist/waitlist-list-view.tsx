import { useState, useMemo } from "react";
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
import { ArrowUpDown, ArrowUp, ArrowDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STATUS_UMBRELLAS,
  STATUS_LABELS,
  getUmbrellaForStatus,
  stringStatusToCode,
  type UmbrellaId,
} from "@/lib/status-config";
import type { WaitlistContact } from "@shared/schema";

interface WaitlistListViewProps {
  contacts: WaitlistContact[];
  currentUserEmail?: string;
}

type SortField = "daysOnWaitlist" | "dateAdded" | "name";
type SortDirection = "asc" | "desc";

const umbrellaColors: Record<UmbrellaId, string> = {
  WL: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  PS: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  PMR: "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300",
  INS: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
};

export function WaitlistListView({ contacts, currentUserEmail }: WaitlistListViewProps) {
  // Filter state
  const [umbrellaFilter, setUmbrellaFilter] = useState<UmbrellaId | "all">("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

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

  // Filter contacts
  const filteredContacts = useMemo(() => {
    return contacts.filter((contact) => {
      const umbrella = getUmbrella(contact);
      const statusCode = getStatusCode(contact);

      // Umbrella filter
      if (umbrellaFilter !== "all" && umbrella !== umbrellaFilter) {
        return false;
      }

      // Status code filter
      if (statusFilter !== "all" && statusCode !== parseInt(statusFilter)) {
        return false;
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
  }, [contacts, umbrellaFilter, statusFilter, searchQuery]);

  // Sort contacts
  const sortedContacts = useMemo(() => {
    return [...filteredContacts].sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case "daysOnWaitlist":
          comparison = (a.daysOnWaitlist || 0) - (b.daysOnWaitlist || 0);
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
              {availableStatusCodes.map((code) => (
                <SelectItem key={code} value={code.toString()}>
                  {code} - {STATUS_LABELS[code] || `Status ${code}`}
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

        <div className="ml-auto text-sm text-muted-foreground">
          {sortedContacts.length} contact{sortedContacts.length !== 1 ? "s" : ""}
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedContacts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No contacts match the current filters
                </TableCell>
              </TableRow>
            ) : (
              sortedContacts.map((contact) => {
                const statusCode = getStatusCode(contact);
                const umbrella = getUmbrella(contact);
                const umbrellaLabel = umbrella ? STATUS_UMBRELLAS[umbrella].label : "Unknown";
                const statusLabel = STATUS_LABELS[statusCode] || `Status ${statusCode}`;

                return (
                  <TableRow
                    key={contact.contactId || contact.name}
                    className={cn(
                      "cursor-pointer transition-all duration-200",
                      "bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm",
                      "hover:bg-white/90 dark:hover:bg-gray-800/90 hover:backdrop-blur-md hover:shadow-md hover:-translate-y-0.5"
                    )}
                  >
                    <TableCell className="font-medium">
                      <Link href={`/contact/${contact.contactId}`}>
                        <span className="text-primary hover:underline">{contact.name}</span>
                      </Link>
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
                        <span className="text-sm">{statusLabel}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "font-medium",
                          (contact.daysOnWaitlist || 0) >= 60 && "text-red-600 dark:text-red-400",
                          (contact.daysOnWaitlist || 0) >= 30 &&
                            (contact.daysOnWaitlist || 0) < 60 &&
                            "text-amber-600 dark:text-amber-400"
                        )}
                      >
                        {contact.daysOnWaitlist || 0}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {contact.serviceRequested || "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {contact.dateAdded || "—"}
                    </TableCell>
                    <TableCell>
                      <OwnerBadge
                        email={contact.assignedTo}
                        currentUserEmail={currentUserEmail}
                        showUnassigned={false}
                        size="sm"
                      />
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
