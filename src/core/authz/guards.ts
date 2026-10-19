import { notFound, redirect } from 'next/navigation';
import { requireUser, type SessionCtx } from '@/core/auth/session';
import { db } from '@/core/db';
import type { Role } from '@/generated/prisma/enums';
import { can, type Permission } from './permissions';

export { requireUser };

export type OrgCtx = { userId: string; orgId: string; slug: string; role: Role; session: SessionCtx };

export class AuthzError extends Error {
  constructor(readonly perm: Permission) {
    super(`Missing permission: ${perm}`);
  }
}

/**
 * The first statement of every org page, action and route (spec §7b rule 1). Membership is read
 * from the database on every call, so a removal takes effect on the next request (INV-05).
 * Not a member → notFound ("not yours" ≡ "not found"); owner/admin without MFA → enrol (INV-22).
 */
export async function requireOrg(orgSlug: string, perm?: Permission): Promise<OrgCtx> {
  const session = await requireUser();
  const m = typeof orgSlug === 'string'
    ? await db.membership.findFirst({ where: { userId: session.userId, org: { slug: orgSlug } }, select: { orgId: true, role: true } })
    : null;
  if (!m) notFound();
  // requireUser already sent an enrolled user without mfaAt to /login/mfa; this catches the unenrolled.
  if ((m.role === 'owner' || m.role === 'admin') && !(session.totpEnrolled && session.mfaAt)) redirect('/account/security?mfa=required');
  if (perm && !can(m.role, perm)) throw new AuthzError(perm);
  return { userId: session.userId, orgId: m.orgId, slug: orgSlug, role: m.role, session };
}

/** Spread into every Prisma `where` on an org-owned model (rule 2), including secondary ids (rule 3). */
export const inOrg = (ctx: OrgCtx) => ({ orgId: ctx.orgId });

/** Prisma's "record to update/delete not found" is "not yours" too. */
export function notFoundOnP2025(e: unknown): never {
  if ((e as { code?: string })?.code === 'P2025') notFound();
  throw e;
}
