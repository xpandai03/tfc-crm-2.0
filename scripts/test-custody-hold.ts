/**
 * Custody document status, the manual account hold, and guardians on the
 * intake PDF — `npm run test:custody-hold`.
 *
 * No database. The persistence and timeline half is
 * scripts/test-custody-hold-db.ts, which needs a throwaway local Postgres.
 *
 * NO PHI. Every identity is ZZTEST / example.invalid
 * (scripts/fixtures/intake-pdf-guardians.json).
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  CUSTODY_DOC_STATUSES,
  isValidCustodyDocStatus,
} from "../shared/custody-doc-status";
import {
  HOLD_REASONS,
  HOLD_REASON_OTHER,
  holdBannerText,
  holdHoverText,
  isOnHold,
  isValidHoldReason,
} from "../shared/account-hold";
import {
  WAITLIST_COLUMNS,
  WAITLIST_COLUMNS_BY_ID,
  type WaitlistCellCtx,
} from "../client/src/components/waitlist/waitlist-columns";
import { buildIntakeDocument, buildSubmissionDocument } from "../server/pdf/intake-template";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)?.slice(0, 200)} != ${JSON.stringify(b)?.slice(0, 200)}`);

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

// ---------------------------------------------------------------------------
console.log("\n[1] Custody document status: values and validation");
eq("the four states are blank + three options", [...CUSTODY_DOC_STATUSES], ["Not needed", "Requested", "Received"]);
for (const v of [null, undefined, "", "Not needed", "Requested", "Received"]) {
  ok(`accepts ${JSON.stringify(v)}`, isValidCustodyDocStatus(v));
}
for (const v of ["requested", "Sent", "Yes", 1, {}]) {
  ok(`refuses ${JSON.stringify(v)}`, !isValidCustodyDocStatus(v));
}
const routes = read("server", "routes.ts");
ok("the PATCH route validates custodyDocStatus",
  /"custodyDocStatus" in fields && !isValidCustodyDocStatus\(fields\.custodyDocStatus\)/.test(routes));
const db = read("server", "sync", "db.ts");
ok("custodyDocStatus is a safe intake field (so it saves and is logged like paperwork)",
  /custodyDocStatus: "custody_doc_status"/.test(db));

// ---------------------------------------------------------------------------
console.log("\n[2] Account hold: reasons, wording, manual only");
eq("the four reasons, verbatim", [...HOLD_REASONS],
  ["Missing custody documents", "Missing VA referral", "Missing insurance ID", "Other (see notes)"]);
for (const r of HOLD_REASONS) ok(`"${r}" is a valid reason`, isValidHoldReason(r));
for (const r of ["", "Other", "missing custody documents", null, 3]) ok(`${JSON.stringify(r)} is not`, !isValidHoldReason(r));
eq("hover for a named reason is the reason", holdHoverText("Missing custody documents"), "Missing custody documents");
eq('hover for Other reads "Other: see notes"', holdHoverText(HOLD_REASON_OTHER), "Other: see notes");
eq("banner reads On hold: <reason>", holdBannerText("Missing VA referral"), "On hold: Missing VA referral");
ok("only holdActive === true is a hold", isOnHold({ holdActive: true }) && !isOnHold({ holdActive: false })
  && !isOnHold({}) && !isOnHold(null) && !isOnHold({ holdActive: null }));

// Manual only: the hold is derived from NOTHING. A VA client with an empty
// insurance ID and custody docs marked Requested is not on hold.
ok("an empty insurance ID and Requested custody docs are not a hold",
  !isOnHold({ holdActive: false, ...({ insuranceId: "", custodyDocStatus: "Requested", insurancePayer: "VA" } as object) }));
const holdModule = read("shared", "account-hold.ts");
ok("isOnHold reads holdActive and nothing else",
  /export function isOnHold\(c: HoldState \| null \| undefined\): boolean \{\s*return c\?\.holdActive === true;\s*\}/.test(holdModule));

// The only writers of the hold columns are the two functions in sync/db.ts, and
// the only caller of those is server/contacts/account-hold.ts, which the two
// routes call. Walk the whole server tree to prove there is no other path.
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsFiles(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}
const serverFiles = tsFiles(join(process.cwd(), "server")).concat(tsFiles(join(process.cwd(), "shared")));
const writers = serverFiles.filter((f) => /hold_active\s*=\s*(TRUE|FALSE|\$)/i.test(readFileSync(f, "utf8")));
eq("hold_active is written in exactly one file", writers.map((f) => f.replace(process.cwd() + "/", "")), ["server/sync/db.ts"]);
const callers = serverFiles.filter((f) => /\b(setContactHold|clearContactHold)\(/.test(readFileSync(f, "utf8"))
  && !f.endsWith(join("sync", "db.ts")));
eq("setContactHold / clearContactHold are called only by the hold module",
  callers.map((f) => f.replace(process.cwd() + "/", "")), ["server/contacts/account-hold.ts"]);
ok("the intake PATCH cannot touch the hold columns",
  !/hold(Active|Reason|Note): "hold_/.test(db.slice(db.indexOf("const SAFE_INTAKE_FIELDS"), db.indexOf("export async function updateContactIntakeFields"))));
ok("custody status and hold are independent: the custody path never mentions a hold",
  !/hold/i.test(db.slice(db.indexOf("export async function updateContactIntakeFields"), db.indexOf("// Manual account hold"))));
ok("both routes exist and delegate to the hold module",
  /app\.post\("\/api\/contact\/:id\/hold",[\s\S]{0,400}putContactOnHold\(/.test(routes)
    && /app\.post\("\/api\/contact\/:id\/hold\/clear",[\s\S]{0,400}takeContactOffHold\(/.test(routes));
const holdServer = read("server", "contacts", "account-hold.ts");
ok("the activity entry carries the reason, never the note",
  /metadata: \{\s*reason,/.test(holdServer) && !/metadata:[^}]*note/i.test(holdServer));

// Sync ownership (the July-incident guard, extended in test-modality.ts too).
for (const col of ["custody_doc_status", "hold_active", "hold_reason", "hold_note"]) {
  ok(`${col} is not written by an ON CONFLICT DO UPDATE`, !new RegExp(`${col}\\s*=\\s*EXCLUDED`).test(db));
}

// ---------------------------------------------------------------------------
console.log("\n[3] Contact page: banner on top, controls reused");
const page = read("client", "src", "pages", "contact-detail.tsx");
const layoutStart = page.indexOf("<PageLayout>");
const bannerAt = page.indexOf('data-testid="banner-account-hold"', layoutStart);
ok("the hold banner is the first thing inside PageLayout, above the fallback banner",
  bannerAt > layoutStart && bannerAt < page.indexOf("<FallbackBanner", layoutStart));
ok("the banner shows only while on hold", /\{onHold && \(\s*<div[\s\S]{0,400}banner-account-hold/.test(page));
ok("the banner text is holdBannerText(reason)", page.includes("{holdBannerText(contact?.holdReason)}"));
ok("the banner is red", /banner-account-hold/.test(page) && /bg-red-50[\s\S]{0,200}banner-account-hold/.test(page));
ok("custody docs uses the same Select as Paperwork Status",
  /select-custodyDocStatus[\s\S]{0,400}CUSTODY_DOC_STATUSES\.map/.test(page));
ok("the hold reason dropdown lists HOLD_REASONS", /select-holdReason[\s\S]{0,300}HOLD_REASONS\.map/.test(page));
ok("the note box appears only for Other", /holdReasonDraft === HOLD_REASON_OTHER && \(\s*<Textarea/.test(page));
ok("hold entries appear on the contact's timeline",
  /\[[^\]]*"contact_hold_set", "contact_hold_cleared"[^\]]*\]\.includes\(a\.type\)/.test(page));

// ---------------------------------------------------------------------------
console.log("\n[4] Waitlist: the red ! by hold state, inside the frozen Name column");
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
const ctx: WaitlistCellCtx = {
  statusCode: 100, umbrella: "WL", umbrellaLabel: "Waitlist", statusLabel: "New",
  isInactive: false, daysWaiting: 3, flaggedIds: new Set<number>(), providerDisplayNames: {},
};
const contactRow = (over: Record<string, unknown> = {}) =>
  ({ contactId: 7, name: "ZZTEST Row", ...over }) as any;
const nameCell = (c: any) => walk(WAITLIST_COLUMNS_BY_ID.name.render(c, ctx));
const badgeIn = (nodes: any[]) => nodes.find((n) => n.props?.["data-testid"] === "hold-badge-7");

const held = nameCell(contactRow({ holdActive: true, holdReason: "Missing custody documents" }));
const badge = badgeIn(held);
ok("on hold -> badge present", !!badge);
eq("  hover reads the reason", badge?.props.title, "Missing custody documents");
ok("  it is red", /text-red-600/.test(badge?.props.className ?? ""));
ok("  it comes before the name link", held.indexOf(badge) < held.findIndex((n) => n.props?.href === "/contact/7"));
ok("  inline, not a block — cannot add a row", /inline-flex/.test(badge?.props.className ?? "") && !/\bblock\b|\bh-(5|6|8)\b/.test(badge?.props.className ?? ""));
eq("Other -> hover reads Other: see notes",
  badgeIn(nameCell(contactRow({ holdActive: true, holdReason: HOLD_REASON_OTHER, holdNote: "free text" })))?.props.title,
  "Other: see notes");
ok("the free-text note never reaches the row",
  !JSON.stringify(nameCell(contactRow({ holdActive: true, holdReason: HOLD_REASON_OTHER, holdNote: "free text" }))
    .map((n) => ({ ...n.props, children: undefined }))).includes("free text"));
ok("not on hold -> no badge", !badgeIn(nameCell(contactRow({ holdActive: false, holdReason: null }))));
ok("cleared hold (reason gone) -> no badge", !badgeIn(nameCell(contactRow({ holdActive: false }))));
ok("no hold fields at all (old payload) -> no badge", !badgeIn(nameCell(contactRow())));
ok("custody docs Requested alone -> no badge", !badgeIn(nameCell(contactRow({ custodyDocStatus: "Requested" }))));
ok("a VA client with an empty insurance ID -> no badge",
  !badgeIn(nameCell(contactRow({ insurancePayer: "VA Community Care", insuranceId: "" }))));

// Frozen column: the list view freezes visibleColumns[0] in scroll mode, and
// Name is the only alwaysVisible column at order 0 — so the badge, being in
// Name's renderer, is in the frozen cell in both modes.
const nameCol = WAITLIST_COLUMNS.find((c) => c.id === "name")!;
ok("Name is alwaysVisible at order 0", nameCol.alwaysVisible === true && nameCol.order === 0);
const listView = read("client", "src", "components", "waitlist", "waitlist-list-view.tsx");
ok("scroll mode freezes the first column, body and header",
  listView.includes('isOverflowing && i === 0 && "sticky left-0 z-20 bg-inherit"')
    && listView.includes('isOverflowing && i === 0 && "sticky left-0 z-30 bg-white dark:bg-gray-900"'));
// Regression guard for the defect found here: tailwind-merge keeps the LAST of
// sticky/relative, so any "sticky … relative" string silently un-freezes Name.
const { twMerge } = await import("tailwind-merge");
ok("the frozen cell's classes still resolve to sticky after cn()",
  twMerge("sticky left-0 z-20 bg-inherit").includes("sticky"));
ok("no frozen-cell class string pairs sticky with relative",
  !/"sticky left-0 z-[23]0 bg-inherit relative"/.test(listView));
// The overflow hook measures the element that scrolls (the Table primitive's
// wrapper), not the overflow-hidden card around it.
const hook = read("client", "src", "components", "waitlist", "use-overflow.ts");
ok("the overflow hook measures the table's scroll container",
  /el\.querySelector\("table"\)\?\.parentElement \?\? el/.test(hook));
ok("the list view has no hold logic of its own (the badge lives in the Name renderer)",
  !/isOnHold|holdActive|holdReason|hold-badge/.test(listView));

// ---------------------------------------------------------------------------
console.log("\n[5] Optional columns: one registration each, off by default");
const custodyCol = WAITLIST_COLUMNS_BY_ID.custodyDocs;
const holdCol = WAITLIST_COLUMNS_BY_ID.hold;
ok("Custody docs column registered, default hidden", custodyCol?.label === "Custody docs" && custodyCol.defaultVisible === false);
ok("Hold column registered, default hidden", holdCol?.label === "Hold" && holdCol.defaultVisible === false);
const text = (nodes: any[]) => nodes.filter((n) => n.name === "#text").map((n) => n.props.value).join("");
eq("custody column shows the value", text(walk(custodyCol.render(contactRow({ custodyDocStatus: "Received" }), ctx))), "Received");
eq("hold column shows the reason", text(walk(holdCol.render(contactRow({ holdActive: true, holdReason: "Missing VA referral" }), ctx))), "Missing VA referral");
eq("hold column is a dash when not on hold", text(walk(holdCol.render(contactRow(), ctx))), "—");

// ---------------------------------------------------------------------------
console.log("\n[6] Intake PDF: Guardians after Participants, nothing else changed");
const fx = JSON.parse(read("scripts", "fixtures", "intake-pdf-guardians.json"));
const golden = JSON.parse(read("scripts", "fixtures", "intake-pdf-guardians.golden.json"));
const strip = (d: Record<string, unknown>) => JSON.parse(JSON.stringify({ ...d, footer: undefined }));
const texts = (d: any): string[] => JSON.stringify(d).match(/"text":"[^"]*"/g) ?? [];

const withG = strip(buildIntakeDocument(fx.contact, fx.payloadWithGuardians));
const withoutG = strip(buildIntakeDocument(fx.contact, fx.payloadWithoutGuardians));
eq("no guardians -> the document is byte-identical to before", withoutG, golden.intakeWithoutGuardiansPayload);
ok("no guardians -> no GUARDIANS heading", !JSON.stringify(withoutG).includes("GUARDIANS"));
eq("empty guardians array -> identical too",
  strip(buildIntakeDocument(fx.contact, { ...fx.payloadWithoutGuardians, guardians: [] })), golden.intakeWithoutGuardiansPayload);
eq("blank guardian rows -> identical too",
  strip(buildIntakeDocument(fx.contact, { ...fx.payloadWithoutGuardians, guardians: [{ firstName: " " }, {}] })), golden.intakeWithoutGuardiansPayload);
ok("no payload at all -> no GUARDIANS section, no throw",
  !JSON.stringify(strip(buildIntakeDocument(fx.contact, null))).includes("GUARDIANS"));

const c = withG.content as any[];
const gIdx = c.findIndex((b) => b.text === "GUARDIANS");
const pIdx = c.findIndex((b) => b.text === "PARTICIPANTS");
const iIdx = c.findIndex((b) => b.text === "INSURANCE");
ok("GUARDIANS heading present", gIdx > 0);
ok("after PARTICIPANTS, before INSURANCE", pIdx >= 0 && pIdx < gIdx && gIdx < iIdx);
const guardianBlock = c.slice(gIdx, iIdx);
// heading + rule + 4 rows per guardian
eq("two guardians x four rows, plus heading and rule", guardianBlock.length, 2 + 8);
const labels = guardianBlock.slice(2).map((b) => `${b.columns[0].text}=${b.columns[1].text}`);
eq("each guardian's name, relationship, phone, email in order", labels, [
  "Guardian 1 — Name=ZZTEST Parent One",
  "Guardian 1 — Relationship=Mother",
  "Guardian 1 — Phone=(505) 555-0102",
  "Guardian 1 — Email=zztest.parent1@example.invalid",
  "Guardian 2 — Name=ZZTEST Parent Two",
  "Guardian 2 — Relationship=Father",
  "Guardian 2 — Phone=(505) 555-0103",
  "Guardian 2 — Email=zztest.parent2@example.invalid",
]);
eq("guardian rows use the same style as participant rows",
  guardianBlock[2].columns.map((col: any) => [col.style, col.width]),
  c[pIdx + 2].columns.map((col: any) => [col.style, col.width]));
const withoutBlock = { ...withG, content: [...c.slice(0, gIdx), ...c.slice(iIdx)] };
eq("removing the Guardians block gives back exactly the old document", withoutBlock, golden.intakeWithGuardiansPayload);
ok("guardians are not listed as participants", !texts(c.slice(pIdx, gIdx)).some((t) => t.includes("Parent")));
eq("one guardian -> unnumbered labels",
  (strip(buildIntakeDocument(fx.contact, { ...fx.payloadWithGuardians, guardians: [fx.payloadWithGuardians.guardians[0]] })).content as any[])
    .filter((b) => b.columns?.[0]?.text?.startsWith("Guardian")).map((b) => b.columns[0].text),
  ["Guardian — Name", "Guardian — Relationship", "Guardian — Phone", "Guardian — Email"]);
eq("a missing field is left out, not printed blank",
  (strip(buildIntakeDocument(fx.contact, { guardians: [{ firstName: "ZZTEST", lastName: "Only Name" }] })).content as any[])
    .filter((b) => b.columns?.[0]?.text?.startsWith("Guardian")).map((b) => b.columns[0].text),
  ["Guardian — Name"]);
for (const k of ["pageSize", "pageMargins", "styles", "defaultStyle"]) {
  eq(`${k} unchanged`, withG[k], golden.intakeWithGuardiansPayload[k]);
}

// The per-submission PDF gets the same section.
const sub = strip(buildSubmissionDocument({
  id: 1, name: fx.contact.name, createdAt: "2026-09-24T00:00:00.000Z", submittedAt: "2026-09-24T00:00:00.000Z",
  payload: { ...fx.contact, ...fx.payloadWithGuardians },
} as any));
const sc = sub.content as any[];
const sg = sc.findIndex((b) => b.text === "GUARDIANS");
const si = sc.findIndex((b) => b.text === "INSURANCE");
ok("per-submission PDF: GUARDIANS after PARTICIPANTS", sg > sc.findIndex((b) => b.text === "PARTICIPANTS") && sg < si);
eq("per-submission PDF: otherwise identical to before",
  { ...sub, content: [...sc.slice(0, sg), ...sc.slice(si)] }, golden.submissionWithGuardiansPayload);

// Survey PDFs are a different builder and never see this.
ok("the survey PDF builder does not reference guardians", !/guardian/i.test(read("server", "pdf", "survey-template.ts")));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
