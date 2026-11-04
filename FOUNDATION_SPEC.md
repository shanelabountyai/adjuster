# SaaS Foundation — Spec

Status: **APPROVED v2** · 2026-09-23 · implementation plan: `IMPLEMENTATION_PLAN.md`.
Previous draft (Drizzle + Auth.js), **old — do not use**: `OLD_DO_NOT_USE_FOUNDATION_SPEC.drizzle-draft.md`.

A reusable starter template, cloned for each new project, on **Next.js 16 + Prisma 7 (`@prisma/adapter-pg`) +
Neon**, with **magic-link + TOTP auth and no passwords**. It is distilled from the existing builds. Evidence paths
below are relative to `~/Projects/`.

**Verification labels.** `✔` = I re-read the cited lines myself this session. Unmarked = reported with file:line
by a read-only audit agent, not re-checked by me. `UNVERIFIED` = nobody confirmed it.

---

## 0. Decisions log

| # | Decision | Why |
|---|---|---|
| D-1 | Reusable **starter template**, not a shared package — *amended by D-7* | No forced migration of live repos; each clone owns its code. |
| ~~D-2~~ | ~~Drizzle + Neon + Auth.js v5 on Next 16~~ — superseded by D-2′ | Its premise ("UCS is the only repo on this stack") was also incomplete: event toolkit is Drizzle too. |
| D-2′ | **Prisma 7 + `@prisma/adapter-pg` on Next 16 + Neon.** | ✔ Portfolio is 12 Prisma / 2 Drizzle (`package.json` sweep of `~/Projects`). The three newest apps — clinic, groundwork, showcall — all chose Prisma 7 + adapter-pg; the two Drizzle repos have been idle since 08-14 (UCS) and 08-29 (event toolkit). §9 shows the security gaps have nothing to do with the ORM. |
| D-3 | v1 scope: auth + orgs, roles + audit log, email + notifications, Stripe billing. **Full scope** was re-confirmed after the PO review. | Billing and notifications ship as **optional modules** (§4). |
| ~~D-4~~ | ~~rental's Auth.js JWT + password + TOTP~~ — superseded by D-4′ | Rental's authentication code is ~1,750 lines (✔ `wc -l`), and all of its security-relevant logic is ours to own. Auth.js's own Credentials docs say: "we recommend … Email Magic Links, or WebAuthn (Passkeys) … instead". |
| D-4′ | **Magic link + TOTP, no passwords, no Auth.js.** groundwork's hashed DB sessions and POST-to-spend links (✔ `groundwork/src/session.ts`) + rental's TOTP and sealed secrets (✔ `rental business/packages/core/auth/totp.ts`, `secret-box.ts`). TOTP is required for owner/admin. | Removing passwords removes that threat class entirely: credential stuffing, the reset flow, lockout, breach checks. The code is ~300–400 lines, already written and tested in two repos, with no beta dependency. Accepted cost: every sign-in goes through email. |
| D-5 | **Per-repo security fixes are separate backlog items**, not part of this project. | Storage webhook, groundwork log leak and Bookable IDORs ship independently of the template. |
| D-6 | **Use-Case Studio is frozen.** Only 3 security fixes land, in place. | Idle since 08-14; convergence would now require an ORM port. |
| D-7 | **Extract a shared core package after clone #3.** Until then, tagged template versions + `FOUNDATION_VERSION` in each clone. | Fixes must reach clones; this is cheap to do by hand at 1–3 clones and worth automating after that. |
| D-9 | **No named first consumer.** Boxloop is not being built (and may never be); the first clone is the next new project, whatever it is. Boxloop's PRD stays an input for conventions only. | 2026-09-23, Shane. |
| D-8 | **Demo and e2e sign-in via `DEMO_MODE` sign-in-as**, only for seeded `isDemo` users. | `DEMO.md` works and Playwright needs no email. groundwork's e2e already signs in by inserting a token (`e2e/sign-in.ts:10-20`). |
| D-10 | **Open sign-up by magic link.** An unknown email at `/login` gets a "create your account" link and a known one gets a "sign in" link. The on-screen response is identical either way. The `User` row is created when the link is redeemed. | Codex review #4, 2026-09-23, Shane. The old rule ("unknown email: nothing sent") left onboarding with no way in. |
| D-11 | **Only an owner can grant, change or remove the `owner` role.** An admin can assign `admin`/`member` and remove non-owners only. | Codex review #1. It is the same bug as event toolkit SEC-01. |
| D-12 | **Security-relevant routes in `src/app` are template-owned** (the list is in the plan, §3.2). Their logic lives in `src/core`, and each route file stays a thin call. | Codex review #3: otherwise a core security fix can't reach the route that uses it. |
| S1 ✔ | **Spike S1 passed (M0, 2026-09-23):** multi-file schema with module back-relations. `prisma validate` + `generate` + `tsc` + `next build` pass with both modules and after removing them per §4, and a marker-aware diff of `core.prisma` is clean on the removed tree (a negative control proves it still flags an unmarked edit). **Addition to the removal procedure: also `rm -rf .next`**, because its generated route types still name the deleted routes and fail `tsc`. Re-run: `spikes/s1/run.sh`. | The fallback (plain `orgId` column, hand-written FK) is not needed. |
| S2 ✔ | **Spike S2 passed (M0, 2026-09-23): the harness is vitest, not Playwright.** vitest imports `'use server'` modules directly, with `next/headers` and `next/navigation` mocked (`spikes/s2/setup.ts`). **Picked: `orgAction(perm, zodSchema, fn)`**, which calls the guard, then parses, then runs the body, and attaches `{ spec: { kind, perm, schema } }` to the export. The harness builds input from `z.toJSONSchema(schema)`. **Every id field must be `ref('<model>')`** (a `z.uuid()` tagged with its model), so the harness knows which org's fixture row to use. An untagged uuid fails the harness, and so does any export not built by the wrapper (rule 4). Four correct actions stay green. Five controls (raw export; spec attached but no guard; unscoped `where`; unscoped secondary id; name echoed before authz) each turn their invariant red, and a row snapshot backs every check. INV-02 accepts any refusal; INV-04 is what enforces "not yours ≡ not found". Next 16 builds and serves `export const x = orgAction(...)` in a `'use server'` file. Re-run: `spikes/s2/run.sh`. **Left for M3:** a `userAction` twin for non-org actions, and FormData input (forms bind the slug; the wrapper takes `Object.fromEntries`). | The Playwright fallback is not needed. |
| S3 ✔ | **Spike S3 passed (M0, 2026-09-23):** a template migration with an earlier timestamp, merged after a later clone migration, is applied by `migrate deploy`. `migrate dev` then shows no drift, and an empty database replays all four in timestamp order, including a later clone migration that depends on the new core column and table. The replay step used drop, create and `deploy`, because Prisma refuses `migrate reset` from an AI agent. Re-run: `spikes/s3/run.sh`. | The sort-last prefix fallback (§3.4) is not needed. Holds only while §3.4's rule does: a template migration never touches a clone table. |
| D-13 | **A clone's app tables add their `Org`/`User` back-relations in `core.prisma`, each line ending in `// app`.** `foundation:drift` ignores **added** lines marked `// app`, as it does `// <module>` lines. *Default taken in M0; **confirmed by Shane 2026-09-23** before M3.* | Found in M0. §6 requires app tables to carry `orgId` with a cascading relation, and Prisma requires both sides of that relation, so every clone would otherwise edit the template-owned `core.prisma` and fail drift. The other fix, a hand-written FK with no relation, is expected to be worse: `migrate dev` should see an FK missing from the schema as drift and drop it (UNVERIFIED). |
| D-14 | **M2 build choices (2026-09-23), taken as defaults.** (a) The two anonymous POSTs, requesting a link and redeeming one, are **route handlers** (`/login/request`, `/login/redeem`) with a same-origin check (`core/http.ts`), not server actions, so INV-01's "every `'use server'` export rejects an anonymous caller" holds with no exemption. (b) A pending TOTP secret waits **sealed in an httpOnly cookie** (10 min), not in `User`, so an abandoned re-enrolment never breaks the working one. (c) Recovery codes are **HMAC-keyed by `AUTH_SECRET`**, not bare sha256: 40 bits can be brute-forced from a dump alone. (d) **Each module has its own migration** (`*_billing_init`, `*_notifications_init`), so removing a module also deletes its migration folder. (e) The email log line carries the subject and row id, **not the address** (`log.ts` rule: no emails in logs). (f) `useRecoveryCode` is named `redeemRecoveryCode` (the `use` prefix trips the React hooks lint). | Found while building M2. Each is reversible. |
| D-15 | **M3 build choices (2026-09-23), taken as defaults.** (a) `orgAction`/`userAction` (`core/authz/action.ts`) return `{ error }` for a `Refused` (a domain refusal with a user-facing message: stale sign-in, last owner, bad confirm text) and **throw** for guard refusals (redirect, `notFound`, `AuthzError`). One client `ActionForm` (`core/ui`) renders the error; success redirects. (b) The harness (`tests/invariants/harness.ts`) treats a redirect to `/login`, `/login/mfa` or `/account/security?mfa=required` as a guard refusal and any other redirect as success, so sign-out goes to `/`. It snapshots **every** table except `RateLimit`, and a clone seeds rows for its own `ref('<model>')`s in the clone-owned `tests/fixtures/app.ts`. It also checks INV-22 for every org action, and six negative controls prove it goes red. (c) Membership changes take the **`Org` row lock** (`SELECT … FOR UPDATE`) and re-read both roles under it, so two owners demoting each other at once cannot reach zero owners (tested). (d) Invites are accepted **only by the emailed token** at `/onboarding/invite/[token]`. The link is not carried through sign-in, so a signed-out invitee clicks it twice. (e) Every sign-in lands on `/onboarding`: the user's orgs, their pending invites, and create-an-org. (f) The email-change link `/account/email/[token]` confirms only for the signed-in user who asked for it. (g) The audit trigger blocks UPDATE and DELETE, not TRUNCATE, so tests can empty the table. (h) **Defect found by the onboarding e2e, present since M2:** confirming TOTP deleted the pending cookie, the cookie write refreshed the page, the refresh unmounted `ConfirmForm`, and **the recovery codes were never shown**. Fixed by keeping `ConfirmForm` mounted at a fixed position in the tree. Unit tests could not catch it; only a browser could. | Found while building M3. Each is reversible. |
| D-16 | **M4 build choices (2026-09-23), taken as defaults.** (a) The example resource is a core `Project` model (`name`, internal `notes`), at `/o/[org]/projects`; a clone replaces it. (b) `core/share/links.ts` holds a `shareable` map, type → loader `(orgId, id) → projection \| null`. A clone adds one line per shareable type, and both create and read go through it, so a link can only point at a row in its own org. (c) Link lifetime is picked from 1/7/30 days; there is no "never". (d) The raw URL is returned once as `{ notice }` from the action, and `ActionForm` shows it; it is never stored. (e) Members can create links but only owners and admins can revoke (spec §7b grants, unchanged). (f) A rate-limited read renders a 200 "Too many requests" page, not a 429: a page cannot set its status. (g) The share headers come from `next.config.ts`, listed after the global block, so `Referrer-Policy: no-referrer` overrides the global policy on `/s/*`. INV-15's share-route check therefore expects `no-referrer`. | Found while building M4. Each is reversible. |
| D-17 | **M6 build choices (2026-09-24), taken as defaults.** (a) Stripe is called over `fetch`, not the SDK (RB's reasoning: two endpoints and one header). `PaymentProvider` has `checkout` and `portal`; with no `STRIPE_SECRET_KEY` the **mock** sends the user back to the billing page with `?checkout=mock` and changes nothing (the plan moves only on a webhook). The mock is refused in production. (b) The org id rides in **subscription metadata** (set at checkout), so the webhook handles only `customer.subscription.*`: `checkout.session.completed` is not needed, and it doesn't matter which event arrives first. An unknown or deleted org is acknowledged, not retried. (c) Claim, apply and mark `processedAt` run in **one transaction under the event row's `FOR UPDATE` lock**. A failure rolls back, gets recorded outside the transaction (`error`), and returns 500, so the redelivery re-applies it (the SB fix). Concurrent retries apply it once (tested). (d) **Out-of-order delivery:** new column `BillingAccount.stripeEventAt` in a second module migration `*_billing_event_order`; a conditional upsert skips an event older than the last one applied. Removing the module deletes **both** `*_billing_*` migration folders. (e) `Idempotency-Key` = `checkout:<orgId>:<attempt>`, where `attempt` is minted once per rendered form, so a double submit or retry reuses it. It is sent only on the checkout create. (f) The billing env keys live in core `env.ts`, each line marked `// billing` (INV-14 wants one schema). (g) **Defect found by the billing e2e, present since M1:** `@prisma/adapter-pg` sends a `Date` with no offset, and Postgres read it in the session zone (`America/Chicago` locally), so every Prisma write was stored 5–6h off against `now()` and column defaults. Prisma's own round-trip hid it. Fixed with `options: '-c timezone=UTC'` on the connection (`core/db`); `tests/integration/db-timezone.test.ts` goes red without it. CI's Postgres now runs `TZ=America/Chicago` so it can go red there too. | Found while building M6. Each is reversible. |
| D-18 | **M7 build choices (2026-09-24), taken as defaults.** (a) The drain claims one row at a time with `FOR UPDATE SKIP LOCKED` inside a transaction that also sends and records the result: overlapping drains never double-send, and delivery is **at-least-once** (a crash between the provider accepting and the commit resends). (b) Failure backs off 1/5/30/120 min, and after 5 attempts the row stays unsent with `lastError`. (c) Templates are code (`templates.ts`), looked up at drain time; `enqueue` rejects an unknown name at the call site. (d) SMS copies email's gating: real Twilio sends only in production or to `SMS_SANDBOX_TO`, else a `CapturedMessage` with subject `sms`; `SMS_ENABLED=0` is the kill switch. (e) `/api/cron` drains up to 25 per hourly run and deletes sent rows after 7 days. No boot-time throw for missing Twilio keys, since SMS is optional: the drain records the failure instead. | Found while building M7. Each is reversible. |
| D-19 | **M8 build choices (2026-09-25), taken as defaults.** (a) `new-project` leaves `FOUNDATION_VERSION` alone: it records the release the clone started from, and drift diffs against it (§11 said it rewrites it). It rewrites `package.json`, `playwright.config.ts`, the CI file and `README.md`. (b) `db:setup` also creates and migrates the test database and writes `.env.local`/`.env.test` if missing (local URLs, a random `AUTH_SECRET`, never printed), so a clone reaches `npm test` with one command. (c) Module cron work moved to the clone-owned `src/app/cron-jobs.ts`, so removing `notifications` never edits the template-owned `/api/cron`. Building the module-removal check found that its first version left a function with no return. (d) `foundation:drift` is a no-op in the template itself; `--base <ref>` overrides `FOUNDATION_VERSION` (the removal check uses `--base HEAD`). Untracked files are not seen (`git diff` limit). (e) The removal check runs on pushes to `main` and on `v*` tags, not only per release: a broken removal shows the day it breaks. (f) `seed.ts` and `drain-outbox.ts` from the §5 tree are not built: nothing needs them. (g) The `/demo` route checks the flag and `demoSignIn` checks it again; mutating out only the route's check leaves INV-27 green by design. | Defaults the plan left open; each was the smallest thing that meets §13. |
| D-20 | **No cookie consent in the foundation; it sets strictly necessary cookies only** (`session`, `totp_pending`), and those are exempt from consent under ePrivacy Art. 5(3). The cookie consent manager PRD (2026-09-19) is **parked**. **Trigger:** the first project to add a non-essential tracker (GA, ads, PostHog, Hotjar, a Meta pixel) revives it, and it then lands as a shared package under D-7, not as a clone-owned module. Fix these before building it: handhold is Vite, not Next.js; `request.geo` was removed in Next 15 (use `@vercel/functions` `geolocation()`); a private package can't be installed from a public portfolio repo; opting in everywhere and honoring GPC removes the need for geo-branching; and the 2026 legal claims are unverified. | 2026-09-26, Shane. A 2026-09-26 sweep of `~/Projects` found one tracker, `@vercel/analytics` in Use-Case Studio, which is cookieless. |
| D-21 | **A `scorekeeper` role holding only `results.write` (v1.3.0, 2026-10-14).** Owner and admin hold `results.write` too; member does not. Core checks it nowhere: a clone gates its own result entry on it, so a volunteer can enter scores without `org.update`. A scorekeeper is not MFA-gated: the guard's MFA line is now an explicit owner/admin list (it was `role !== 'member'`, which would have gated any new role), which matches INV-22's wording. `revokeInvitesBeyond` reads the role list from the enum, not a hard-coded three. The members page and `z.enum(Role)` pick the role up unchanged; `mayAssign` lets an admin grant it. | Shane, 2026-10-14: asked for by bracketry (its D-30). Names `results.write`/`scorekeeper` over a generic `records.write`/`contributor`; no MFA over MFA-required. |
| D-22 | **A clone hook `filterListedOrgs(userId, orgs)` decides which of a user's orgs the template's org lists show (v1.4.0, 2026-10-26).** It sits beside `beforeOrgDelete` in the clone-owned `src/app/org-hooks.ts`; the default returns `orgs`, so a clone that does nothing lists exactly what it listed before. The two template pages that list a user's orgs, `/onboarding` and each account's line on `/demo`, call it through `keepListedOrgs` (`core/tenancy/listed.ts`), which hands the hook frozen copies of `{ id, slug, name }` and keeps the page's own rows, in their order, whose `id` the hook returned. So the hook **can only remove**: an id the user is not a member of, a duplicate, or a rewritten name or slug never reaches the page. It is a display filter, not access control: a hidden org's `/o/<slug>` still opens for its members, and a clone gates its own pages. The pending-invitations list on `/onboarding` is not filtered (it lists invites, not memberships). Tests: `tests/integration/org-list-hook.test.ts` (12). | Shane, 2026-10-26 (owner decision): asked for by quorum (D-52), ledgerleave (D-47) and coursework (D-58), whose archived orgs still showed on `/onboarding` because the route is template-owned. Intersect-with-input over trusting the hook's output; a hook over a template `OrgArchive` table, because archive rules differ per clone. |

---

## 1. Inputs

| Code | Repo | Stack today | Notes |
|---|---|---|---|
| CT | Countertop (`Restaurant ordering`) | Next 16, Prisma 6, monorepo | single restaurant, shared staff passcode |
| BK | Bookable (`apptbasedservice`) | Next 16, Prisma 6, monorepo | custom HMAC session, `businessId` column |
| RB | rental business | Next 16, Prisma 6, Auth.js v5 JWT + Credentials | most mature RBAC; source of TOTP + limiter |
| SB | storage business | Next 16, Prisma 6, Auth.js v5 JWT, Stripe SDK | 97 models, 124 migrations; source of webhook shape |
| GW | groundwork | **Next 16, Prisma 7 + adapter-pg**, single app | **source of auth + db setup** |
| UCS | Use-Case Studio | Next 15, Drizzle, Auth.js DB sessions | source of `toPublicBrief` + share headers; frozen (D-6) |
| BX | Boxloop | PRD only; **not being built** (D-9) | contributes money/clock/audit conventions only |

Not inventoried in depth: clinic and showcall (Prisma 7, no authentication by design; ✔ `clinic/src/session.ts:6-15`), event
toolkit (Drizzle + Auth.js), restaurant reservations, alongside, and the three use-case-* repos (Prisma 6 + Auth.js).

---

## 2. Pattern matrix

Consistency: **H** = the same approach everywhere it appears. **M** = the same idea with different mechanics. **L** = divergent.

| Pattern | Present in | Consistency | Verdict |
|---|---|---|---|
| **Auth / session** | all 6 coded | **L**: passcode cookie (CT), HMAC cookie (BK), Auth.js JWT + Credentials (RB, SB), custom magic link + hashed DB sessions (GW), Auth.js DB sessions (UCS) | **GW** (D-4′). Only token hashes are stored; the link page shows a button on GET and the POST spends the token (✔ `groundwork/app/login/[token]/page.tsx:3-17`); a conditional `updateMany` makes each link single-use (✔ `src/session.ts:58-62`). **Plus RB's TOTP** (`packages/core/auth/totp.ts`, via `otpauth`) and **sealed secrets** (`secret-box.ts:63-84`). |
| **Route protection** | all | **L**: middleware only (CT), in-action only (BK, GW), both (RB, SB, UCS) | **The guard is authoritative in every page, action and route.** Proxy only sets headers and does an optimistic redirect. |
| **Tenant isolation** | BK, RB, SB, GW, UCS | **L**: ad hoc (BK, GW), central scope helper (RB `lib/auth/scope.ts:22-68`, SB `lib/rbac/authorize.ts`), per-file predicate (UCS) | **RB/SB central helper that fails closed**, expressed as one Prisma `where` fragment, `inOrg(ctx)`. |
| **RBAC** | BK, RB, SB | **M** | **RB**: pure `can()`, permission list, unknown keys dropped. Membership is re-read on every request. |
| **Schema conventions** | all | **L**: ids uuid (CT, UCS) vs cuid (BK, RB, SB, GW); SB uses `@@map` snake_case, the rest camelCase unmapped | **Prisma camelCase with no `@map`** (4 of 5 Prisma repos), **`@db.Uuid` ids**, **`@db.Timestamptz(6)`**, integer cents (BX PRD:52), injected clock (BX PRD:136, GW `src/clock.ts`). |
| **Public share links** | CT, BK, RB, SB, UCS | **L** | **UCS projection + headers** (✔ `sharing.ts:32-45`, `next.config.mjs:3-18`) + **BK/RB/SB hashed, expiring tokens** + **RB DB rate limiter**. |
| **Rate limiting** | BK, RB, SB (DB); UCS (memory); CT, GW (none or cooldown only) | **L** | **RB Postgres limiter** (`lib/auth/store.ts:45-75`: advisory lock + upsert, pure `checkRateLimit`). It is already Prisma, so it copies directly. |
| **Payments** | SB (SDK), RB and GW (fetch), CT (mock seam) | **M** | **SB webhook shape** (raw-body `constructEvent`, event-claim table) **+ re-apply when `processedAt IS NULL`** (fixes the SB bug) + **RB `Idempotency-Key`** + **CT/BX provider interface with a mock**. |
| **Email / notifications** | RB, SB, GW, UCS, BK, CT | **M** | **SB `VERCEL_ENV` gating** + **RB/BK kill switch and sandbox redirect** + **GW outbox**. Bodies are never logged in production (GW gap). |
| **Env / config** | all | **H, uniformly missing** | **New:** a zod `env.ts` parsed at boot; `.env.example` keys must equal the schema's keys. Keep CT's "unset means locked". |
| **Security headers** | UCS, BK (one route each), RB (nonce CSP) | **L** | **A global baseline** in `next.config` `headers()`; nonce CSP comes later. |
| **Testing** | all | **H** except UCS | **GW/RB** setup + **GW's cloud-DB guard in code** (✔ `groundwork/prisma.config.ts:10-19`, `src/db.ts:4-10`). |
| **Deploy** | all | **L**: `ignoreCommand` only in RB and GW | **RB `apps/web/vercel.json`**. Cron auth from **RB `isAuthorizedCron`**. |
| **Audit log** | RB (write-once trigger), BX (PRD) | **M** | Append-only `AuditEvent`, enforced by a DB trigger. |

---

## 3. Divergences and security gaps

Per D-5, each fix below is a **backlog item in its own repo**. The table is kept because every row is the origin of
an invariant in §8.

| Sev | Repo | Gap | Evidence | Invariant |
|---|---|---|---|---|
| **MED→HIGH** | BK | Cross-tenant **IDOR**: settings and appointment writes select by `id` only. This becomes HIGH as soon as a second business exists. | ✔ `packages/db/settings/resources.ts:135-137`; ✔ `packages/db/appointments/transition.ts:162-164`; + services, segments, providers, reschedule/close-out/impact actions | INV-02 |
| MED | SB | **A Stripe event that fails once is never re-applied**: the retry is treated as a duplicate. | ✔ `apps/web/app/api/stripe/webhook/route.ts:44-52` | INV-12 |
| MED | SB | **Cross-facility PII read**: the confirm echo runs before the facility authz check. | ✔ `apps/web/app/admin/rate-increases/actions.ts:58-69, 225-228` | INV-04 |
| MED | SB | Tenant JWT sessions cannot be revoked. | `apps/web/lib/rbac/session.ts:29` | INV-05 |
| MED | SB, BK | Unauthenticated inventory lock (SB) and slot fill (BK). | SB `(public)/.../rent/route.ts:9-50`; BK `lib/booking/public-actions.ts:341-380` | INV-09 |
| MED | RB | Unguarded exports in `'use server'` files. Whether they are reachable through an action ID is UNVERIFIED. | ✔ `apps/web/lib/notices/actions.ts:1,524`; `lib/prospects/actions.ts:187`; `lib/showings/actions.ts:339`; `lib/consent/actions.ts:38` | INV-01 |
| LOW-MED | RB | Secondary id not scoped (`addLeaseTenant`). | ✔ `apps/web/lib/leases/actions.ts:1079-1084` | INV-03 |
| MED | GW | Portal sessions survive a change of contact details. | ✔ `app/dispatch/properties/actions.ts:41-48` | INV-06 |
| MED | GW | Sign-in links are written to production logs when a channel is unconfigured. | ✔ `src/notifications/provider.ts:46-52` | INV-13 |
| MED | UCS | `/api/intake` is open when `INTAKE_KEY` is unset. | `src/app/api/intake/route.ts:26-40,76-80` | INV-11 |
| LOW | UCS, event toolkit | Share and invite tokens stored raw; no expiry (UCS). | ✔ UCS `src/db/schema.ts:98-103`; event toolkit `packages/server-db/src/schema.ts:153,185` | INV-07, INV-08 |
| MED | CT | The SMS verification stub returns the code to the browser; the passcode is unthrottled. | `packages/db/verification.ts:59`; `kitchen/login/actions.ts:16-29` | INV-09 |
| LOW | BK, UCS | Secrets compared with `!==`. | BK `api/jobs/reminders/route.ts:38`; UCS `intake/route.ts:78` | INV-10 |
| LOW | RB | Resend webhook has no replay window; a secret is accepted in the query string. | `core/comms/webhook-signature.ts:96-136`; `api/email/inbound/route.ts:113` | INV-12, INV-16 |
| LOW | CT, SB, GW, RB | No Referrer-Policy or frame-ancestors headers. | each `next.config.ts` | INV-15 |
| LOW | SB | Magic link spent on GET; MFA enforced only by the admin layout. | `(auth)/login/magic/route.ts:13-35`; `admin/layout.tsx:48` | INV-17, INV-22 |
| LOW | GW | The last dispatcher can demote themselves. | `app/dispatch/users/actions.ts:62-84` | INV-21 |
| Ops | CT, BK, SB, UCS | No `ignoreCommand`. UCS runs on :3000, which collides with storage. | ✔ SB `vercel.json` | §11 |

**Secrets handling is clean across the set.** No repo has hardcoded live keys or a secret `NEXT_PUBLIC_` var, and every repo tracks only `.env.example`.

---

## 4. Module boundaries

**Rule:** `src/core/` never imports from `src/modules/` or `src/app/`. Modules import core. This is enforced by ESLint
`no-restricted-imports` from the first commit, which keeps the D-7 extraction mechanical.

**Removing a module** means deleting its directory, its `prisma/schema/<module>.prisma` file, its routes, and the
back-relation lines it lists in `core.prisma` (Prisma requires both sides of a relation).
Each such line ends in a `// <module>` marker, and `foundation:drift` ignores the marked lines of a module whose directory is absent. The build must stay
green afterwards; CI checks this once per release by building with the modules removed.

| Core (always present) | Optional module (ships in v1, deletable) |
|---|---|
| `env`: zod schema, parsed at boot | `billing`: Stripe checkout and portal, webhook, event claim, `PaymentProvider` + mock |
| `db`: Prisma client (adapter-pg), local-DB guard | `notifications`: outbox, drain cron, SMS (Twilio), templates |
| `clock`: injectable `now()` | |
| `auth`: magic link, hashed sessions, TOTP, recovery codes, demo sign-in | |
| `email`: transactional transport (magic links need it), sandbox, kill switch, dev capture | |
| `tenancy`: orgs, memberships, invites, deletion | |
| `authz`: `can()`, guards, `inOrg()` | |
| `audit`: append-only events | |
| `tokens`: generate + sha256 | |
| `share`: share links, `toPublic*` contract | |
| `rate-limit`: Postgres limiter | |
| `cron`: constant-time bearer check | |
| `observability`: `log()`, error boundaries, `/api/health` | |

---

## 5. Folder layout

The template is a single Next app, not a monorepo (GW, clinic and showcall show this is enough). The layout mirrors groundwork.

```
saas-foundation/
├─ prisma/
│  ├─ schema/{core.prisma, billing.prisma, notifications.prisma}
│  └─ migrations/                    # includes hand-written SQL: audit trigger
├─ prisma.config.ts                  # schema folder, DIRECT_URL for migrate, cloud-DB guard
├─ src/
│  ├─ proxy.ts                       # headers + optimistic redirect only; never the authority
│  ├─ app/
│  │  ├─ (public)/                   # landing, legal/{privacy,terms}, /login, /login/[token], /login/mfa, /demo
│  │  ├─ onboarding/                 # first sign-in: create org or accept invite
│  │  ├─ o/[org]/                    # org-scoped; layout calls requireOrg()
│  │  │  └─ settings/{members,security,billing,danger}/
│  │  ├─ account/                    # TOTP enrol, recovery codes, sessions, delete account
│  │  ├─ s/[token]/page.tsx          # public share read (force-dynamic)
│  │  ├─ error.tsx  global-error.tsx
│  │  └─ api/{health, cron, webhooks/stripe}/route.ts
│  ├─ core/
│  │  ├─ env.ts clock.ts tokens.ts rate-limit.ts audit.ts cron.ts log.ts
│  │  ├─ db/{index.ts, local-guard.ts}
│  │  ├─ auth/{session.ts, link.ts, totp.ts, secret-box.ts, recovery.ts, demo.ts}
│  │  ├─ email/{transport.ts, resend.ts, capture.ts}
│  │  ├─ authz/{permissions.ts, guards.ts}
│  │  ├─ tenancy/{orgs.ts, invites.ts, delete.ts}
│  │  └─ share/{links.ts, project.ts}
│  ├─ modules/{billing, notifications}/
│  └─ generated/prisma/              # gitignored
├─ tests/{unit, integration, invariants/}   # vitest, local Postgres
├─ e2e/                              # playwright, production build
├─ scripts/{new-project.ts, seed.ts, seed-demo.ts, drain-outbox.ts}
├─ .github/workflows/ci.yml
├─ FOUNDATION_VERSION  CHANGELOG.md  README.md
├─ next.config.ts  vercel.json  .env.example  .env.test
```

---

## 6. Prisma base schema

`prisma.config.ts` points `schema` at the folder and uses `DIRECT_URL ?? DATABASE_URL`, because migrations need
Neon's unpooled URL. At runtime, `PrismaPg` uses the pooled `DATABASE_URL`. Both carry the cloud-DB guard (INV-18).

```prisma
// prisma/schema/core.prisma
generator client {
  provider = "prisma-client"
  output   = "../../src/generated/prisma"
}
datasource db { provider = "postgresql" }

enum Role { owner admin member }

model User {
  id               String    @id @default(uuid()) @db.Uuid
  email            String    @unique            // lowercased on write
  name             String?
  isDemo           Boolean   @default(false)    // only seed-demo sets this (INV-27)
  totpSecretSealed String?                      // sealSecret(base32, 'totp') — never plaintext (INV-25)
  totpLastStep     BigInt?                      // replay block (INV-24)
  totpEnrolledAt   DateTime? @db.Timestamptz(6)
  createdAt        DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt        DateTime  @updatedAt @db.Timestamptz(6)
  memberships      Membership[]
  sessions         Session[]
  loginTokens      LoginToken[]
  recoveryCodes    RecoveryCode[]
}

/// Magic-link token. Only sha256 stored; single use; 15 min.
model LoginToken {
  hash      String    @id
  purpose   TokenPurpose                        // login | signup | email_change
  email     String                              // lowercased; the address the link was sent to
  userId    String?   @db.Uuid                  // null only for purpose=signup (D-10)
  user      User?     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt DateTime  @db.Timestamptz(6)
  expiresAt DateTime  @db.Timestamptz(6)
  usedAt    DateTime? @db.Timestamptz(6)
  @@index([userId, createdAt])
  @@index([email, createdAt])
}

enum TokenPurpose { login signup email_change }

/// Signed-in session. Cookie holds the raw token; only sha256 stored.
model Session {
  hash      String    @id
  userId    String    @db.Uuid
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  authAt    DateTime  @db.Timestamptz(6)          // when the link was redeemed (INV-26 freshness)
  mfaAt     DateTime? @db.Timestamptz(6)          // when TOTP was verified in this session
  expiresAt DateTime  @db.Timestamptz(6)
  createdAt DateTime  @db.Timestamptz(6)
  @@index([userId])
}

model RecoveryCode {
  hash   String    @id                           // sha256 of a 10-char random code
  userId String    @db.Uuid
  user   User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  usedAt DateTime? @db.Timestamptz(6)
  @@index([userId])
}

model Org {
  id          String       @id @default(uuid()) @db.Uuid
  slug        String       @unique
  name        String
  createdAt   DateTime     @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime     @updatedAt @db.Timestamptz(6)
  memberships Membership[]
  invites     Invite[]
  shareLinks  ShareLink[]
  // module back-relations (delete with the module):
  billingAccount BillingAccount?   // billing
  outbox         Outbox[]          // notifications
}

model Membership {
  orgId     String   @db.Uuid
  userId    String   @db.Uuid
  org       Org      @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  role      Role     @default(member)
  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)
  @@id([orgId, userId])
  @@index([userId])
}

model Invite {
  id          String    @id @default(uuid()) @db.Uuid
  orgId       String    @db.Uuid
  org         Org       @relation(fields: [orgId], references: [id], onDelete: Cascade)
  email       String
  role        Role      @default(member)
  tokenHash   String    @unique
  invitedById String?   @db.Uuid
  expiresAt   DateTime  @db.Timestamptz(6)          // 7 days
  acceptedAt  DateTime? @db.Timestamptz(6)
  revokedAt   DateTime? @db.Timestamptz(6)
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  @@index([orgId, email])
}

model ShareLink {
  id           String    @id @default(uuid()) @db.Uuid
  orgId        String    @db.Uuid
  org          Org       @relation(fields: [orgId], references: [id], onDelete: Cascade)
  resourceType String
  resourceId   String    @db.Uuid
  tokenHash    String    @unique
  createdById  String?   @db.Uuid
  expiresAt    DateTime  @db.Timestamptz(6)         // required — no immortal links
  revokedAt    DateTime? @db.Timestamptz(6)
  createdAt    DateTime  @default(now()) @db.Timestamptz(6)
  @@index([orgId, resourceType, resourceId])
}

model RateLimit {
  key         String                               // "link:ip:1.2.3.4", "link:email:a@b.c", "totp:user:<id>"
  windowStart DateTime @db.Timestamptz(6)
  count       Int      @default(0)
  @@id([key, windowStart])
}

model AuditEvent {
  id          BigInt   @id @default(autoincrement())
  orgId       String?  @db.Uuid                    // no FK: survives org deletion
  actorUserId String?  @db.Uuid                    // no FK: survives user deletion
  action      String                               // "member.role_changed"
  targetType  String?
  targetId    String?
  data        Json?
  at          DateTime @default(now()) @db.Timestamptz(6)
  @@index([orgId, at])
}
// migration SQL (hand-written): BEFORE UPDATE OR DELETE ON "AuditEvent" → RAISE EXCEPTION (INV-19)

/// Non-production only: what the email transport "sent". Powers e2e (INV-17) and the demo inbox.
model CapturedMessage {
  id        String   @id @default(uuid()) @db.Uuid
  to        String
  subject   String
  body      String
  createdAt DateTime @default(now()) @db.Timestamptz(6)
  @@index([to, createdAt])
}
```

```prisma
// prisma/schema/billing.prisma
model BillingAccount {
  orgId            String    @id @db.Uuid
  org              Org       @relation(fields: [orgId], references: [id], onDelete: Cascade)
  stripeCustomerId String?   @unique
  plan             String?
  status           String?                          // mirrors Stripe subscription.status
  currentPeriodEnd DateTime? @db.Timestamptz(6)
  stripeEventAt    DateTime? @db.Timestamptz(6)          // last event applied; older ones skipped (D-17d)
  updatedAt        DateTime  @updatedAt @db.Timestamptz(6)
}
model StripeEvent {
  id          String    @id                         // evt_…
  type        String
  payload     Json
  receivedAt  DateTime  @default(now()) @db.Timestamptz(6)
  processedAt DateTime? @db.Timestamptz(6)          // NULL ⇒ re-apply on redelivery (INV-12)
  error       String?
}

// prisma/schema/notifications.prisma
model Outbox {
  id        String    @id @default(uuid()) @db.Uuid
  orgId     String?   @db.Uuid
  org       Org?      @relation(fields: [orgId], references: [id], onDelete: Cascade)
  channel   String                                  // email | sms
  to        String
  template  String
  data      Json
  sendAfter DateTime  @default(now()) @db.Timestamptz(6)
  sentAt    DateTime? @db.Timestamptz(6)
  attempts  Int       @default(0)
  lastError String?
  @@index([sentAt, sendAfter])
}
```

**Conventions every app table follows:**
- `id String @id @default(uuid()) @db.Uuid`.
- `orgId` with a cascading relation, if the table is org-owned.
- `createdAt` and `updatedAt` as `Timestamptz(6)`.
- Money as `Int` named `*Cents`.
- Prisma enums.
- No soft delete.
- Times come from `core/clock` in domain code, never `new Date()` (BX convention).

---

## 7. Auth and authz contracts

### 7a. Authentication: magic link + TOTP (D-4′)

The code is copied from groundwork `src/session.ts` (link and session) and rental `packages/core/auth/{totp,secret-box}.ts`.

```ts
// src/core/auth — public surface
requestLink(email: string, ip: string): Promise<void>      // always resolves the same way (no account probing)
redeemLink(token: string): Promise<string | null>          // POST only; returns a raw session token or null
verifyTotp(sessionToken: string, code: string): Promise<boolean>        // sets Session.mfaAt, User.totpLastStep
useRecoveryCode(sessionToken: string, code: string): Promise<boolean>   // single use; revokes other sessions
enrolTotp(): Promise<{ uri: string; secret: string }>      // needs a fresh authAt (≤ 5 min)
confirmTotp(code: string): Promise<string[]>               // activates it; returns 10 recovery codes, shown once
disableTotp(): Promise<void>                               // fresh authAt; refused while user is owner/admin anywhere
signOutEverywhere(userId: string): Promise<void>           // deletes all Session rows
requestEmailChange(newEmail: string): Promise<void>        // fresh authAt; link goes to the NEW address
confirmEmailChange(token: string): Promise<boolean>        // POST only; swaps email, revokes other sessions + old-address invites
currentSession(): Promise<SessionCtx | null>               // React cache(); one query per request
```

**Flow**
1. `/login` form → `requestLink`.
   - Rate-limited per IP and per email (INV-09).
   - Unknown email: a **sign-up** link is sent (`purpose=signup`, `userId` null), and the on-screen response is identical to a known email's (D-10).
     Redeeming it upserts the `User` by email and then continues as a normal sign-in. A user with no memberships lands in `/onboarding`.
   - The link is `/login/[token]`, 15-minute TTL, 60-second per-user cooldown.
2. `/login/[token]` **GET renders a button; POST calls `redeemLink`**. This stops mail scanners spending the link (INV-17).
   - A conditional `updateMany({ usedAt: null, expiresAt > now })` makes the link single-use.
   - A new session: 32 random bytes, only the sha256 stored, cookie `session` (httpOnly, sameSite=lax, `secure` on https, 30 days), `authAt = now`.
3. If the user has TOTP enrolled, the session carries `mfaAt = null` and every guard redirects to `/login/mfa`.
   Codes are checked with `otpauth`, drift window 1, and **the matched step must be greater than `totpLastStep`** (INV-24).
   Rental's `verifyTotp` returns only a boolean, so it gets one change: return the matched delta and compute the step from it.
   TOTP attempts are rate-limited per user.
4. **Required MFA:** a user holding `owner` or `admin` in any org must be enrolled with `mfaAt` set before
   `requireOrg` admits them anywhere (INV-22). An unenrolled owner is sent to `/account/security` to enrol.
   First enrolment is allowed in any session whose `authAt` is fresh; this is the invite-link trust-on-first-use window, which cannot be fully closed without a second channel.
5. **Revocation**
   - Sign out deletes this session.
   - Sign-out-everywhere, a TOTP change, a recovery-code use and an email change delete **all other** sessions (INV-05, INV-06, INV-23).
   - Membership removal takes effect on the next request, because membership is read on every request.

6. **Email change** (INV-06): `requestEmailChange` needs a fresh `authAt`, and the new address must not already belong to a user.
   The link (`purpose=email_change`, 15-minute TTL, POST-to-spend) goes to the new address. Confirming it in one transaction
   sets `User.email`, deletes every other session, and revokes pending invites addressed to the old email. The old address gets a notice.

**TOTP secret at rest:** `sealSecret(base32, 'totp')`, AES-256-GCM with an HKDF key per purpose derived from `AUTH_SECRET`
(rental `secret-box.ts`). Rotating `AUTH_SECRET` unseals nothing and forces re-enrolment; this is documented in the README.

**Demo sign-in (D-8):** `/demo` exists only when `DEMO_MODE=1`, and otherwise returns 404. It lists `isDemo` users; a POST writes a
Session row with `mfaAt` set. It refuses any user where `isDemo = false`. Only `scripts/seed-demo.ts` sets `isDemo`,
and that script refuses a non-local database unless `ALLOW_CLOUD_DB=1` (INV-27).
A demo account is shared by every visitor and its TOTP seed is public, so (2026-10-12): an `isDemo` user's session resolves
only while `DEMO_MODE=1`, however it was made; and a demo session is refused org and account deletion, email change, TOTP
changes, sign-out-everywhere, and inviting, re-roling or removing members (`assertNotDemo` in `core/auth/session.ts`).
Since 2026-10-13 it is also refused creating an org (`createOrg`) and, where the billing module is present, checkout and the
billing portal (the guard is in the module's own `settings/billing/actions.ts`, so it goes with the module). Adding projects
and creating or revoking share links stay open to it.

### 7b. Authorization

```ts
// src/core/authz/permissions.ts — pure, no I/O
export type Permission =
  | 'org.update' | 'org.delete' | 'members.manage' | 'billing.manage'
  | 'share.create' | 'share.revoke' | 'audit.read' | 'results.write'
const grants: Record<Role, readonly Permission[]> = {
  owner:  ['org.update','org.delete','members.manage','billing.manage','share.create','share.revoke','audit.read','results.write'],
  admin:  ['org.update','members.manage','share.create','share.revoke','audit.read','results.write'],
  member: ['share.create'],
  scorekeeper: ['results.write'],   // D-21
}
export const can = (role: Role, p: Permission) => grants[role].includes(p)
```

```ts
// src/core/authz/guards.ts
export type OrgCtx = { userId: string; orgId: string; role: Role }

requireUser(): Promise<SessionCtx>                               // no session → redirect('/login'); mfa pending → '/login/mfa'
requireOrg(orgSlug: string, perm?: Permission): Promise<OrgCtx>  // reads membership from the DB on every call
  //  not a member          → notFound()          ("not yours" ≡ "not found")
  //  owner/admin w/o MFA   → redirect('/account/security')
  //  lacks `perm`          → throws AuthzError   (403 / form error state)
inOrg(ctx: OrgCtx) => ({ orgId: ctx.orgId })                     // spread into every Prisma `where`
```

**Four rules every handler follows** (each is an invariant):
1. **Guard first.** The first statement of every page, server action and route handler is `requireOrg` or `requireUser`.
2. **Every query on an org-owned model spreads `inOrg(ctx)`**, for reads and writes alike.
   Prisma's `where` on `update`/`delete` accepts non-unique fields next to `id`, and P2025 maps to `notFound()`.
3. **Every secondary id is resolved through `inOrg` too.**
4. **Every `'use server'` export is a public endpoint.** No helpers live in `'use server'` files.

```ts
'use server'
export async function renameProject(orgSlug: string, form: FormData) {
  const ctx = await requireOrg(orgSlug, 'org.update')                     // rule 1
  const id = z.string().uuid().parse(form.get('id'))
  await prisma.project.update({
    where: { id, ...inOrg(ctx) },                                          // rule 2
    data: { name: z.string().min(1).parse(form.get('name')) },
  }).catch(notFoundOnP2025)
  await audit(ctx, 'project.renamed', { targetType: 'project', targetId: id })
}
```

**Org lifecycle**
- An org always has at least one owner (INV-21).
- Invites are hashed, expire after 7 days, are single-use, and must match the invited email when accepted.
- Every membership or role change is audited.
- **Role assignment** (D-11, INV-28). Only an owner can grant `owner`: by promotion or by an invite with `role=owner`.
  Only an owner can demote or remove an owner. `members.manage` without ownership covers `admin`/`member` on non-owners only.
  The check lives in `core/tenancy`, not in the UI.
- **Org deletion:** `org.delete`, typing the slug to confirm, and a fresh `authAt`. Rows cascade; audit events are kept (no FK).
- **Account deletion:** refused while the user is the sole owner of any org. Otherwise the user's rows cascade.

### 7c. Public share contract

Each shareable resource exports exactly one projection, built on an empty default:

```ts
export function toPublicX(row: X): PublicX { return { ...blankPublicX(), title: row.title /* opt-in only */ } }
```

- **Lookup:** `/s/[token]` hashes the token and finds the `ShareLink` that is unrevoked and unexpired. It then loads the resource by the link's own `orgId` + `resourceId`, runs `toPublicX()`, and renders. Unknown, expired and revoked links all return the same 404.
- **Headers on `/s/:path*`:** `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: private, no-store, max-age=0`. The page is `force-dynamic`, and reads are rate-limited per IP.

### 7d. Email

- **Real sends** happen only when `VERCEL_ENV=production` or `EMAIL_SANDBOX_TO` is set (SB pattern).
- **Kill switch:** `EMAIL_ENABLED=0`.
- **Everywhere else**, the transport writes a `CapturedMessage` row and logs only `{to, subject}`, never the body (INV-13).
- **Production with no provider configured** throws at boot.
- **Transport:** Resend over `fetch`, no SDK (RB and GW pattern).

---

## 8. Security baseline: testable invariants

Each invariant lives in one file in `tests/invariants/` (vitest on local Postgres), or in `e2e/` where a browser is needed.
**Gate: every one passes, in the template and in every clone.** The Origin column names the real gap each one prevents.

| ID | Invariant | How it is tested | Origin |
|---|---|---|---|
| INV-01 | Every `'use server'` export rejects an anonymous caller. | Glob for `'use server'` modules, import each one, call every export with no session → redirect or throw, and zero rows written. Needs `next/headers` and `next/navigation` mocks (**spike**). | RB unguarded exports |
| INV-02 | A member of org A cannot read or mutate an org-B row by id. | Two-org fixture. Actions are **discovered by INV-01's glob**, so clones don't have to register them. Call each with B's ids as A's user → `notFound`, and B's rows are unchanged. | BK IDORs |
| INV-03 | Secondary ids from another org are rejected. | Same harness: swap each uuid-shaped field to an org-B id. | RB `addLeaseTenant` |
| INV-04 | A cross-org id and a nonexistent id get **byte-identical responses**. | Same harness, comparing the two responses. This catches data echoed before authz, and replaces the brittle DB-spy test from draft 1. | SB rate-change echo |
| INV-05 | Removing a member or signing out everywhere takes effect on the next request. | Integration test. | SB tenant JWT |
| INV-06 | Changing an email deletes the user's other sessions and pending invites to the old address. | Integration test through `confirmEmailChange`, not an isolated helper. | GW portal sessions |
| INV-07 | No raw token is stored. | Create a login token, session, invite, share link and recovery code, then scan those tables for the raw strings. None found. | UCS / event toolkit raw tokens |
| INV-08 | Share links: expiry is required, revoke is immediate, headers are present, the projection is allowlisted. | NOT NULL on `expiresAt`; revoke then GET → 404; header asserts; `Object.keys(toPublicX(row + dummyField))` is unchanged. | UCS, CT |
| INV-09 | Every unauthenticated or pre-MFA write is limited in Postgres: link requests (per IP and per email), TOTP attempts, invite accepts, share reads, public forms. | Send N+1 requests and the last is refused. The limit survives a fresh module instance. | SB, BK, UCS, CT |
| INV-10 | Secrets are compared in constant time. | Grep test: no `===` or `!==` against `env.*SECRET*` or `*_KEY`. | BK, UCS |
| INV-11 | Every secret-gated endpoint fails closed when its secret is unset. | Unset each secret → 401/404. | UCS intake |
| INV-12 | Webhooks verify the raw body and timestamp window; a delivery that failed earlier is re-applied; a true duplicate is a no-op. | A bad signature or stale timestamp returns 400. If the first apply throws, the redelivery applies it; a third delivery changes nothing. | SB retry, RB replay |
| INV-13 | Outside production, no message body is logged; in production, a missing provider throws at boot. | Unit test on the transport with env stubbed. | GW links in logs |
| INV-14 | Boot fails on a missing required env var, and `.env.example` names exactly the schema's keys. | Unit test. | UCS drift |
| INV-15 | Every response carries the global headers: Referrer-Policy `strict-origin-when-cross-origin`, `nosniff`, CSP `frame-ancestors 'none'`, HSTS. | e2e checks a public route, a signed-in route and a share route. | CT, SB, GW, RB |
| INV-16 | No secret is accepted from a query string. | Grep test. | RB `?secret=` |
| INV-17 | GETting the emailed link twice spends nothing; clicking the button then signs in. | e2e reads the link from `CapturedMessage`. | SB GET-spend |
| INV-18 | The app, Prisma CLI, tests and seeds refuse a cloud database unless `VERCEL_ENV` is set or `ALLOW_CLOUD_DB=1`. | Unit test with a `*.neon.tech` URL. | UCS Neon-branch tests |
| INV-19 | `AuditEvent` rejects UPDATE and DELETE. | Integration test expects the trigger's exception. | BX P0-2 |
| INV-20 | No `NEXT_PUBLIC_*` var is a secret. | Allowlist test over `env.ts`. | preventive |
| INV-21 | An org can never reach zero owners. | Demoting, removing or deleting the sole owner, or that owner leaving → refused. | GW last dispatcher |
| INV-22 | MFA is enforced by the guard, not the layout: an owner or admin without `mfaAt` is refused by every action and route. | Call a server action directly as an unenrolled admin → refused. | SB MFA in layout |
| INV-23 | A TOTP change or recovery-code use deletes all other sessions. | Integration test. | preventive |
| INV-24 | A TOTP code can't be replayed within its step; recovery codes are single-use and stored hashed. | Use the same code twice → the second is refused; a used recovery code → refused. | SB `totpLastStep` |
| INV-25 | TOTP secrets are sealed at rest. | Scan `User.totpSecretSealed` for a base32 seed → none found. | RB `secret-box.ts` |
| INV-26 | Enrolling or disabling TOTP, or deleting an org or account, requires `authAt` within the last 5 minutes. | A stale session is refused. | SB `authTime` |
| INV-28 | Only an owner can grant, change or remove the owner role. | An admin promotes self or another user to owner, invites with `role=owner`, or demotes or removes an owner → all refused, and no row changes. An owner doing the same → allowed. | Event toolkit SEC-01, Codex #1 |
| INV-27 | `/demo` returns 404 unless `DEMO_MODE=1`, and even then signs in only `isDemo` users. | e2e with the flag off, and with the flag on against a non-demo user. | D-8 |

---

## 9. What the foundation also ships in v1 (from the PO review)

| Item | Content | Done when |
|---|---|---|
| **Clone procedure** | `scripts/new-project.ts` asks for name and port, rewrites `package.json`/`README`/`FOUNDATION_VERSION`, then prints the checklist: port-table row in `~/.claude/CLAUDE.md`, a Neon project (pooled + direct URLs), a Vercel project, a private GitHub repo, and the secrets check before the first push. | A fresh clone runs `npm run dev` on its own port within 30 min |
| **Port placeholder** | The template's scripts use `next dev -p __PORT__`, which fails to start until the clone script replaces it, so no clone can inherit a port. The template itself develops with `npm run dev:template` (`-p 4100`), and the clone script deletes that script. | `npm run dev` in an unconverted clone fails loudly |
| **Demo seed** | `seed-demo.ts`: two orgs, owner/admin/member per org, `isDemo=true`, named for `DEMO.md`. The owner and admin come pre-enrolled in TOTP, with the secret printed. | `/demo` works; INV-27 green |
| **Versioning** | Git tags `vX.Y.Z` on the template, `FOUNDATION_VERSION` + `CHANGELOG.md` in each clone. Security fixes are labelled `security:` in the changelog. | Tag exists; changelog has a v1.0.0 entry |
| **Observability** | `core/log.ts` writes one JSON line per event, with no bodies or tokens. `error.tsx` and `global-error.tsx` show an error id. `/api/health` checks the database. Sentry comes later. | Health route green in e2e |
| **CI** | `.github/workflows/ci.yml`: Postgres 17 service → lint → typecheck → vitest (unit + integration + invariants) → prod-build e2e. Push to `main` only; PRs are optional. | Green on the first commit that has tests |
| **Onboarding** | First sign-in with no memberships leads to `/onboarding`: accept a pending invite, or create an org (name → slug). Empty states on the org home. | e2e: new email → org created → lands in `/o/[slug]` |
| **Deletion flows** | Delete account and delete org (§7b), with fresh-auth confirmation. | Integration tests plus INV-21/26 |
| **Legal stubs** | Placeholder `/privacy`, `/terms` and a contact page, linked in the footer. | Pages render |
| **Hygiene** | Local `DATABASE_URL` carries `?connection_limit=10&pool_timeout=20`. Also: `swapcheck` pre-hooks, `vercel.json` with RB's `ignoreCommand`, an hourly cron with `isAuthorizedCron`, and `.gitignore` covering `.env*` except `.env.example`. | Checked by the clone checklist |

**Later, not v1:** data export per org · a documented Neon PITR retention window and restore steps ·
cost ceilings (Neon plan, Resend/Twilio caps, Vercel build budget per clone) · an axe accessibility spec on the auth pages ·
Sentry.

---

## 10. Migration path per repo (pointers only: D-5, D-6)

| Repo | Plan |
|---|---|
| **First clone** | **The next new project, whichever it is** (D-9). Its domain models go in `prisma/schema/<app>.prisma`. Boxloop is not planned. |
| **groundwork** | **Source, not target.** It could adopt the template's orgs later; its security fixes are backlog items. |
| **Use-Case Studio** | Frozen. Backlog items: hash + expire share tokens, fail-closed intake, move off :3000. |
| **Bookable, storage, rental, Countertop** | Stay on Prisma 6 and their own auth; §3 fixes become backlog items in each repo. Adopting the foundation's auth is **not** planned. |
| **After clone #3** | Extract `src/core` into a shared package (D-7). The ESLint boundary from §4 is what keeps this mechanical. |

---

## 11. Out of scope for v1

- **Passwords.** A module later, ported from rental's `password.ts`, lockout and reset.
- **Passkeys/WebAuthn and Google/OAuth.** Modules later.
- **SMS login.** groundwork supports it; a module later.
- **Impersonation / act-as.** Never, for a demo template.
- **Postgres RLS** (see §12, question 1) · SSO/SAML/SCIM · file uploads (GW's `PhotoStore` seam is the reference) ·
  soft delete · subscription domain logic (belongs to whichever app needs it) · AI spend guards (UCS reference) · Redis · porting any existing repo.

---

## 12. Open decisions (defaults taken; override at approval)

1. **RLS or app-only isolation?** **Default: app-only.** `inOrg` + INV-02/03/04. RLS under Prisma needs a
   `$transaction` + `set_config` per request, through a client extension; revisit if a clone holds regulated data.
2. **Active org in the URL (`/o/[org]/…`) or a cookie?** **Default: URL.** Every request names its org and is membership-checked.
3. **Repo:** **Default: private GitHub `saas-foundation`**, created when the first code lands; port **4100** claimed in the
   port table in the same commit (template development only, see §9).
4. **Should TOTP be required for `member` too?** **Default: no.** Owner and admin only. Members may opt in.

**Spikes before code:**
- INV-01's harness: calling server actions in vitest with `next/headers` and `next/navigation` mocks.
- Prisma 7 multi-file schema with module back-relations (§4 deletion rule), UNVERIFIED.

---

## 13. Acceptance criteria and success measure

**The foundation v1 is done when:**
1. `scripts/new-project.ts` → `npm run db:setup` → `npm run seed:demo` → `npm run dev` works on a clean machine
   **in under 30 minutes**, following only the README.
2. CI is green, including INV-01 to INV-28.
3. Deleting the `billing` and `notifications` modules, following §4, leaves a green build.
4. `v1.0.0` is tagged with a changelog.

**Success measure:** the first clone, whichever project that is (D-9), reaches its first domain feature **within one day of cloning**,
with **zero lines of auth, tenancy or authz code written in that clone**.

**Project closure (per `~/.claude/CLAUDE.md` Definition of Done)** applies to **each clone**, not to the template: `DEMO.md`,
the exec brief and the LinkedIn posts. The template's closure deliverable is its README and CHANGELOG.
