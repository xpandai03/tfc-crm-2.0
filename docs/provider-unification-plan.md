# Provider Data-Model Unification Plan

> Status: **planning / approved direction** — investigation + 5-phase plan. No code or data changes have been made.
> Target (decided): `crm_providers` = single source of truth; **email = universal join key (UNIQUE)**; spreadsheet + `PROVIDER_LIST` demoted to import/derived; matching already reads the merged list incl. CRM providers; `provider_availability` stays an email-joined satellite.
> Live release at time of writing: **v135**. Verified against prod (read-only) on 2026-06-09.

---

## 1. Current-state map — the three stores (+ satellites)

| Store | Key | Holds | Written by | Email? |
|---|---|---|---|---|
| **`crm_providers`** (DB) | `id` SERIAL | name, credentials, location, specialties(JSON), age_groups(JSON), insurances(JSON), notes, is_active | `POST /api/providers` (Add Provider), `PATCH /api/providers/:id` (staff edit) | **NO email column** |
| **Spreadsheet roster** (xlsx file, read live each GET) | positional `id:i-1`, joined by **name** | name, credentials, location, ageGroups skill matrix, notes | manual dev-era seed import (`scripts/csv-to-providers-xlsx.mjs`) | NO |
| **`provider_overrides`** (DB) | `provider_name` TEXT UNIQUE | specialties, insurances, populations, notes, age_groups, suppressed | `PATCH /api/providers/override` (staff edit of roster providers) | NO |
| **`PROVIDER_LIST`** (hardcoded TS, `server/email/provider-location-config.ts`) | **name → email/credential** | name, credential, email (28 entries) | hand-edited config | **YES — the only canonical email registry today** |
| **`provider_availability`** (DB, satellite) | `provider_email` TEXT UNIQUE | accepting_clients, special_considerations, last_form_submitted_at | `POST /api/provider-availability` (provider form), `PATCH` (staff) | YES (email) |

Emails live in exactly two places: `PROVIDER_LIST` (config) and `provider_availability.provider_email`. **`crm_providers` has none.**

---

## 2. Current-state map — consumers → stores (load-bearing)

| Consumer | R/W | Store + key | CRM providers covered? |
|---|---|---|---|
| Providers tab | read | `GET /api/providers` (3-source merge) | ✅ |
| Add Provider form | write | `crm_providers` by `id`; **captures no email** | ✅ (no email) |
| **Matching engine** | read | `GET /api/providers` via `useProviders()` → `computeProviderMatches[V2]` | ✅ **already includes CRM providers** |
| Staff skills/insurance edit | write | CRM→`crm_providers` (`PATCH /:id`); roster→`provider_overrides` (name) | ✅ for CRM |
| **Assign dropdown** | read | `GET /api/email-config` → **`PROVIDER_LIST`** | ❌ PROVIDER_LIST only |
| **Email / CC resolution** | read | `getProviderEmail(name)` → **`PROVIDER_LIST`** | ❌ |
| **Availability form** | write | `provider_availability` by **email**, validated vs `PROVIDER_LIST` | ❌ (CRM provider w/o PROVIDER_LIST entry rejected) |
| Availability merge (in GET) | read | `provider_availability` by email; name→email via `getProviderEmail` (PROVIDER_LIST) | ⚠️ only if in PROVIDER_LIST |

### The two load-bearing answers (verified)
- **Matching already reads `crm_providers`?** **YES** — matching consumes `GET /api/providers`, which pushes every active `crm_providers` row in (`id:10000+cp.id`, `_crmManaged:true`). Post-v134, with correct insurances + skill matrix.
- **Do provider-filled forms write `crm_providers`?** **NO** — the only provider-filled form is **availability**, which writes the email-keyed **`provider_availability`** satellite. There is **no provider-filled skills/insurance form** (those are staff-edited).

**How close is Option 1?** The *read* side (Providers tab + matching) already uses the merged list incl. `crm_providers`. The entire gap is the **email / `PROVIDER_LIST` axis** (Assign, email/CC, availability) plus the fact that **the real providers still live in `PROVIDER_LIST`/spreadsheet, not in `crm_providers`**.

---

## 3. Verified availability / email path (end-to-end)

1. **Provider submits the availability form** (standalone Fly app) → `POST /api/provider-availability` (public, `X-Provider-Form-Key`) → validates the email against `PROVIDER_LIST` (`getProviderByEmail`) → `upsertProviderAvailability({ providerEmail, providerName, acceptingClients, specialConsiderations, lastFormSubmittedAt })` into **`provider_availability`** (UNIQUE `provider_email`, lowercased). Also audited to `form_submissions`. **Never writes `crm_providers`.**
2. **Surfacing on the card** — `GET /api/providers` builds `availabilityByEmail` (keyed by lowercased `provider_email`), then per provider: `email = getProviderEmail(name)` *(PROVIDER_LIST bridge)* → `row = availabilityByEmail.get(email)` → sets `acceptingClients`, `specialConsiderations`, `lastFormSubmittedAt`.
3. **Auto-decrement on assignment** — `effectiveAcceptingClients = max(0, row.acceptingClients − assignedSinceForm)`, where `assignedSinceForm` = count of latest assignments to this provider (matched by `normalizeProviderName`) since `lastFormSubmittedAt`. On assignment create/delete the provider cache is nulled (`providerDataCache = null`), so the next read recomputes the decremented count.

**What changes once `crm_providers` owns email:** step 2's `getProviderEmail`(PROVIDER_LIST) bridge is replaced by a **direct join `provider_availability.provider_email = crm_providers.email`**; the satellite + the name-keyed assignment decrement stay. Removing the PROVIDER_LIST bridge fixes the "CRM provider without a PROVIDER_LIST entry silently skips the availability merge" gap.

---

## 4. Email-key readiness — VERIFIED (read-only inventory, prod, 2026-06-09)

| Store | Count | Email presence | Uniqueness |
|---|---|---|---|
| `crm_providers` | **8 rows: 1 active, 7 inactive** | **no email column yet** | — |
| `PROVIDER_LIST` | **28** | **28/28 have email** | **28 unique, all `@tfc.health`, 0 dups** |
| `provider_availability` | **22 rows** | 22 emails | **22 distinct, 0 dups** (subset of PROVIDER_LIST) |
| Spreadsheet roster | **26 names** | none | — |

- **`crm_providers` is essentially empty of real data:** 7 inactive **test-junk** rows (two empty-name, three "Victor Von Doom" variants, one "Han Solo") + **1 active test "Ginger Rippey"**. **No real providers are in `crm_providers` today.**
- **Email uniqueness: CLEAN.** No duplicate emails, no shared/role addresses, no non-`@tfc.health` domains, in either `PROVIDER_LIST` or `provider_availability`.
- **Name↔email coverage for real providers: 100%.** All 28 canonical providers (PROVIDER_LIST) already have unique emails. **The Phase-2 email-backfill list for real providers is EMPTY.** The only email-less rows are the 7 CRM test-junk rows — those are **deleted, not backfilled.**
- **Case caveat:** Ginger is `GRippey@tfc.health` in PROVIDER_LIST vs `grippey@tfc.health` in availability → the UNIQUE key must be on **`lower(email)`** (store lowercased), as `provider_availability` already does.
- **Roster delta:** 26 roster names vs 28 PROVIDER_LIST — the 2-row delta + the 6 PROVIDER_LIST providers with no availability row (danielle, lgarcia-rosecrans, cindy, alute, lmuehlmeyer, ksimmons — all have emails) are reconcile details, not blockers. Phase 2's dry-run must cross-check roster names → PROVIDER_LIST emails and list any roster name with no email match.

### Email-as-UNIQUE verdict
**Email is a sound UNIQUE key.** Adopt `crm_providers.email` as **`UNIQUE` (on lowercased value; a partial unique index on non-null email is the safe transition form)**. The constraint **doubles as the duplicate-from-retries guard**: a create→remove→recreate cycle (which produced the 7 junk rows) would collide on email and be prevented/upserted instead of duplicating.

---

## 5. Target design (Option 1, concrete)

- **`crm_providers` = single source of truth**, gaining `email TEXT` (UNIQUE on lower(email), the universal join key) alongside the existing fields.
- **`provider_availability`** stays a satellite, joined to `crm_providers` **by email**.
- **Consumers post-unification:**
  - Providers tab + matching: unchanged (already read merged list; merge becomes `crm_providers`-only once roster is imported).
  - Assign dropdown + email/CC + availability validation: read **`crm_providers` by email** (a derived provider list / `getProviderEmail` built from the table, replacing the hardcoded `PROVIDER_LIST`).
  - Add Provider form: **captures email** (required for real providers).
  - `provider_overrides`: retired once roster rows are first-class `crm_providers` rows.
- **Spreadsheet → one-off/occasional import script then retired; `PROVIDER_LIST` → derived from the table (or kept only as import seed).**

---

## 6. Data reconciliation strategy (existing records → one canonical row each)

1. **Inventory** all sources (done above).
2. **Canonical key = lower(email).** Build the canonical set from `PROVIDER_LIST` (name+email+credential) ⨝ spreadsheet/overrides (skills/insurances, matched by `normalizeProviderName`) ⨝ existing `crm_providers` (by normalized name).
3. **Dedup/merge:** one `crm_providers` row per email; prefer existing active CRM data where present, fill gaps from roster/overrides/PROVIDER_LIST; attach email. Normalized-name collisions → **flag, never auto-merge** (reuse v132 collision-logging discipline).
4. **Stale/junk resolution in the same pass:** the 7 inactive test rows + the active test Ginger are reviewed and removed/kept explicitly — **no silent deletes**, reviewed list only.
5. **Idempotent + dry-run first:** the reconcile script emits a **proposed mapping table (source rows → canonical row)** for human review before any write. The email UNIQUE constraint makes re-runs idempotent.

---

## 7. Phased migration plan (ordered low-risk-first; each independently shippable + reversible)

**Phase 1 — Add `email` to `crm_providers` (UNIQUE on lower(email)) + capture it in Add Provider/edit.**
- *Changes:* guarded `ADD COLUMN IF NOT EXISTS email TEXT` + a `CREATE UNIQUE INDEX ... ON crm_providers (lower(email)) WHERE email IS NOT NULL` (init-on-boot, the proven v133 mechanism — **not** RUN_MIGRATIONS); email field in the Add Provider/edit modal + `createCrmProvider`/`updateCrmProvider`.
- *Unblocks:* the join key + dedup guard exist. *Verify:* column + partial-unique index present; create a provider with an email, read it back; duplicate email rejected. *Rollback:* additive/unused → drop or leave. *Blast radius:* tiny; nothing reads it yet.

**Phase 2 — Import roster + PROVIDER_LIST into `crm_providers`; reconcile dups (dry-run first).**
- *Changes:* reconcile script (per §6) proposes a mapping, then on approval creates canonical `crm_providers` rows (name, credential, **email**, skills/insurances from roster+overrides), and lists the 7 junk rows to retire. **No consumer repointed yet.** Backfill for real providers = none (emails all present).
- *Unblocks:* `crm_providers` becomes the complete, email-keyed provider set. *Verify:* all 28 canonical providers have an active `crm_providers` row with email; counts reconcile; junk-row list reviewed. *Rollback:* consumers unchanged; CRM rows already merge. *Blast radius:* writes data, reads unchanged — low functional risk. **Absorbs stale-Ginger/junk cleanup.**

**Phase 3 — Repoint Assign dropdown + email/CC + availability validation to `crm_providers` by email.**
- *Changes:* `/api/email-config` + `getProviderEmail`/`getProviderByEmail` read `crm_providers` (active, with email); `PROVIDER_LIST` becomes fallback/seed.
- *Unblocks:* **CRM-created providers become assignable + emailable + availability-eligible.** *Verify:* a CRM-only provider (email, no PROVIDER_LIST entry) shows in the Assign dropdown with credential and assigns successfully; CC resolves. *Rollback:* revert read source to `PROVIDER_LIST` (kept intact until Phase 5). *Blast radius:* medium; gated by Phase 2 completeness. **Absorbs assign-credential gap + CRM-not-assignable gap.**

**Phase 4 — Confirm/repoint matching + fold availability join to email.**
- *Changes:* matching likely **no change** (already reads merged list); availability merge joins `provider_availability.provider_email = crm_providers.email` directly (drop PROVIDER_LIST name-bridge). *Verify:* matching still returns all providers; availability shows for an email-joined provider. *Rollback:* keep name-bridge fallback. *Blast radius:* low. **Absorbs availability PROVIDER_LIST gap.**

**Phase 5 — Demote spreadsheet to import / retire `PROVIDER_LIST` + `provider_overrides`.**
- *Changes:* stop reading the xlsx live in `GET /api/providers` (merge becomes `crm_providers`-only); keep csv→xlsx+reconcile as occasional import or retire; remove `PROVIDER_LIST` as a live source; retire `provider_overrides`. *Verify:* `GET /api/providers` returns the full set from `crm_providers` alone; matching/Providers tab unchanged. *Rollback:* re-enable xlsx merge. *Blast radius:* highest — **last**, only after 2–4 prove `crm_providers` authoritative. **Absorbs v132 name-keyed rename fragility + roster-suppression complexity** (removal becomes plain `is_active=false`).

---

## 8. Queued issues absorbed by which phase

| Queued issue | Resolved by |
|---|---|
| Stale Ginger data + 7 inactive test-junk rows | **Phase 2** |
| Duplicate-from-retries pattern | **Phase 1** (email UNIQUE guard) + Phase 2 |
| CRM-providers-not-assignable / assign-credential gap | **Phase 3** |
| Availability PROVIDER_LIST gap (CRM providers can't submit/merge availability) | **Phase 3 + 4** |
| v132 name-keyed override/suppression rename fragility | **Phase 5** |
| `reminders.is_second_reminder` integer drift | **Separate** (not provider-model) |
| Modal-scroll UI bug | **Separate** (pure UI) |

---

## 9. Open questions / runtime datapoints

1. **Credentials source of truth** post-import: `PROVIDER_LIST.credential` vs `crm_providers.credentials` — pick `crm_providers` (recommended).
2. **Roster→PROVIDER_LIST name coverage** (26 vs 28): Phase 2 dry-run must list any roster name with no email match (none expected, confirm).
3. **Availability ownership:** keep `provider_availability` as an email-joined satellite (recommended) vs. fold `accepting_clients` into `crm_providers` (affects Phase 4 scope).
4. **Email immutability:** if a provider's email changes, the join + UNIQUE key must be updated atomically — define an email-change path in Phase 1/3.

---

*Bottom line:* Option 1 is closer than it looks — matching + Providers tab already read the merged list incl. `crm_providers`; the gap is the email/`PROVIDER_LIST` axis. Email is verified as a clean UNIQUE key (28 unique `@tfc.health`, 0 dups, 100% real-provider coverage). The real work is **importing the 28 canonical providers into `crm_providers` (Phase 2)** and repointing the email-axis consumers (Phase 3) — both gated behind the additive Phase 1.
