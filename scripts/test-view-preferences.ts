/**
 * Saved-view preference tests — `npm run test:view-prefs`.
 *
 * The two things worth guarding hardest:
 *   1. STALE VALUES DEGRADE, they don't strand the user in an empty table.
 *   2. PERSISTENCE CAN NEVER WIDEN ACCESS — a saved value is re-checked against
 *      the live gate every time it's applied, never trusted from storage.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  applyViewPreferences,
  buildViewPreferences,
  defaultPreferences,
  stockView,
  applyNamedView,
  sanitizeNamedViews,
  validateViewName,
  hasDivergedFrom,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  VIEW_PREFS_VERSION,
  MAX_NAMED_VIEWS,
  type ColumnMetaForRestore,
  type NamedView,
} from "../client/src/lib/view-preferences";

let fails = 0;
const ok = (l: string, c: boolean) => { if (!c) { console.error(`FAIL ${l}`); fails++; } };
const eq = (l: string, a: unknown, e: unknown) => {
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    console.error(`FAIL ${l}\n  expected ${JSON.stringify(e)}\n  actual   ${JSON.stringify(a)}`); fails++;
  }
};

const COLS: ColumnMetaForRestore[] = [
  { id: "name", order: 0, defaultVisible: true, alwaysVisible: true },
  { id: "status", order: 1, defaultVisible: true },
  { id: "insurance", order: 2, defaultVisible: true },
  { id: "modality", order: 3, defaultVisible: true },
  { id: "email", order: 4, defaultVisible: false },
];
const CTX = (over: any = {}) => ({
  allColumns: COLS,
  validOptions: {
    umbrella: ["WL", "PS"],
    insurance: ["Aetna", "Medicaid"],
    modality: ["Telehealth", "In Person ABQ"],
    language: ["English", "Spanish"],
    reason: ["Anxiety"],
    serviceType: ["Myself"],
  },
  canUseStaffFilter: false,
  validSortFields: ["daysOnWaitlist", "dateAdded", "name"],
  ...over,
});
const prefs = (over: any = {}) => ({
  version: VIEW_PREFS_VERSION,
  columns: { visible: ["name", "status"], order: ["name", "status", "insurance", "modality", "email"] },
  filters: { ...DEFAULT_FILTERS },
  sort: { field: "daysOnWaitlist", direction: "desc" },
  ...over,
});

// ---------------------------------------------------------- no saved state
{
  const d = applyViewPreferences(null, CTX());
  eq("null prefs -> stock columns", d.columns.visible, ["name", "status", "insurance", "modality"]);
  eq("null prefs -> default filters", d.filters, DEFAULT_FILTERS);
  eq("null prefs -> no notice", d.resetFilters, []);
  eq("defaultPreferences matches the null path", d, defaultPreferences(COLS));
  ok("optional column stays hidden by default", d.columns.visible.indexOf("email") === -1);
}

// ------------------------------------------------------------ version gate
{
  const r = applyViewPreferences(prefs({ version: 99, columns: { visible: ["name"], order: ["name"] } }), CTX());
  eq("unknown version discards to defaults", r.columns.visible, ["name", "status", "insurance", "modality"]);
  eq("garbage input discards to defaults", applyViewPreferences("nope", CTX()).filters, DEFAULT_FILTERS);
}

// ---------------------------------------------------------------- columns
{
  const r = applyViewPreferences(prefs({
    columns: { visible: ["name", "email"], order: ["name", "email", "status", "insurance", "modality"] },
  }), CTX());
  eq("saved order is honored", r.columns.order, ["name", "email", "status", "insurance", "modality"]);
  eq("saved visibility is honored (optional column ON)", r.columns.visible, ["name", "email"]);

  // Unknown ids (a column removed since the user saved) vanish silently.
  const unknown = applyViewPreferences(prefs({
    columns: { visible: ["name", "ghostColumn"], order: ["name", "ghostColumn", "status"] },
  }), CTX());
  ok("unknown column id is dropped", unknown.columns.order.indexOf("ghostColumn") === -1);
  ok("unknown column id never becomes visible", unknown.columns.visible.indexOf("ghostColumn") === -1);

  // A column shipped AFTER the user saved must appear at its default, not be
  // silently invisible forever.
  const newer = applyViewPreferences(prefs({
    columns: { visible: ["name", "status"], order: ["name", "status"] },
  }), CTX());
  ok("newly-shipped default column is appended and visible", newer.columns.visible.indexOf("insurance") !== -1);
  ok("newly-shipped optional column is appended but hidden",
     newer.columns.order.indexOf("email") !== -1 && newer.columns.visible.indexOf("email") === -1);

  // Name is locked: it cannot be hidden or moved, whatever storage says.
  const attack = applyViewPreferences(prefs({
    columns: { visible: ["status"], order: ["status", "insurance", "name"] },
  }), CTX());
  ok("alwaysVisible column cannot be hidden", attack.columns.visible.indexOf("name") !== -1);
  eq("alwaysVisible column is forced back to its default slot", attack.columns.order[0], "name");
}

// ----------------------------------------------------------------- filters
{
  const good = applyViewPreferences(prefs({
    filters: { ...DEFAULT_FILTERS, insurance: "Aetna", modality: "Telehealth", hideInactive: false },
  }), CTX());
  eq("valid values restore", [good.filters.insurance, good.filters.modality], ["Aetna", "Telehealth"]);
  eq("booleans restore", good.filters.hideInactive, false);
  eq("no notice when everything is valid", good.resetFilters, []);

  // The live case: values retired by the canonical-insurance and modality work.
  const stale = applyViewPreferences(prefs({
    filters: { ...DEFAULT_FILTERS, insurance: "Tricare", modality: "Flex" },
  }), CTX());
  eq("retired insurance falls back to all", stale.filters.insurance, "all");
  eq("retired modality falls back to all", stale.filters.modality, "all");
  eq("both are reported for the notice", stale.resetFilters.sort(), ["Insurance", "Modality"]);

  // Status is a drill-down code list, validated by shape not membership.
  eq("valid status code list restores",
     applyViewPreferences(prefs({ filters: { ...DEFAULT_FILTERS, status: "100,101" } }), CTX()).filters.status, "100,101");
  const badStatus = applyViewPreferences(prefs({ filters: { ...DEFAULT_FILTERS, status: "nonsense" } }), CTX());
  eq("malformed status falls back to all", badStatus.filters.status, "all");
  ok("malformed status is reported", badStatus.resetFilters.indexOf("Status") !== -1);

  ok("searchQuery is never restored", !("search" in (good.filters as any)));
}

// ------------------------------------------------- ACCESS GATE (the big one)
{
  const savedWithStaff = prefs({ filters: { ...DEFAULT_FILTERS, staff: "someone@tfc.health" } });

  const denied = applyViewPreferences(savedWithStaff, CTX({ canUseStaffFilter: false }));
  eq("staff filter is stripped when the gate is closed NOW", denied.filters.staff, "all");
  ok("the strip is reported", denied.resetFilters.indexOf("Assigned staff") !== -1);

  const allowed = applyViewPreferences(savedWithStaff, CTX({ canUseStaffFilter: true }));
  eq("staff filter restores when the gate is open", allowed.filters.staff, "someone@tfc.health");

  // Persistence must be PROVABLY unable to widen access: for every saved value,
  // a gate-closed restore can never yield anything but "all".
  const attempts = ["someone@tfc.health", "me", "admin@tfc.health", "*", ""];
  const widened = attempts.filter(
    (v) => applyViewPreferences(prefs({ filters: { ...DEFAULT_FILTERS, staff: v } }),
                                CTX({ canUseStaffFilter: false })).filters.staff !== "all",
  );
  eq("no saved staff value can widen access when gated", widened, []);
}

// -------------------------------------------------------------------- sort
{
  eq("valid sort restores",
     applyViewPreferences(prefs({ sort: { field: "name", direction: "asc" } }), CTX()).sort,
     { field: "name", direction: "asc" });
  eq("unknown sort field falls back",
     applyViewPreferences(prefs({ sort: { field: "bogus", direction: "asc" } }), CTX()).sort,
     { field: "daysOnWaitlist", direction: "desc" });
}

// ------------------------------------------------------------- round trip
{
  const built = buildViewPreferences(
    { visible: ["name", "email"], order: ["name", "email", "status", "insurance", "modality"] },
    { ...DEFAULT_FILTERS, insurance: "Aetna" },
    { field: "name", direction: "asc" },
  );
  eq("built payload carries the version", built.version, VIEW_PREFS_VERSION);
  ok("built payload always carries columns.order", Array.isArray(built.columns.order));
  const back = applyViewPreferences(built, CTX());
  eq("save -> restore round-trips columns", back.columns.visible, ["name", "email"]);
  eq("save -> restore round-trips filters", back.filters.insurance, "Aetna");
  eq("save -> restore round-trips sort", back.sort.field, "name");
}

// --------------------------------------------- SYNC ISOLATION (source guard)
{
  const syncSrc = readFileSync(join(process.cwd(), "server", "sync", "db.ts"), "utf8");
  ok("no sync path references user_view_preferences", !/user_view_preferences/.test(syncSrc));
  const routesSrc = readFileSync(join(process.cwd(), "server", "routes.ts"), "utf8");
  // The endpoints must derive identity from the session, never from input.
  ok("view-prefs endpoints never take a user id from the request",
     !/view-prefs\/:viewKey\/:userId|req\.body\?\.userId|req\.query\.userId/.test(routesSrc));
  ok("view-prefs identity comes from req.user.id", /viewPrefsIdentity/.test(routesSrc));
}

// ============================================================================
// PHASE 2 — named views, Default escape, version migration
// ============================================================================

const mkView = (over: Partial<NamedView> = {}): NamedView => ({
  id: "v1", name: "Scheduling", createdAt: "2026-08-19T00:00:00.000Z",
  columns: { visible: ["name", "email"], order: ["name", "email", "status", "insurance", "modality"] },
  filters: { ...DEFAULT_FILTERS, insurance: "Aetna" },
  sort: { field: "name", direction: "asc" },
  ...over,
});

// ---- v1 payloads still readable (migrate-on-read, NOT discarded) -----------
{
  const v1 = { version: 1, columns: { visible: ["name", "status"], order: ["name", "status", "insurance", "modality", "email"] },
               filters: { ...DEFAULT_FILTERS, insurance: "Aetna" }, sort: { field: "name", direction: "asc" } };
  const r = applyViewPreferences(v1, CTX());
  eq("v1 payload still restores its columns", r.columns.visible, ["name", "status"]);
  eq("v1 payload still restores its filters", r.filters.insurance, "Aetna");
  eq("v1 payload yields an empty named-view list", r.namedViews, []);
  eq("current version is 2", VIEW_PREFS_VERSION, 2);
  const r3 = applyViewPreferences({ ...v1, version: 3 }, CTX());
  eq("a FUTURE version is discarded, not guessed at", r3.columns.visible, ["name", "status", "insurance", "modality"]);
}

// ---- stockView: the Default escape hatch ----------------------------------
{
  const stock = stockView(COLS);
  eq("stock columns are the defaults", stock.columns.visible, ["name", "status", "insurance", "modality"]);
  eq("stock clears every filter", stock.filters, DEFAULT_FILTERS);
  eq("stock sort", stock.sort, DEFAULT_SORT);
  // The whole point: it takes no stored input, so corruption can't break it.
  eq("stockView is pure — identical on repeat calls", stockView(COLS), stockView(COLS));
}

// ---- Default works from a CORRUPTED payload -------------------------------
{
  for (const junk of [null, undefined, "nonsense", 42, [], { version: 1 }, { version: 2, columns: null },
                      { version: 2, columns: { visible: "not-an-array" } }]) {
    const r = applyViewPreferences(junk, CTX());
    ok(`corrupt payload ${JSON.stringify(junk)} still yields usable columns`, r.columns.visible.length > 0);
    ok(`corrupt payload keeps Name`, r.columns.visible.indexOf("name") !== -1);
    ok(`corrupt payload yields no named views`, Array.isArray(r.namedViews));
  }
}

// ---- named-view sanitizing ------------------------------------------------
{
  eq("non-array -> []", sanitizeNamedViews("x"), []);
  eq("malformed entries dropped", sanitizeNamedViews([{ id: "a" }, null, 5, { name: "no cols", id: "b" }]), []);
  const many = Array.from({ length: 20 }, (_, i) => mkView({ id: `v${i}`, name: `View ${i}` }));
  eq("cap enforced on read", sanitizeNamedViews(many).length, MAX_NAMED_VIEWS);
  const long = sanitizeNamedViews([mkView({ name: "x".repeat(80) })]);
  eq("over-long name is truncated, not rejected", long[0].name.length, 30);
}

// ---- APPLY runs the same rules as restore ---------------------------------
{
  // Retired values inside a named view degrade exactly like a restore.
  const stale = mkView({ filters: { ...DEFAULT_FILTERS, insurance: "Tricare", modality: "Flex" } });
  const r = applyNamedView(stale, CTX());
  eq("applying a view resets a retired insurance", r.filters.insurance, "all");
  eq("applying a view resets a retired modality", r.filters.modality, "all");
  eq("the notice names them", r.resetFilters.sort(), ["Insurance", "Modality"]);
  ok("columns still apply despite stale filters", r.columns.visible.indexOf("email") !== -1);

  // Gating: "it was allowed when saved" is NOT authorization.
  const gated = mkView({ filters: { ...DEFAULT_FILTERS, staff: "someone@tfc.health" } });
  eq("gate closed -> staff stripped on APPLY", applyNamedView(gated, CTX({ canUseStaffFilter: false })).filters.staff, "all");
  eq("gate open -> staff restored on APPLY", applyNamedView(gated, CTX({ canUseStaffFilter: true })).filters.staff, "someone@tfc.health");
  const widened = ["a@tfc.health", "me", "*"].filter(
    (v) => applyNamedView(mkView({ filters: { ...DEFAULT_FILTERS, staff: v } }), CTX({ canUseStaffFilter: false })).filters.staff !== "all");
  eq("NO named view can widen access when gated", widened, []);

  // Unknown / new columns behave as in a restore.
  const ghosts = mkView({ columns: { visible: ["name", "ghost"], order: ["name", "ghost", "status"] } });
  const g = applyNamedView(ghosts, CTX());
  ok("unknown column id dropped on apply", g.columns.order.indexOf("ghost") === -1);
  ok("column shipped later is appended on apply", g.columns.order.indexOf("email") !== -1);

  // Name stays locked even if a view says otherwise.
  const attack = mkView({ columns: { visible: ["status"], order: ["status", "name"] } });
  const a = applyNamedView(attack, CTX());
  ok("apply cannot hide Name", a.columns.visible.indexOf("name") !== -1);
  eq("apply cannot move Name", a.columns.order[0], "name");
}

// ---- name validation ------------------------------------------------------
{
  const existing = [mkView({ id: "a", name: "Scheduling" })];
  ok("empty name rejected", validateViewName("   ", existing).ok === false);
  ok("31 chars rejected", validateViewName("x".repeat(31), existing).ok === false);
  ok("30 chars accepted", validateViewName("x".repeat(30), existing).ok === true);
  ok("duplicate rejected case-insensitively", validateViewName("scheduling", existing).ok === false);
  ok("renaming a view to its own name is allowed", validateViewName("Scheduling", existing, "a").ok === true);
  const trimmed = validateViewName("  Admin  ", existing);
  ok("name is trimmed", trimmed.ok === true && trimmed.name === "Admin");
}

// ---- divergence never mutates the view ------------------------------------
{
  const v = mkView();
  const same = { columns: v.columns, filters: v.filters, sort: v.sort };
  ok("identical state is not diverged", !hasDivergedFrom(v, same));
  const changed = { columns: { visible: ["name"], order: v.columns.order }, filters: v.filters, sort: v.sort };
  ok("hidden column marks diverged", hasDivergedFrom(v, changed));
  const filterChanged = { columns: v.columns, filters: { ...v.filters, insurance: "Medicaid" }, sort: v.sort };
  ok("filter change marks diverged", hasDivergedFrom(v, filterChanged));
  // hasDivergedFrom must be read-only.
  const snapshot = JSON.stringify(v);
  hasDivergedFrom(v, changed);
  eq("checking divergence does not mutate the view", JSON.stringify(v), snapshot);
}

// ---- round trip carries named views ---------------------------------------
{
  const views = [mkView({ id: "a", name: "Scheduling" }), mkView({ id: "b", name: "Admin" })];
  const built = buildViewPreferences(
    { visible: ["name", "status"], order: ["name", "status", "insurance", "modality", "email"] },
    { ...DEFAULT_FILTERS }, { ...DEFAULT_SORT }, views);
  eq("payload is version 2", built.version, 2);
  eq("named views ride in the same blob", built.namedViews?.length, 2);
  const back = applyViewPreferences(built, CTX());
  eq("named views survive the round trip", back.namedViews.map((v) => v.name), ["Scheduling", "Admin"]);
  ok("payload stays well under the 20KB cap", JSON.stringify(built).length < 20000);
  // Eight full views must still fit the cap.
  const eight = Array.from({ length: MAX_NAMED_VIEWS }, (_, i) => mkView({ id: `v${i}`, name: `View number ${i}` }));
  const big = buildViewPreferences(built.columns, built.filters, built.sort, eight);
  ok(`${MAX_NAMED_VIEWS} views fit the 20KB cap (${JSON.stringify(big).length}B)`, JSON.stringify(big).length < 20000);
}

if (fails === 0) console.log("PASS — view preferences: degradation, column rules, gate safety, round-trip, sync isolation OK");
else { console.error(`\n${fails} FAILURES`); process.exit(1); }
