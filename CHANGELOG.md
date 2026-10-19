# Changelog

Entries prefixed `security:` are mandatory for anything touching an invariant. Clones must take a `security:` release within 7 days.

## 1.3.0 (2026-10-14)

A `scorekeeper` role that holds only a new `results.write` permission (D-21), asked for by bracketry so a volunteer can enter
and correct scores without `org.update`. Owner and admin hold `results.write` too; member does not. Core checks it nowhere:
a clone gates its own result entry on it. One migration (`20261014000000_role_scorekeeper`, `ALTER TYPE "Role" ADD VALUE`),
additive. No new env var.

security: (INV-22) The guard's MFA line was `role !== 'member'`, so any role added later would have been MFA-gated by
accident and the rule's wording ("an owner or admin without MFA") was not what the code said. It is now an explicit
owner/admin list; behaviour for the three existing roles is unchanged. A scorekeeper is not MFA-gated, by decision.

security: (INV-28) `revokeInvitesBeyond` listed the roles by hand (`owner`, `admin`, `member`), so a demoted issuer's pending
invite for any newer role would have stayed live. It now reads `Object.values(Role)`. Tests in
`tests/integration/scorekeeper-role.test.ts` (4); both fixes were reverted one at a time and each turned its test red.

Upgrade: merge, then `npm run db:migrate` (the enum value arrives with the merge). The members page and `z.enum(Role)` offer
the new role with no clone change. A clone that does not want it simply never checks `results.write`; an admin can still
assign the role, and it grants nothing there. Clones owe this within 7 days (by 2026-10-21); it can be taken together with
v1.2.1.

## 1.2.1 (2026-10-13)

The four fixes from the 2026-10-12 review. No schema change, no migration, no new env var.

security: (review 2026-10-12 #1, INV-28) A pending invite outlived its issuer's authority: a removed owner could re-enter as
owner through an owner invite they had sent to a spare address, and a demoted admin's `admin` invites stayed good.
`acceptInvite` now reads the issuer's membership as it is at acceptance and refuses (same "not valid" answer) unless the
issuer could still send that invite — so removal, demotion, leaving and account deletion are all covered at the one place an
invite is honoured. `removeMember` and `changeRole` also revoke the invites the person can no longer back, in the same
transaction, so they drop out of the pending lists. An `Invite` row with no `invitedById` (none is written by core) is no
longer acceptable.

security: (review 2026-10-12 #4, D-10, INV-09) `requestEmailChange` answered "That address belongs to another account" for a
registered address, and returned before its rate limit counted the request — so any signed-in user could enumerate accounts
at request speed. The limit is now counted before the lookup, and a taken address resolves exactly like a free one: same
"check your new inbox" result, no link created, no mail sent. Cost: someone who types an address that already has an account
is told to check that inbox and nothing arrives. INV-06's "taken address is refused" case now asserts the silent form.

security: (review 2026-10-12 #2, INV-27, INV-26) A `/demo` session was born fresh and MFA-passed, so any visitor could delete
the demo org, delete a demo account, or move the demo owner to an email they control — and since the demo TOTP seed is a
public constant, that became a normal owner login that kept working after `DEMO_MODE` was turned off. Two rules now, both in
`core/auth/session.ts`: (1) `sessionFor` resolves no session for an `isDemo` user unless `DEMO_MODE=1`, whether the session
came from `/demo` or a sign-in link; (2) `assertNotDemo` refuses a demo session org deletion, account deletion, email change
and TOTP enrol/confirm/disable (via `assertFresh`, which every INV-26 action already calls), inviting, re-roling, removing
and leaving (`createInvite`, and `withMembers` in `core/tenancy/orgs.ts`), and sign-out-everywhere (the shared account would
sign every other visitor out). `SessionCtx` gains `isDemo`. A demo session can still browse, add projects, and create and
revoke share links — a clone that wants more locked calls `assertNotDemo(ctx.session)` itself.

security: (owner decision 2026-10-13, INV-27) A demo session is also refused creating an org and using billing. `createOrg`
(`core/tenancy/orgs.ts`) calls `assertNotDemo`: an org made by the shared account was owned by every visitor and never
cleaned up. `startCheckout` and `openPortal` call it too, in the billing module's own
`src/app/o/[org]/settings/billing/actions.ts`, so a visitor cannot subscribe the shared demo org or open its Stripe customer
portal; the guard is removed with the module and core imports nothing from it. Tests: the org half in
`tests/integration/review-2026-10-12-demo.test.ts`, the billing half in `tests/invariants/inv-12-webhooks.test.ts`.

Upgrade: no schema or config change. **Behaviour change for a deployed demo:** demo visitors can no longer invite or manage
members, create an org, subscribe or open the billing portal, or delete anything listed above, so a `DEMO.md` step that does
one of those needs a real account. And any environment
holding `isDemo` rows without `DEMO_MODE=1` (local dev without the flag included) can no longer sign those users in at all.
Existing damage is not repaired: a demo row whose email was already changed still has it — re-run `seed:demo` or check the
`isDemo` rows by hand.

## 1.2.0 (2026-09-28)

F-03: a clone can now declare a module required in the clone-owned `src/app/required-modules.ts`. `foundation:check-modules`
leaves a required module in place and still removes the rest, instead of always removing both — callboard imports
`notifications` outside the marked lines (`src/lib/messages.ts`, `src/lib/broadcast.ts`, `/api/sms/inbound`, the event
actions), so its `modules-removed` CI job has failed `tsc` since 2026-09-26. Verified for real: `check-modules` with
`notifications` required passes with only billing removed, and with no module required it still removes both, unchanged.

## 1.1.1 (2026-09-28)

security: (LOW K1) `signOutEverywhere` and `confirmEmailChange` left any unused `login`/`signup` link for that user valid — a
stolen link outlived the session boundary meant to close it. Both now also spend that user's unused `loginToken` rows,
atomically with the session/email change.

security: (LOW K1) The session cookie was named `session` with `Secure` derived from `APP_URL`, instead of the browser-enforced
`__Host-session` prefix. Renamed; `Secure` is now unconditional (`http://localhost` is treated as a secure context, so local
dev is unaffected).

security: (LOW K2) `confirmTotp` skipped `assertFresh`, and its enrolment write was not exclusive: two concurrent confirms
could both succeed and leave 20 recovery codes instead of 10, with only one meant to have won. Added `assertFresh`, and the
write is now a conditional `updateMany` claim on `totpEnrolledAt: null` so the loser gets `null` back.

security: (LOW K5) An IPv6 rate-limit key was scoped to the exact address, so a client rotating within its ISP-assigned /64
dodged the limit on every request. `clientIp` now keys on the first 64 bits.

security: (LOW K6) A share link survived its creator's removal from the org. `removeMember` now revokes that user's active
share links in the org, in the same transaction as the membership delete.

security: (LOW K13) `addProject`, `createShareLink`, `revokeShareLink` and `revokeInvite` wrote their row and their audit
event as two separate commits, so a crash between them left an unaudited write. All four now wrap the write and the `audit()`
call in one `db.$transaction`.

Upgrade: no schema or config change. Any code that read `SESSION_COOKIE` (`'session'`) directly instead of importing the
constant needs the new value, `'__Host-session'`.

## 1.1.0 (2026-09-28)

security: (FR-06, K3, rule 1) Nothing checked that pages, layouts and route handlers guard themselves; a clone's new page could
ship unguarded, and a client-side navigation does not re-run the layout's guard. `unguardedEntrypoints()` now requires every
exported handler in `src/app/**/{page,layout,template,default,route}` to make `requireUser`/`requireOrg` its first `await`, or
the file to carry a `// public: <reason>` line. The 14 public files are marked.

security: (FR-07, K3) The action harness globbed only `src/{app,modules}`, and could not see inline `'use server'` functions,
which Next also registers as endpoints. It now globs all of `src/`, and any `'use server'` that is not a file's first directive fails.

security: (FR-08, K4) An id typed `z.string()`/`z.cuid()` was filled with `'x'`, so INV-02/03/04 silently skipped that action.
`generate()` now throws on an untagged field whose name looks like an id (`id`, `…Id(s)`, `slug`, `token`) or whose format is an
id format; wrap a non-row-id in the new `notRef()` (the two emailed-token fields are).

Upgrade: add `// public: <reason>` to any clone page/route that is deliberately unguarded, move inline server actions into an
actions file, and tag id fields `ref('<model>')` (or `notRef()`). The failing test names each file or field.

Fix (FR-09, tooling): a path listed once in `FOUNDATION_PATCHES.md` was excused from drift forever, whatever later edits it
got. Each entry now carries a hash of the excused diff (`` `path` `hash` — reason ``); `foundation:drift` fails again once
that path's diff moves on, and its error message prints the `` `path` `hash` `` to paste in.

Fix (FR-10, tooling): module removal stripped the `// <module>` lines in `core.prisma` and `cron-jobs.ts` but not the Billing
nav link in `src/app/o/[org]/layout.tsx` (a JSX file, where a trailing `//` renders as literal text — it now carries
`{/* billing */}`). `layout.tsx` is in `MARKED_FILES`; `foundation:check-modules` confirms the route is gone after removal.

Fix (FR-11, tooling): `new-project` checked a port only against the template's own 4100, not the port table, and a second run
silently corrupted the README banner and left scripts on the first port. It now refuses a port already `in use` or `reserved`
in `~/.claude/CLAUDE.md`'s port table, and refuses to run once `package.json`'s name is no longer `saas-foundation`.

## 1.0.3 (2026-09-27)

security: (FR-02, K2) A session waiting on TOTP lived 30 days, and the only guess control was 8 tries per 5 minutes: over one session,
about a 19% chance to guess a code for someone holding the inbox. A pending-MFA session now dies 10 minutes after the link
(`PENDING_MFA_MS`). Wrong TOTP and recovery codes are audited (`auth.mfa_failed`) and capped at 20 per user per UTC day
(`LIMITS.mfaFailPerUserDay`); past the cap the pending session is ended and MFA is refused until the day turns. `/login/mfa` has a Sign out button.

security: (FR-03, K5) `createInvite` had no rate limit, so anyone could send unlimited invite mail from the app's domain. It is now
capped per sender (50/day), per org (100/day) and per recipient address (5/day, across orgs).

security: (FR-04, K9, billing) The org's billing row followed any subscription carrying its org id, so a second checkout made a second
subscription whose events overwrote the first. `BillingAccount.stripeSubscriptionId` now binds the org to one subscription; another's
events apply only after the bound one has ended (a re-subscribe), and otherwise log `billing.second_subscription`. Checkout is refused
while the org has a live subscription.

security: (FR-05, K9, billing) `deleteOrg` dropped the billing row but left the Stripe subscription charging. It now cancels a live
subscription first (`cancelOrgSubscription`, called from the new clone-owned `src/app/org-hooks.ts`, whose `// billing` lines go with the module), and refuses to delete if the
cancel fails. A live subscription for an unknown org logs `billing.unknown_org_live_subscription`.

Upgrade: `git merge v1.0.3`, then `npm run db:migrate` (adds `stripeSubscriptionId`). Existing live rows bind on their next
subscription event; until then, deleting such an org is refused. A clone with its own `PaymentProvider` must add `cancel()`.

## 1.0.2 (2026-09-27)

Fix (FR-01, notifications): `drainOutbox` sent inside the claim's interactive transaction (5s timeout). A send slower than that
was delivered but never recorded, then re-sent on every cron run and blocked the queue. The claim is now a short transaction that
counts the attempt and leases the row (`LEASE_MS`, 2 min); the send runs outside it and is marked after. The Resend and Twilio
fetches time out at 15s (this also covers the sign-in and invite mail). Take it promptly if your cron drains often.
Upgrade: `git merge v1.0.2`; no migration.

## 1.0.1 (2026-09-25)

Fix: the clone steps in README and plan §3.1 used `git checkout -b main`, which fails because a fresh clone already has `main`; now `-B`. Docs only.

## 1.0.0 (2026-09-25)

First release. Core (env, db with cloud guard, auth with magic link, sessions, TOTP and recovery codes, tenancy, authz, audit, share links, cron),
the `billing` and `notifications` modules, demo sign-in (`/demo`, `DEMO_MODE=1`), `seed:demo`, clone tooling
(`new-project`, `db:setup`, `foundation:drift`, `foundation:status`, `foundation:check-modules`), and invariants INV-01 to INV-28.
