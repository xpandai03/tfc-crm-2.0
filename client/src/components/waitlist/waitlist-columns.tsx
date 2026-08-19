/**
 * Waitlist list-view column definitions.
 *
 * The table used to be ~190 lines of hand-written <TableHead>/<TableCell> JSX,
 * which made column visibility, ordering and user-configurable views impossible
 * without touching every cell. Columns are now DATA: one entry per column, with
 * its own header and cell renderers.
 *
 * WHY THE ctx ARGUMENT: several cells need values derived once per row
 * (statusCode, the resolved umbrella, days waiting, whether the row is
 * inactive) or computed once per TABLE (the flagged-contact set, the provider
 * abbreviation map, which depend on all rows at once). Recomputing those inside
 * each renderer would be wasteful and would drift; threading them through ctx
 * keeps every column a pure function of (contact, ctx).
 *
 * `order` and `widthClass` are carried here from day one even though nothing
 * user-facing edits widths yet — a later phase turns those on rather than
 * reshaping this file or the persisted preference JSON.
 *
 * IDs ARE PERSISTED. A column id appears in a user's saved preferences, so
 * renaming one orphans that column for everyone who saved it (it degrades
 * gracefully — unknown ids are dropped — but the user silently loses their
 * choice). Add and deprecate; don't rename.
 */
import type { ReactNode } from "react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OwnerBadge } from "@/components/ui/owner-badge";
import { ArrowUpDown, ArrowUp, ArrowDown, AlertTriangle } from "lucide-react";
import { cn, formatDob } from "@/lib/utils";
import { computeDaysWaiting } from "@/lib/days-waiting";
import { STATUS_UMBRELLAS, type UmbrellaId } from "@/lib/status-config";
import { abbreviateInsurance } from "@shared/insurance";
import { getModalityPriorities, MODALITY_SHORT_LABELS } from "@shared/modality-utils";
import type { WaitlistContact } from "@shared/schema";

/**
 * MM/DD/YYYY for the list. Handles the ISO strings the CRM stores and the Excel
 * serial numbers some legacy sheet rows still carry.
 */
function formatListDate(value: string | number | null | undefined): string {
  if (!value) return "—";
  let str: string | null = null;
  if (typeof value === "number" && value > 15000 && value < 80000) {
    const excelEpoch = new Date(1899, 11, 30);
    str = new Date(excelEpoch.getTime() + value * 86400000).toISOString().split("T")[0];
  } else if (typeof value === "string") {
    str = value;
  } else {
    return String(value);
  }
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(str)) return str;
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  }
  return str || "—";
}

/**
 * Renderer for the compact scalar columns: truncates to the column width with
 * the full value on hover, so a longer-than-expected value can never push the
 * row height out or force the table wider than its column budget.
 */
function compactText(value: unknown): ReactNode {
  const v = value === null || value === undefined ? "" : String(value).trim();
  if (!v) return "—";
  return (
    <span className="block truncate" title={v}>
      {v}
    </span>
  );
}

export type SortField = "daysOnWaitlist" | "dateAdded" | "name";
export type SortDirection = "asc" | "desc";

export const umbrellaColors: Record<UmbrellaId, string> = {
  WL: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  PS: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  SCH: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
  REF: "bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300",
  PMR: "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300",
  INS: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
};

/**
 * Abbreviate a provider name to "First L." for the Assigned Provider column,
 * which is tight on horizontal space.
 *
 * DISPLAY LAYER ONLY, and only here. Contact cards, assignment modals, provider
 * management and the CSV export all keep full names — a CSV has no space
 * constraint and abbreviating there would destroy information.
 *
 * Names that don't fit "First Last" (single word, or three+ parts) are returned
 * untouched rather than guessed at.
 */
export function abbreviateProviderName(fullName: string): string {
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
export function buildProviderDisplayMap(fullNames: string[]): Record<string, string> {
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

/** Per-row and per-table values the cell renderers need. */
export interface WaitlistCellCtx {
  statusCode: number;
  umbrella: UmbrellaId | null;
  umbrellaLabel: string;
  statusLabel: string;
  isInactive: boolean;
  daysWaiting: number;
  /** Contacts flagged "Attention Required" — computed once for the whole table. */
  flaggedIds: Set<number>;
  /** fullName -> display name, collision-aware; computed across all contacts. */
  providerDisplayNames: Record<string, string>;
  currentUserEmail?: string;
}

/** Sort state, for the two columns with sortable headers. */
export interface WaitlistHeaderCtx {
  sortField: SortField;
  sortDirection: SortDirection;
  toggleSort: (field: SortField) => void;
}

export interface WaitlistColumnDef {
  /** Stable, persisted identifier. Never rename — see the file header. */
  id: string;
  /** Human label, used in the header and in the column picker. */
  label: string;
  /** Tailwind width/padding for the <TableHead>. */
  widthClass?: string;
  /** Tailwind classes for each <TableCell>. */
  cellClass?: string;
  /** Default position. User ordering overrides this; it's the fallback. */
  order: number;
  /** Cannot be hidden or moved, and is excluded from the picker. */
  alwaysVisible?: boolean;
  /** Whether the column is on for a user with no saved preferences. */
  defaultVisible: boolean;
  /** Custom header (sortable columns); plain label when omitted. */
  header?: (h: WaitlistHeaderCtx) => ReactNode;
  render: (contact: WaitlistContact, ctx: WaitlistCellCtx) => ReactNode;
}

function SortIcon({ field, sortField, sortDirection }: { field: SortField } & Pick<WaitlistHeaderCtx, "sortField" | "sortDirection">) {
  if (sortField !== field) {
    return <ArrowUpDown className="h-4 w-4 text-muted-foreground/50" />;
  }
  return sortDirection === "asc" ? (
    <ArrowUp className="h-4 w-4" />
  ) : (
    <ArrowDown className="h-4 w-4" />
  );
}

/**
 * The columns, in default order.
 *
 * Column tightening (client request): Status, Days Waiting, Service, Insurance,
 * Modality and Assigned To are width-capped with tighter horizontal padding so
 * everything fits at 1440px without horizontal scroll. Name is deliberately
 * unconstrained so it stays fully readable.
 */
export const WAITLIST_COLUMNS: WaitlistColumnDef[] = [
  {
    id: "name",
    label: "Name",
    order: 0,
    alwaysVisible: true,
    defaultVisible: true,
    cellClass: "font-medium",
    header: ({ toggleSort, sortField, sortDirection }) => (
      <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => toggleSort("name")}>
        Name
        <SortIcon field="name" sortField={sortField} sortDirection={sortDirection} />
      </Button>
    ),
    render: (contact, ctx) => (
      <>
        <Link href={`/contact/${contact.contactId}`}>
          <span className={cn("hover:underline", ctx.isInactive ? "text-muted-foreground italic" : "text-primary")}>
            {contact.name}
          </span>
        </Link>
        {ctx.flaggedIds.has(contact.contactId) && (
          <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0 h-4 text-amber-600 border-amber-400/50 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-600/30">
            <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
            Attn
          </Badge>
        )}
        {ctx.isInactive && (
          <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0 h-4 text-muted-foreground border-muted-foreground/30">
            Inactive
          </Badge>
        )}
      </>
    ),
  },
  {
    id: "umbrella",
    label: "Umbrella",
    order: 1,
    defaultVisible: true,
    widthClass: "w-[104px]",
    render: (_contact, ctx) =>
      ctx.umbrella && (
        <Badge className={cn("font-normal", umbrellaColors[ctx.umbrella])}>{ctx.umbrellaLabel}</Badge>
      ),
  },
  {
    id: "status",
    label: "Status",
    order: 2,
    defaultVisible: true,
    widthClass: "w-[168px] px-2",
    cellClass: "px-2",
    render: (_contact, ctx) => (
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{ctx.statusCode}</span>
        <span className={cn("text-xs leading-tight", ctx.isInactive && "italic")}>{ctx.statusLabel}</span>
      </div>
    ),
  },
  {
    id: "daysWaiting",
    label: "Days Waiting",
    order: 3,
    defaultVisible: true,
    widthClass: "w-[76px] px-2",
    cellClass: "px-2",
    header: ({ toggleSort, sortField, sortDirection }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 h-8 px-1"
        onClick={() => toggleSort("daysOnWaitlist")}
        title="Days Waiting"
      >
        Days
        <SortIcon field="daysOnWaitlist" sortField={sortField} sortDirection={sortDirection} />
      </Button>
    ),
    render: (_contact, ctx) => (
      <span
        className={cn(
          "font-medium",
          !ctx.isInactive && ctx.daysWaiting >= 60 && "text-red-600 dark:text-red-400",
          !ctx.isInactive && ctx.daysWaiting >= 30 && ctx.daysWaiting < 60 && "text-amber-600 dark:text-amber-400"
        )}
      >
        {ctx.daysWaiting}
      </span>
    ),
  },
  {
    id: "service",
    label: "Service",
    order: 4,
    defaultVisible: true,
    widthClass: "w-[116px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => contact.requestingFor ?? contact.serviceRequested ?? "—",
  },
  {
    id: "insurance",
    label: "Insurance",
    order: 5,
    defaultVisible: true,
    widthClass: "w-[104px] px-2",
    cellClass: "px-2",
    render: (contact) =>
      contact.insurancePayer ? (
        // Full stored value on hover — the column abbreviates, but staff must be
        // able to see exactly what a record holds, especially for legacy strings.
        <span className="text-xs text-foreground whitespace-nowrap" title={contact.insurancePayer}>
          {abbreviateInsurance(contact.insurancePayer)}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
  },
  {
    id: "modality",
    label: "Modality",
    order: 6,
    defaultVisible: true,
    widthClass: "w-[120px] px-2",
    cellClass: "px-2",
    render: (contact) => {
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
                // P1 is the choice reports and Insights count, so it reads as
                // primary; the rest are muted.
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
    },
  },
  {
    id: "assignedTo",
    label: "Assigned To",
    order: 7,
    defaultVisible: true,
    widthClass: "w-[92px] px-2",
    cellClass: "px-2",
    render: (contact, ctx) => (
      <OwnerBadge
        email={contact.assignedTo}
        currentUserEmail={ctx.currentUserEmail}
        showUnassigned={false}
        size="sm"
      />
    ),
  },
  {
    id: "assignedProvider",
    label: "Assigned Provider",
    order: 8,
    defaultVisible: true,
    widthClass: "w-[124px] px-2",
    cellClass: "px-2 text-xs",
    render: (contact, ctx) =>
      contact.assignedProviderName ? (
        // Full name stays available on hover, so abbreviating costs nothing when
        // someone needs to be certain.
        <span className="text-foreground font-medium whitespace-nowrap" title={contact.assignedProviderName}>
          {ctx.providerDisplayNames[contact.assignedProviderName] ??
            abbreviateProviderName(contact.assignedProviderName)}
        </span>
      ) : (
        <span className="text-muted-foreground">No provider</span>
      ),
  },
  {
    id: "paperwork",
    label: "Paperwork",
    order: 9,
    defaultVisible: true,
    widthClass: "w-[92px] px-2",
    cellClass: "px-2",
    render: (contact) =>
      contact.paperworkStatus ? (
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 h-4 font-normal whitespace-nowrap text-muted-foreground border-muted-foreground/30"
        >
          {contact.paperworkStatus}
        </Badge>
      ) : (
        // Blank, not a dash: "not tracked yet" should read as absence, not as a
        // value staff need to interpret.
        <span />
      ),
  },
  // ---------------------------------------------------------------------------
  // OPTIONAL COLUMNS — off by default, enabled per user in the column picker.
  // All four are already carried by the board payload (getAllSyncContacts puts
  // ~50 fields on the wire); none required a query change.
  // ---------------------------------------------------------------------------
  {
    id: "dateAdded",
    label: "Date Added",
    order: 11,
    defaultVisible: false,
    widthClass: "w-[104px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    // dateAdded remains the default SORT field even while this column is
    // hidden — the two are independent.
    render: (contact) => formatListDate(contact.dateAdded),
  },
  {
    id: "language",
    label: "Language",
    order: 12,
    defaultVisible: false,
    widthClass: "w-[88px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => (contact as { language?: string | null }).language || "—",
  },
  {
    id: "email",
    label: "Email",
    order: 13,
    defaultVisible: false,
    widthClass: "w-[180px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) =>
      contact.email ? (
        // Truncated with the full address on hover — addresses are long and
        // would otherwise force the table wide.
        <span className="block max-w-[172px] truncate" title={contact.email}>
          {contact.email}
        </span>
      ) : (
        "—"
      ),
  },
  {
    id: "phone",
    label: "Phone",
    order: 14,
    defaultVisible: false,
    widthClass: "w-[116px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground whitespace-nowrap",
    render: (contact) => contact.phone || "—",
  },
  // --- Phase 2 additions. Compact scalars only: anything long (reason for
  // therapy, detailed reason, last note, prior services, street address) is
  // deliberately absent — it wraps, blows up row height, and belongs on the
  // contact card. Identifier-class fields (insurance member ID, referral auth
  // number, patient DOB) are also excluded: putting them in a browsable list
  // column meaningfully widens on-screen exposure, and that is a client call.
  {
    id: "lastContact",
    label: "Last Contact",
    order: 15,
    defaultVisible: false,
    widthClass: "w-[104px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).lastContact),
  },
  {
    id: "insurancePlan",
    label: "Insurance Plan",
    order: 16,
    defaultVisible: false,
    widthClass: "w-[128px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).insurancePlan),
  },
  {
    id: "insuranceStatus",
    label: "Insurance Status",
    order: 17,
    defaultVisible: false,
    widthClass: "w-[112px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).insuranceStatus),
  },
  {
    id: "referralSource",
    label: "Referral Source",
    order: 18,
    defaultVisible: false,
    widthClass: "w-[128px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).referralSource),
  },
  {
    id: "referralStatus",
    label: "Referral Status",
    order: 19,
    defaultVisible: false,
    widthClass: "w-[112px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).referralStatus),
  },
  {
    id: "preferredContact",
    label: "Preferred Contact",
    order: 20,
    defaultVisible: false,
    widthClass: "w-[116px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).preferredContact),
  },
  {
    id: "age",
    label: "Age",
    order: 21,
    defaultVisible: false,
    widthClass: "w-[60px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => (typeof (contact as any).age === "number" ? String((contact as any).age) : "—"),
  },
  {
    id: "gender",
    label: "Gender",
    order: 22,
    defaultVisible: false,
    widthClass: "w-[80px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).gender),
  },
  {
    id: "city",
    label: "City",
    order: 23,
    defaultVisible: false,
    widthClass: "w-[112px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).city),
  },
  {
    id: "county",
    label: "County",
    order: 24,
    defaultVisible: false,
    widthClass: "w-[104px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).county),
  },
  {
    id: "state",
    label: "State",
    order: 25,
    defaultVisible: false,
    widthClass: "w-[64px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).state),
  },
  {
    id: "zipCode",
    label: "Zip",
    order: 26,
    defaultVisible: false,
    widthClass: "w-[76px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).zipCode),
  },
  {
    id: "formCompletedBy",
    label: "Form Completed By",
    order: 27,
    defaultVisible: false,
    widthClass: "w-[136px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).formCompletedBy),
  },
  {
    id: "priorProvider",
    label: "Prior Provider",
    order: 28,
    defaultVisible: false,
    widthClass: "w-[128px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).priorProvider),
  },
  {
    id: "priority",
    label: "Priority",
    order: 29,
    defaultVisible: false,
    widthClass: "w-[88px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).priority),
  },
  {
    id: "custody",
    label: "Custody",
    order: 30,
    defaultVisible: false,
    widthClass: "w-[96px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).custody),
  },
  {
    id: "flags",
    label: "Flags",
    order: 31,
    defaultVisible: false,
    widthClass: "w-[96px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).flags),
  },
  {
    id: "intakeSource",
    label: "Intake Source",
    order: 32,
    defaultVisible: false,
    widthClass: "w-[112px] px-2",
    cellClass: "px-2 text-xs text-muted-foreground",
    render: (contact) => compactText((contact as any).intakeSource),
  },
  {
    id: "household",
    label: "Household",
    order: 10,
    defaultVisible: true,
    cellClass: "text-xs",
    render: (contact) =>
      contact.householdMembers && contact.householdMembers.length > 0 ? (
        <div className="space-y-0.5">
          {contact.householdMembers.map((m, i) => {
            const conflict =
              !!m.assignedProviderName &&
              !!contact.assignedProviderName &&
              m.assignedProviderName === contact.assignedProviderName;
            return (
              <div key={i} className="whitespace-nowrap">
                <span className="text-foreground font-medium">
                  {m.name}
                  {m.dob ? ` (${formatDob(m.dob)})` : ""}
                </span>
                {m.assignedProviderName && (
                  <span
                    className={cn(
                      "ml-1",
                      conflict ? "text-red-600 dark:text-red-400 font-semibold" : "text-muted-foreground"
                    )}
                  >
                    · {conflict ? "⚠ same: " : ""}
                    {m.assignedProviderName}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

/** Lookup by id, for resolving persisted column ids. */
export const WAITLIST_COLUMNS_BY_ID: Record<string, WaitlistColumnDef> = Object.fromEntries(
  WAITLIST_COLUMNS.map((c) => [c.id, c])
);

/** Default visible ids in default order — the "stock" view, and the reset target. */
export const DEFAULT_VISIBLE_COLUMN_IDS: string[] = WAITLIST_COLUMNS
  .slice()
  .sort((a, b) => a.order - b.order)
  .filter((c) => c.defaultVisible)
  .map((c) => c.id);

/** Every column id in default order. */
export const ALL_COLUMN_IDS_IN_DEFAULT_ORDER: string[] = WAITLIST_COLUMNS
  .slice()
  .sort((a, b) => a.order - b.order)
  .map((c) => c.id);
