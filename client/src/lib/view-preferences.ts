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

/**
 * Version 2 adds `namedViews` alongside the existing last-state fields.
 *
 * NOT a breaking change: a v1 payload is upgraded on read (v1 has no named
 * views, so the upgrade is "attach an empty list"), and every v1 field keeps
 * its exact meaning. That is why this is a migrate-on-read bump rather than a
 * new table — the last-state blob and the named views are read together, written
 * together, and capped together, so splitting them across rows would buy
 * nothing and cost a second round trip on every page load.
 */
export const VIEW_PREFS_VERSION = 2;
/** Versions we can still read (older ones are upgraded, not discarded). */
const READABLE_VERSIONS = [1, 2];

/** Per-user cap. Enforced server-side too; this is the client-side guard. */
export const MAX_NAMED_VIEWS = 8;
export const MAX_VIEW_NAME_LENGTH = 30;

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

/** A user-named arrangement. Snapshot only — applying one copies it into the
 *  working state; it is never live-linked, so later tweaks can't mutate it. */
export interface NamedView {
  id: string;
  name: string;
  createdAt: string;
  columns: { visible: string[]; order: string[] };
  filters: ViewPrefsFilters;
  sort: { field: string; direction: string };
}

export interface ViewPrefs {
  version: number;
  /** Last-state (Phase 1). Unchanged in meaning. */
  columns: { visible: string[]; order: string[] };
  filters: ViewPrefsFilters;
  sort: { field: string; direction: string };
  /** Phase 2. Absent on a v1 payload. */
  namedViews?: NamedView[];
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
  /** The user's saved arrangements, validated on read. */
  namedViews: NamedView[];
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
    namedViews: [],
  };
}

/**
 * The stock arrangement, derived from the column config alone.
 *
 * Deliberately takes NO stored input. The Default chip must work when saved
 * prefs are missing, stale or corrupt — it is the escape hatch, so it cannot
 * depend on the thing the user may be escaping from.
 */
export function stockView(all: ColumnMetaForRestore[]): {
  columns: { visible: string[]; order: string[] };
  filters: ViewPrefsFilters;
  sort: { field: string; direction: string };
} {
  return {
    columns: defaultColumns(all),
    filters: { ...DEFAULT_FILTERS },
    sort: { ...DEFAULT_SORT },
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
  // Migrate-on-read: a v1 payload is valid, it simply has no named views.
  // Anything we don't recognise is discarded rather than guessed at.
  if (typeof p.version !== "number" || READABLE_VERSIONS.indexOf(p.version) === -1) return fallback;

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

  return {
    columns: { visible, order },
    filters,
    sort,
    resetFilters,
    namedViews: sanitizeNamedViews((p as ViewPrefs).namedViews),
  };
}

/**
 * Keep only structurally-sound named views. A malformed entry is dropped rather
 * than repaired: a half-understood arrangement applied to someone's table is
 * worse than one that quietly isn't offered.
 *
 * NOTE: this validates SHAPE only. Filter values and access gates are checked
 * at APPLY time by applyNamedView, because that is when the current option
 * lists and gates are known — and because "it was allowed when saved" is not
 * authorization.
 */
export function sanitizeNamedViews(raw: unknown): NamedView[] {
  if (!Array.isArray(raw)) return [];
  const out: NamedView[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const nv = v as Partial<NamedView>;
    if (!isStr(nv.id) || !isStr(nv.name) || !nv.name.trim()) continue;
    if (!nv.columns || !Array.isArray(nv.columns.visible) || !Array.isArray(nv.columns.order)) continue;
    out.push({
      id: nv.id,
      name: nv.name.trim().slice(0, MAX_VIEW_NAME_LENGTH),
      createdAt: isStr(nv.createdAt) ? nv.createdAt : "",
      columns: { visible: nv.columns.visible.filter(isStr), order: nv.columns.order.filter(isStr) },
      filters: { ...DEFAULT_FILTERS, ...(nv.filters ?? {}) },
      sort: {
        field: isStr(nv.sort?.field) ? nv.sort!.field : DEFAULT_SORT.field,
        direction: nv.sort?.direction === "asc" ? "asc" : "desc",
      },
    });
    if (out.length >= MAX_NAMED_VIEWS) break;
  }
  return out;
}

/**
 * Apply a named view to the working state.
 *
 * Runs the SAME validation and gating as a fresh restore, by construction: it
 * builds a v-current payload from the snapshot and hands it to
 * applyViewPreferences. A named view therefore cannot do anything a restore
 * couldn't — it can't resurrect a retired filter value, and it can't hand back
 * an access the user has since lost.
 */
export function applyNamedView(view: NamedView, ctx: RestoreContext): RestoreResult {
  return applyViewPreferences(
    {
      version: VIEW_PREFS_VERSION,
      columns: view.columns,
      filters: view.filters,
      sort: view.sort,
    },
    ctx,
  );
}

/** Name rules: trimmed, 1-30 chars, unique per user case-insensitively. */
export function validateViewName(
  name: string,
  existing: NamedView[],
  ignoreId?: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required" };
  if (trimmed.length > MAX_VIEW_NAME_LENGTH) {
    return { ok: false, error: `Name must be ${MAX_VIEW_NAME_LENGTH} characters or fewer` };
  }
  const clash = existing.some(
    (v) => v.id !== ignoreId && v.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (clash) return { ok: false, error: "You already have a view with that name" };
  return { ok: true, name: trimmed };
}

/** True when the working state differs from a named view's snapshot. */
export function hasDivergedFrom(
  view: NamedView,
  current: { columns: { visible: string[]; order: string[] }; filters: ViewPrefsFilters; sort: { field: string; direction: string } },
): boolean {
  return JSON.stringify({ c: view.columns, f: view.filters, s: view.sort })
      !== JSON.stringify({ c: current.columns, f: current.filters, s: current.sort });
}

/** Serialize current UI state into the stored shape. */
export function buildViewPreferences(
  columns: { visible: string[]; order: string[] },
  filters: ViewPrefsFilters,
  sort: { field: string; direction: string },
  namedViews: NamedView[] = [],
): ViewPrefs {
  // Named views ride in the same blob as last-state so a single write keeps
  // them consistent — an auto-save can never drop them.
  return { version: VIEW_PREFS_VERSION, columns, filters, sort, namedViews };
}
