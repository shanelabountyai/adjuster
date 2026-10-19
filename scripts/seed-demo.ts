import { pathToFileURL } from 'node:url';
import { now } from '@/core/clock';
import { sealSecret } from '@/core/auth/secret-box';
import { db } from '@/core/db'; // importing it is what refuses a cloud database (INV-18, INV-27)
import type { Role } from '@/generated/prisma/enums';

// Demo data (spec §7, D-8): two orgs, an owner, admin and member in each. Only this script sets `isDemo`,
// and the cloud guard in `@/core/db` refuses a non-local database unless ALLOW_CLOUD_DB=1.
// The TOTP secret is a fixed, public demo value. That is safe only because of two rules in core/auth/session.ts:
// an `isDemo` user's session resolves only while DEMO_MODE=1, and a demo session cannot change its email or TOTP.
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const ORGS = [
  { slug: 'acme', name: 'Acme Studio', domain: 'acme.demo.test', projects: ['Website relaunch', 'Q4 planning'] },
  { slug: 'globex', name: 'Globex Labs', domain: 'globex.demo.test', projects: ['Pilot rollout'] },
] as const;
const ROLES: Role[] = ['owner', 'admin', 'member'];

export async function seedDemo() {
  const printed: string[] = [];
  for (const o of ORGS) {
    const org = await db.org.upsert({ where: { slug: o.slug }, create: { slug: o.slug, name: o.name }, update: {} });
    for (const role of ROLES) {
      const email = `${role}@${o.domain}`;
      const mfa = role !== 'member'; // owners and admins are TOTP-enrolled, as the guard requires
      const data = {
        isDemo: true,
        name: `${role[0]!.toUpperCase()}${role.slice(1)} (${o.name})`,
        ...(mfa && { totpSecretSealed: sealSecret(DEMO_TOTP_SECRET, 'totp'), totpEnrolledAt: now(), totpLastStep: null }),
      };
      const user = await db.user.upsert({ where: { email }, create: { email, ...data }, update: data });
      await db.membership.upsert({
        where: { orgId_userId: { orgId: org.id, userId: user.id } },
        create: { orgId: org.id, userId: user.id, role },
        update: { role },
      });
      printed.push(`${email}  ${role} of ${o.name}${mfa ? '  (TOTP)' : ''}`);
    }
    for (const name of o.projects) {
      if (!(await db.project.findFirst({ where: { orgId: org.id, name } }))) await db.project.create({ data: { orgId: org.id, name, notes: '' } });
    }
  }
  return printed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = await seedDemo();
  console.log(`Seeded demo accounts. Sign in at /demo (DEMO_MODE=1):\n  ${lines.join('\n  ')}`);
  console.log(`TOTP secret for the (TOTP) accounts, for an authenticator app: ${DEMO_TOTP_SECRET}`);
  await db.$disconnect();
}
