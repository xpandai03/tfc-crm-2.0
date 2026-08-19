/**
 * Saved-view preferences: shape, defaults, and the restore rules.
 *
 * Kept as pure functions separate from the component so the rules that matter
 * most — degradation of stale values and the guarantee that a saved value can
 * never widen access — are unit-testable without rendering a table.
 *
 * The server stores this blob opaquely and never interprets it. All validation
 * happens HERE, at restore time, because this is where the current option lists
 * and access gates live. That ordering is the point: a value saved when a
 * filter existed (or when the user had a gate) is re-checked against today's
 * reality every single time it is applied, rather than trusted from storage.
 */

/** Bump when the shape changes incompatibly; unknown versions are discarded. */
export const VIEW_PREFS_VERSION = 1;

export interface ViewPrefsFilters {
  umbrella: string;
  status: string;
  insurance: string;
  modality: string;
  language: string;
  reason: string;
  serviceType: string;
  hideInactive: boolean;
  /** Assignment filter — lives on the waitlist PAGE and is access-gated. */
  staff: string;
}

export interface ViewPrefs {
  version: number;
  columns: { visible: string[]; order: string[] };
  filters: ViewPrefsFilters;
  sort: { field: string; direction: string };
}

/**
 * searchQuery is deliberately NOT part of this shape. Restoring a stale search
 * would show an apparently-empty waitlist with no visible cause — the single
 * most confusing thing last-state persistence could do.
 */
export const DEFAULT_FILTERS: ViewPrefsFilters = {
  umbrella: "all",
  status: "all",
  insurance: "all",
  modality: "all",
  language: "all",
  reason: "all",
  serviceType: "all",
  hideInactive: true,
  staff: "all",
};

export const DEFAULT_SORT = { field: "daysOnWaitlist", direction: "desc" };

export interface ColumnMetaForRestore {
  id: string;
  order: number;
  defaultVisible: boolean;
  alwaysVisible?: boolean;
}

export interface RestoreContext {
  allColumns: ColumnMetaForRestore[];
  /**
   * Currently-selectable values per filter, as rendered in each dropdown.
   * A saved value absent from its list is stale (a retired insurance, a
   * retired modality) and falls back to "all".
   */
  validOptions: {
    umbrella: string[];
    insurance: string[];
    modality: string[];
    language: string[];
    reason: string[];
    serviceType: string[];
  };
  /** Re-evaluated NOW, never read from the saved blob. */
  canUseStaffFilter: boolean;
  validSortFields: string[];
}

export interface RestoreResult {
  columns: { visible: string[]; order: string[] };
  filters: ViewPrefsFilters;
  sort: { field: string; direction: string };
  /** Human-readable names of filters that were reset, for the notice. */
  resetFilters: string[];
}

function defaultColumns(all: ColumnMetaForRestore[]) {
  const ordered = all.slice().sort((a, b) => a.order - b.order);
  return { visible: ordered.filter((c) => c.defaultVisible).map((c) => c.id), order: ordered.map((c) => c.id) };
}

/** The stock view — what a user with no saved row sees. */
export function defaultPreferences(all: ColumnMetaForRestore[]): RestoreResult {
  return {
    columns: defaultColumns(all),
    filters: { ...DEFAULT_FILTERS },
    sort: { ...DEFAULT_SORT },
    resetFilters: [],
  };
}

const isStr = (v: unknown): v is string => typeof v === "string";

/**
 * Apply a saved blob against today's columns, option lists and access gates.
 *
 * Degradation rules, all deliberate:
 *  - unrecognised version           -> discard everything, use defaults
 *  - unknown column id              -> dropped silently (it no longer exists)
 *  - column id missing from saved   -> appended at its default visibility, so
 *                                      newly-shipped columns actually appear
 *  - alwaysVisible column           -> forced visible and forced to its default
 *                                      position, whatever storage says
 *  - filter value not in its list   -> reset to "all" AND reported, so the user
 *                                      is told rather than left staring at an
 *                                      empty table
 *  - staff filter without the gate  -> reset to "all" (never widens access)
 */
export function applyViewPreferences(raw: unknown, ctx: RestoreContext): RestoreResult {
  const fallback = defaultPreferences(ctx.allColumns);
  if (!raw || typeof raw !== "object") return fallback;
  const p = raw as Partial<ViewPrefs>;
  if (p.version !== VIEW_PREFS_VERSION) return fallback;

  // ---- columns -------------------------------------------------------------
  const known = new Set(ctx.allColumns.map((c) => c.id));
  const byId = new Map(ctx.allColumns.map((c) => [c.id, c]));
  const savedOrder = Array.isArray(p.columns?.order) ? p.columns!.order.filter(isStr) : [];
  const savedVisible = Array.isArray(p.columns?.visible) ? p.columns!.visible.filter(isStr) : null;

  // Saved order first (unknown ids dropped), then anything new appended in its
  // default position so a column shipped after the user last saved shows up.
  const order: string[] = [];
  savedOrder.forEach((id) => { if (known.has(id) && order.indexOf(id) === -1) order.push(id); });
  ctx.allColumns.slice().sort((a, b) => a.order - b.order).forEach((c) => {
    if (order.indexOf(c.id) === -1) order.push(c.id);
  });

  // An alwaysVisible column can't be moved out of its default slot.
  ctx.allColumns.filter((c) => c.alwaysVisible).forEach((c) => {
    const cur = order.indexOf(c.id);
    if (cur !== -1) order.splice(cur, 1);
    order.splice(Math.min(c.order, order.length), 0, c.id);
  });

  const visible = order.filter((id) => {
    const meta = byId.get(id)!;
    if (meta.alwaysVisible) return true;
    if (savedVisible === null) return meta.defaultVisible;
    // A column absent from a saved visible[] is only "off" if the user could
    // have known about it; a newly-shipped column falls back to its default.
    if (savedOrder.indexOf(id) === -1) return meta.defaultVisible;
    return savedVisible.indexOf(id) !== -1;
  });

  // ---- filters -------------------------------------------------------------
  const sf = (p.filters ?? {}) as Partial<ViewPrefsFilters>;
  const filters: ViewPrefsFilters = { ...DEFAULT_FILTERS };
  const resetFilters: string[] = [];

  const takeOption = (key: keyof typeof ctx.validOptions, label: string) => {
    const v = sf[key];
    if (!isStr(v) || v === "all") return;
    if (ctx.validOptions[key].indexOf(v) !== -1) {
      (filters as any)[key] = v;
    } else {
      resetFilters.push(label);
    }
  };
  takeOption("umbrella", "Umbrella");
  takeOption("insurance", "Insurance");
  takeOption("modality", "Modality");
  takeOption("language", "Language");
  takeOption("reason", "Reason");
  takeOption("serviceType", "Service Type");

  // Status is either "all" or a comma-separated code list from an Insights
  // drill-down; validate shape rather than membership.
  if (isStr(sf.status) && sf.status !== "all") {
    const codes = sf.status.split(",").map((x) => parseInt(x.trim(), 10));
    if (codes.length > 0 && codes.every((n) => !Number.isNaN(n))) filters.status = sf.status;
    else resetFilters.push("Status");
  }

  if (typeof sf.hideInactive === "boolean") filters.hideInactive = sf.hideInactive;

  // ACCESS GATE — evaluated now, never trusted from storage. A user who has
  // lost the staff filter cannot have it restored, no matter what was saved.
  if (isStr(sf.staff) && sf.staff !== "all") {
    if (ctx.canUseStaffFilter) filters.staff = sf.staff;
    else resetFilters.push("Assigned staff");
  }

  // ---- sort ----------------------------------------------------------------
  const sort = { ...DEFAULT_SORT };
  if (isStr(p.sort?.field) && ctx.validSortFields.indexOf(p.sort!.field) !== -1) {
    sort.field = p.sort!.field;
    sort.direction = p.sort?.direction === "asc" ? "asc" : "desc";
  }

  return { columns: { visible, order }, filters, sort, resetFilters };
}

/** Serialize current UI state into the stored shape. */
export function buildViewPreferences(
  columns: { visible: string[]; order: string[] },
  filters: ViewPrefsFilters,
  sort: { field: string; direction: string },
): ViewPrefs {
  return { version: VIEW_PREFS_VERSION, columns, filters, sort };
}
