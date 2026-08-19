/**
 * Waitlist column-config regression tests — `npm run test:columns`.
 *
 * Guards the columns-as-config refactor. Rather than snapshotting HTML (which
 * needs a DOM and trips over wouter's SSR requirements), these walk the React
 * element tree each renderer returns and assert on structure and className.
 * That targets exactly the details the refactor could silently break: badge
 * variants, the Household same-provider conflict highlight, and the P1 emphasis
 * on modality badges.
 */
import {
  WAITLIST_COLUMNS,
  WAITLIST_COLUMNS_BY_ID,
  DEFAULT_VISIBLE_COLUMN_IDS,
  ALL_COLUMN_IDS_IN_DEFAULT_ORDER,
  type WaitlistCellCtx,
} from "../client/src/components/waitlist/waitlist-columns";

let fails = 0;
const ok = (l: string, c: boolean) => { if (!c) { console.error(`FAIL ${l}`); fails++; } };
const eq = (l: string, a: unknown, e: unknown) => {
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    console.error(`FAIL ${l}\n  expected ${JSON.stringify(e)}\n  actual   ${JSON.stringify(a)}`); fails++;
  }
};

/** Flatten a React element tree into [{type, props}] without rendering it. */
function walk(node: any, out: any[] = []): any[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (typeof node === "object" && node.props) {
    const name = typeof node.type === "string" ? node.type : (node.type?.displayName || node.type?.name || "Component");
    out.push({ name, props: node.props });
    walk(node.props.children, out);
  } else if (typeof node === "string" || typeof node === "number") {
    out.push({ name: "#text", props: { value: String(node) } });
  }
  return out;
}
const classesOf = (nodes: any[]) => nodes.map((n) => n.props?.className).filter(Boolean).join(" ");
const textOf = (nodes: any[]) => nodes.filter((n) => n.name === "#text").map((n) => n.props.value).join("");
const render = (id: string, contact: any, ctx: WaitlistCellCtx) =>
  walk(WAITLIST_COLUMNS_BY_ID[id].render(contact, ctx));

const baseCtx = (over: Partial<WaitlistCellCtx> = {}): WaitlistCellCtx => ({
  statusCode: 102, umbrella: "WL", umbrellaLabel: "Waitlist", statusLabel: "Response Received",
  isInactive: false, daysWaiting: 12, flaggedIds: new Set<number>(),
  providerDisplayNames: {}, currentUserEmail: "staff@tfc.health", ...over,
});
const baseContact = (over: any = {}) => ({
  contactId: 1, name: "Alpha Test", requestingFor: "Myself",
  insurancePayer: "BlueCross BlueShield Turquoise Care",
  modalityP1: "In Person ABQ", modalityP2: "Telehealth",
  assignedTo: "staff@tfc.health", assignedProviderName: "Anna Alvarez",
  paperworkStatus: "Sent", dateAdded: "2026-01-01", daysOnWaitlist: 12,
  householdMembers: [], ...over,
});

// ---------------------------------------------------------------- config shape
eq("15 columns (11 default + 4 optional)", WAITLIST_COLUMNS.length, 15);
eq("default order is the shipped order", ALL_COLUMN_IDS_IN_DEFAULT_ORDER,
  ["name","umbrella","status","daysWaiting","service","insurance","modality","assignedTo","assignedProvider","paperwork","household","dateAdded","language","email","phone"]);
// A user with no saved prefs must see exactly the pre-feature table.
eq("11 visible by default (identical to pre-feature)", DEFAULT_VISIBLE_COLUMN_IDS, 
  ["name","umbrella","status","daysWaiting","service","insurance","modality","assignedTo","assignedProvider","paperwork","household"]);
eq("the 4 optional columns are default-hidden",
  WAITLIST_COLUMNS.filter((c) => !c.defaultVisible).map((c) => c.id), ["dateAdded","language","email","phone"]);
// Internal plumbing must never be offerable.
for (const banned of ["syncHash","syncedAt"]) {
  ok(`${banned} is not a column`, !WAITLIST_COLUMNS.some((c) => c.id === banned));
}
// Status duration is explicitly deferred (needs a query change).
ok("statusDuration is not a column", !WAITLIST_COLUMNS.some((c) => c.id === "statusDuration"));
ok("name is alwaysVisible", !!WAITLIST_COLUMNS_BY_ID.name.alwaysVisible);
ok("only name is alwaysVisible", WAITLIST_COLUMNS.filter((c) => c.alwaysVisible).length === 1);
ok("every column has a unique id", new Set(WAITLIST_COLUMNS.map((c) => c.id)).size === WAITLIST_COLUMNS.length);
ok("order values are unique", new Set(WAITLIST_COLUMNS.map((c) => c.order)).size === WAITLIST_COLUMNS.length);
ok("only name and daysWaiting have custom headers",
   WAITLIST_COLUMNS.filter((c) => c.header).map((c) => c.id).join() === "name,daysWaiting");

// -------------------------------------------------------- width/padding parity
// These are the exact classes the hand-written header carried.
const widths: Record<string, string | undefined> = {
  name: undefined, umbrella: "w-[104px]", status: "w-[168px] px-2", daysWaiting: "w-[76px] px-2",
  service: "w-[116px] px-2", insurance: "w-[104px] px-2", modality: "w-[120px] px-2",
  assignedTo: "w-[92px] px-2", assignedProvider: "w-[124px] px-2", paperwork: "w-[92px] px-2",
  household: undefined,
  dateAdded: "w-[104px] px-2", language: "w-[88px] px-2", email: "w-[180px] px-2", phone: "w-[116px] px-2",
};
for (const [id, w] of Object.entries(widths)) eq(`width parity: ${id}`, WAITLIST_COLUMNS_BY_ID[id].widthClass, w);
const cells: Record<string, string | undefined> = {
  name: "font-medium", umbrella: undefined, status: "px-2", daysWaiting: "px-2",
  service: "px-2 text-xs text-muted-foreground", insurance: "px-2", modality: "px-2",
  assignedTo: "px-2", assignedProvider: "px-2 text-xs", paperwork: "px-2", household: "text-xs",
};
for (const [id, c] of Object.entries(cells)) eq(`cell-class parity: ${id}`, WAITLIST_COLUMNS_BY_ID[id].cellClass, c);

// ------------------------------------------------------------- NAME: badges
{
  const plain = render("name", baseContact(), baseCtx());
  ok("name: no Attn badge when unflagged", !textOf(plain).includes("Attn"));
  ok("name: no Inactive badge when active", !textOf(plain).includes("Inactive"));
  ok("name: active name uses text-primary", classesOf(plain).includes("text-primary"));

  const flagged = render("name", baseContact(), baseCtx({ flaggedIds: new Set([1]) }));
  ok("name: Attn badge when flagged", textOf(flagged).includes("Attn"));
  ok("name: Attn badge is variant=outline",
     flagged.some((n) => n.props?.variant === "outline" && String(n.props?.className).includes("text-amber-600")));

  const inactive = render("name", baseContact(), baseCtx({ isInactive: true }));
  ok("name: Inactive badge when inactive", textOf(inactive).includes("Inactive"));
  ok("name: inactive name is muted + italic",
     classesOf(inactive).includes("text-muted-foreground") && classesOf(inactive).includes("italic"));
}

// ------------------------------------------------------- UMBRELLA: color map
{
  const wl = render("umbrella", baseContact(), baseCtx());
  ok("umbrella: WL uses the slate color class", classesOf(wl).includes("bg-slate-100"));
  const ins = render("umbrella", baseContact(), baseCtx({ umbrella: "INS", umbrellaLabel: "Inactive" }));
  ok("umbrella: INS uses the red color class", classesOf(ins).includes("bg-red-100"));
  eq("umbrella: nothing rendered when umbrella is null",
     WAITLIST_COLUMNS_BY_ID.umbrella.render(baseContact(), baseCtx({ umbrella: null })), null);
}

// ------------------------------------------------- DAYS WAITING: thresholds
{
  ok("days: <30 has no urgency color",
     !/text-(red|amber)-600/.test(classesOf(render("daysWaiting", baseContact(), baseCtx({ daysWaiting: 10 })))));
  ok("days: 30-59 is amber",
     classesOf(render("daysWaiting", baseContact(), baseCtx({ daysWaiting: 45 }))).includes("text-amber-600"));
  ok("days: 60+ is red",
     classesOf(render("daysWaiting", baseContact(), baseCtx({ daysWaiting: 90 }))).includes("text-red-600"));
  ok("days: inactive rows are never colored",
     !/text-(red|amber)-600/.test(classesOf(render("daysWaiting", baseContact(), baseCtx({ daysWaiting: 90, isInactive: true })))));
}

// ------------------------------------------------- MODALITY: P1 emphasis
{
  const n = render("modality", baseContact(), baseCtx());
  const badges = n.filter((x) => x.props?.title);
  eq("modality: one badge per priority", badges.length, 2);
  ok("modality: P1 title says first priority", String(badges[0].props.title).includes("(first priority)"));
  ok("modality: P1 is emphasized (primary classes)",
     String(badges[0].props.className).includes("border-primary/40") &&
     String(badges[0].props.className).includes("font-medium"));
  ok("modality: P2 is muted, NOT emphasized",
     String(badges[1].props.className).includes("text-muted-foreground") &&
     !String(badges[1].props.className).includes("border-primary/40"));
  ok("modality: P2 title says priority 2", String(badges[1].props.title).includes("(priority 2)"));
  ok("modality: abbreviations are used", textOf(n).includes("ABQ") && textOf(n).includes("TH"));
  const unk = render("modality", baseContact({ modalityP1: null, modalityP2: null, modality: "Fax Referral (For staff use only)" }), baseCtx());
  ok("modality: unresolvable renders italic Unknown",
     textOf(unk).includes("Unknown") && classesOf(unk).includes("italic"));
}

// -------------------------------------------- INSURANCE: abbrev + full title
{
  const n = render("insurance", baseContact(), baseCtx());
  ok("insurance: shows abbreviation", textOf(n).includes("BCBS TC"));
  ok("insurance: full value in title", n.some((x) => x.props?.title === "BlueCross BlueShield Turquoise Care"));
  const legacy = render("insurance", baseContact({ insurancePayer: "Tricare" }), baseCtx());
  ok("insurance: legacy value renders as stored", textOf(legacy).includes("Tricare"));
  ok("insurance: empty renders a dash", textOf(render("insurance", baseContact({ insurancePayer: null }), baseCtx())).includes("—"));
}

// ------------------------------------ ASSIGNED PROVIDER: abbrev + collision
{
  const n = render("assignedProvider", baseContact(), baseCtx({ providerDisplayNames: { "Anna Alvarez": "Anna A." } }));
  ok("provider: uses the collision-aware display map", textOf(n).includes("Anna A."));
  ok("provider: full name in title", n.some((x) => x.props?.title === "Anna Alvarez"));
  const collide = render("assignedProvider", baseContact(), baseCtx({ providerDisplayNames: { "Anna Alvarez": "Anna Alvarez" } }));
  ok("provider: collision falls back to the full name", textOf(collide).includes("Anna Alvarez"));
  ok("provider: empty state is 'No provider'",
     textOf(render("assignedProvider", baseContact({ assignedProviderName: null }), baseCtx())).includes("No provider"));
}

// ------------------------------------------- HOUSEHOLD: conflict highlight
{
  const conflict = render("household", baseContact({
    assignedProviderName: "Anna Alvarez",
    householdMembers: [{ name: "Beta Test", dob: "2010-05-05", assignedProviderName: "Anna Alvarez" }],
  }), baseCtx());
  ok("household: same provider is flagged with the warning marker", textOf(conflict).includes("⚠ same: "));
  ok("household: conflict is red + semibold",
     classesOf(conflict).includes("text-red-600") && classesOf(conflict).includes("font-semibold"));
  ok("household: member DOB is formatted", textOf(conflict).includes("(05/05/2010)"));

  const noConflict = render("household", baseContact({
    assignedProviderName: "Anna Alvarez",
    householdMembers: [{ name: "Beta Test", dob: null, assignedProviderName: "Other Person" }],
  }), baseCtx());
  ok("household: different provider is NOT flagged", !textOf(noConflict).includes("⚠ same: "));
  ok("household: non-conflict provider is muted", classesOf(noConflict).includes("text-muted-foreground"));
  ok("household: empty renders a dash", textOf(render("household", baseContact(), baseCtx())).includes("—"));
}

// --------------------------------------------------- PAPERWORK / STATUS / SERVICE
{
  ok("paperwork: value renders in a badge", textOf(render("paperwork", baseContact(), baseCtx())).includes("Sent"));
  const blank = render("paperwork", baseContact({ paperworkStatus: null }), baseCtx());
  ok("paperwork: unset renders blank, not a dash", !textOf(blank).includes("—"));
  const st = render("status", baseContact(), baseCtx());
  ok("status: shows code and label", textOf(st).includes("102") && textOf(st).includes("Response Received"));
  ok("status: inactive label is italic", classesOf(render("status", baseContact(), baseCtx({ isInactive: true }))).includes("italic"));
  eq("service: prefers requestingFor", WAITLIST_COLUMNS_BY_ID.service.render(baseContact(), baseCtx()), "Myself");
  eq("service: falls back to serviceRequested",
     WAITLIST_COLUMNS_BY_ID.service.render(baseContact({ requestingFor: null, serviceRequested: "My Child" }), baseCtx()), "My Child");
  eq("service: em-dash when neither",
     WAITLIST_COLUMNS_BY_ID.service.render(baseContact({ requestingFor: null, serviceRequested: null }), baseCtx()), "—");
}

// ------------------------------------------------ OPTIONAL COLUMN renders
{
  eq("dateAdded: ISO renders MM/DD/YYYY",
     WAITLIST_COLUMNS_BY_ID.dateAdded.render(baseContact({ dateAdded: "2026-01-28" }), baseCtx()), "01/28/2026");
  eq("dateAdded: Excel serial renders MM/DD/YYYY",
     WAITLIST_COLUMNS_BY_ID.dateAdded.render(baseContact({ dateAdded: 45917 as any }), baseCtx()), "09/17/2025");
  eq("dateAdded: null renders a dash",
     WAITLIST_COLUMNS_BY_ID.dateAdded.render(baseContact({ dateAdded: null }), baseCtx()), "—");
  eq("language: value renders",
     WAITLIST_COLUMNS_BY_ID.language.render(baseContact({ language: "Spanish" }), baseCtx()), "Spanish");
  eq("language: null renders a dash",
     WAITLIST_COLUMNS_BY_ID.language.render(baseContact({ language: null }), baseCtx()), "—");
  const em = render("email", baseContact({ email: "person@example.com" }), baseCtx());
  ok("email: renders truncated with full value in title",
     textOf(em).includes("person@example.com") && em.some((n) => n.props?.title === "person@example.com"));
  eq("email: null renders a dash",
     WAITLIST_COLUMNS_BY_ID.email.render(baseContact({ email: null }), baseCtx()), "—");
  eq("phone: value renders",
     WAITLIST_COLUMNS_BY_ID.phone.render(baseContact({ phone: "5055550100" }), baseCtx()), "5055550100");
}

if (fails === 0) console.log("PASS — waitlist columns: config shape, width/class parity, and all render branches OK");
else { console.error(`\n${fails} FAILURES`); process.exit(1); }
