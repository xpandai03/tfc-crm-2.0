/**
 * Waitlist: the optional "Initial appointment date" column (2026-10-15).
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/test-waitlist-initial-appointment.ts
 *
 * No database. Source checks for the payload and the saved-view sort list.
 * Every value is invented.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  ALL_COLUMN_IDS_IN_DEFAULT_ORDER,
  DEFAULT_VISIBLE_COLUMN_IDS,
  WAITLIST_COLUMNS_BY_ID,
  compareOptionalIsoDate,
  type WaitlistCellCtx,
} from "../client/src/components/waitlist/waitlist-columns";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

function walk(node: any, out: any[] = []): any[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (typeof node === "object" && node.props) { out.push(node); walk(node.props.children, out); }
  else if (typeof node === "string" || typeof node === "number") out.push({ text: String(node) });
  return out;
}
const text = (node: unknown) => walk(node).filter((n) => "text" in n).map((n) => n.text).join("");
const ctx: WaitlistCellCtx = {
  statusCode: 100, umbrella: "WL", umbrellaLabel: "Waitlist", statusLabel: "New",
  isInactive: false, daysWaiting: 3, flaggedIds: new Set<number>(), providerDisplayNames: {},
};
const row = (over: Record<string, unknown> = {}) => ({ contactId: 7, name: "ZZTEST Row", ...over }) as any;

console.log("\n[1] Registered, optional, directly after Date Added");
const col = WAITLIST_COLUMNS_BY_ID.initialAppointment;
ok("registered in the column list (the custom-views picker reads it)", !!col);
eq("label", col?.label, "Initial appointment date");
eq("off by default", col?.defaultVisible, false);
ok("not in the stock visible set", !DEFAULT_VISIBLE_COLUMN_IDS.includes("initialAppointment"));
const i = ALL_COLUMN_IDS_IN_DEFAULT_ORDER.indexOf("dateAdded");
eq("default order: Date Added, then Initial appointment date",
  ALL_COLUMN_IDS_IN_DEFAULT_ORDER.slice(i, i + 2), ["dateAdded", "initialAppointment"]);

console.log("\n[2] Renders the scheduling card's date; blank when none");
eq("an ISO date renders MM/DD/YYYY, no day shift", text(col.render(row({ scheduledAppointmentDate: "2026-10-20" }), ctx)), "10/20/2026");
eq("no appointment renders blank (not a dash)", text(col.render(row({ scheduledAppointmentDate: null }), ctx)), "");
eq("absent field renders blank", text(col.render(row(), ctx)), "");

console.log("\n[3] Sorts like the other date columns; none last either way");
const dates = ["2026-11-02", null, "2026-10-20", "", "2026-10-27"];
eq("ascending", dates.slice().sort((a, b) => compareOptionalIsoDate(a, b, "asc")), ["2026-10-20", "2026-10-27", "2026-11-02", null, ""]);
eq("descending", dates.slice().sort((a, b) => compareOptionalIsoDate(a, b, "desc")), ["2026-11-02", "2026-10-27", "2026-10-20", null, ""]);
ok("the column header toggles the initialAppointment sort",
  /toggleSort\("initialAppointment"\)/.test(read("client", "src", "components", "waitlist", "waitlist-columns.tsx")));
ok("the list view sorts on it", /sortField === "initialAppointment"/.test(read("client", "src", "components", "waitlist", "waitlist-list-view.tsx")));
ok("saved views accept it as a sort field",
  /validSortFields: \[[^\]]*"initialAppointment"/.test(read("client", "src", "pages", "waitlist.tsx")));

console.log("\n[4] On the board payload");
ok("getAllSyncContacts selects scheduled_appointment_date",
  /scheduled_appointment_date AS "scheduledAppointmentDate",\s*\n\s*referral_source/.test(read("server", "sync", "db.ts")));

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
