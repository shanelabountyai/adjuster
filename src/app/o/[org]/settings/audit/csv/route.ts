import { actorEmails, audit, auditEvents, auditFilter, toCsv } from '@/core/audit';
import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';

export const dynamic = 'force-dynamic';

/** The newest this many events matching the filter; past it, narrow the dates or use the org data export. */
const AUDIT_CSV_MAX_ROWS = 10_000;

// F-01's Download CSV: the viewer's filter over the same query the data export uses (addendum §4, one exporter).
export async function GET(req: Request, { params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org, 'audit.read');
  const f = await auditFilter(Object.fromEntries(new URL(req.url).searchParams));
  // v1.6.5 (audit A-10): capped, newest first, and the download is itself audited. The full history is the data export.
  const rows = await withOrg(ctx, async (tx) => {
    const page = await auditEvents(tx, ctx.orgId, f, { take: AUDIT_CSV_MAX_ROWS });
    await audit(ctx, 'audit.exported', { data: { rows: page.length, capped: page.length === AUDIT_CSV_MAX_ROWS, actorUserId: f.actorUserId ?? null, actionPrefix: f.action ?? null, from: f.from?.toISOString() ?? null, to: f.to?.toISOString() ?? null } }, tx);
    return page;
  });
  const emails = await actorEmails(rows.map((r) => r.actorUserId));
  const csv = toCsv([
    ['id', 'at', 'actor', 'action', 'targetType', 'targetId', 'data'],
    ...rows.map((r) => [r.id, r.at, r.actorUserId ? (emails.get(r.actorUserId) ?? r.actorUserId) : 'system', r.action, r.targetType, r.targetId, r.data]),
  ]);
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${ctx.slug}-audit.csv"`, 'Cache-Control': 'no-store' },
  });
}
