// Clone-owned (v1.6.0), like org-hooks.ts: the optional modules that plug into core. Imported for its side effect by
// the routes that sign people in (/login/request, /login/redeem), and for each module's tables in a data export
// (export-hooks.ts; secrets never selected, INV-34). Removing a module deletes its marked lines (foundation:check-modules).
import type { ExportTable } from '@/core/tenancy/export';
import { registerSsoHooks } from '@/core/auth/sso-hook'; // sso
import { ssoHooks } from '@/modules/sso/hooks'; // sso

registerSsoHooks(ssoHooks); // sso

export const moduleExportTables: readonly ExportTable[] = [
  { name: 'BillingAccount', rows: (tx, orgId) => tx.billingAccount.findMany({ where: { orgId }, select: { plan: true, status: true, currentPeriodEnd: true, updatedAt: true } }) }, // billing
  { name: 'Outbox', rows: (tx, orgId) => tx.outbox.findMany({ where: { orgId }, select: { id: true, channel: true, to: true, template: true, sendAfter: true, sentAt: true, attempts: true } }) }, // notifications
  { name: 'SsoConnection', rows: (tx, orgId) => tx.ssoConnection.findMany({ where: { orgId }, select: { issuer: true, clientId: true, defaultRole: true, allowedDomains: true, required: true, enabledAt: true, createdAt: true } }) }, // sso
  { name: 'SsoDomain', rows: (tx, orgId) => tx.ssoDomain.findMany({ where: { orgId }, select: { domain: true, verifiedAt: true, createdAt: true } }) }, // sso
];
