import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { readDocumentStatuses } from '@/adjudication/documents';
import { renderDecision } from '@/adjudication/letters';
import { pool } from '@/adjudication/pool';
import { money } from '@/rules/render';
import { namesOf } from '../../rules/people';

export const metadata = { title: 'Claim' };

// Task 4.12 (D67). One claim read top to bottom from stored rows: nothing here acts, and nothing is computed. Letters
// and notes are rendered from each decision's stored trace (D62), never from the rules in force now.
const cents = (c: number | null) => (c === null ? '—' : money(c));
const ver = (v: { product: string; kind: string; version: number }) => `${v.product} ${v.kind} v${v.version}`;
const day = (d: Date) => d.toISOString().slice(0, 10);
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

export default async function ClaimPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  await requireOrg((await params).org);
  const claim = await db.claim.findUnique({ where: { id: (await params).id } });
  if (!claim) notFound();

  const decisions = await db.decision.findMany({
    where: { claimId: claim.id }, orderBy: { createdAt: 'asc' },
    include: { planVersion: { select: { product: true, kind: true, version: true } }, opsVersion: { select: { product: true, kind: true, version: true } }, payment: true },
  });
  const rendered = await Promise.all(decisions.map((d) => renderDecision(pool, d.id)));
  const docs = await db.document.findMany({ where: { claimId: claim.id }, include: { versions: { orderBy: { version: 'asc' } } }, orderBy: { type: 'asc' } });
  const status = await readDocumentStatuses(pool, claim.id);
  const waivers = await db.documentWaiver.findMany({ where: { claimId: claim.id }, orderBy: { type: 'asc' } });
  const events = await db.auditEvent.findMany({ where: { targetType: 'Claim', targetId: claim.id }, orderBy: { id: 'asc' } });
  const who = await namesOf([
    ...decisions.flatMap((d) => [d.overrideBy, d.appealBy]), ...waivers.map((w) => w.waivedBy), ...events.map((e) => e.actorUserId),
  ]);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const kind = (d: (typeof decisions)[number]) => (d.overridesId ? `override of ${byId.get(d.overridesId)?.outcome ?? 'a decision'}` : d.supersedesId ? 'supersedes the one before' : 'engine');

  return (
    <main>
      <h1>Claim {claim.id}</h1>
      <p>Status <strong>{claim.status}</strong> · payment <strong>{claim.paymentStatus}</strong> · contract {claim.contractId} · opened {day(claim.createdAt)}</p>

      <h2>Decisions</h2>
      {decisions.length === 0 && <p>None yet.</p>}
      {decisions.map((d, i) => (
        <section key={d.id}>
          <h3>{i + 1}. {d.outcome} · {cents(d.payableCents)} <small>({kind(d)})</small></h3>
          <p>
            As of {day(d.asOf)} · plan {ver(d.planVersion)} · ops {ver(d.opsVersion)} · engine {d.engineSemanticsVersion}
            {d.overrideBy && <> · override by {who(d.overrideBy)} ({d.overrideTier}): {d.overrideReasonCode}, {d.overrideReasonText}</>}
            {d.appealBy && <> · appeal decided by {who(d.appealBy)} ({d.appealTier})</>}
          </p>
          <table>
            <thead><tr><th>Rule</th><th>Stage</th><th>Result</th><th>Reason</th><th>Clause</th></tr></thead>
            <tbody>
              {(d.explanation as { rules: { ruleId: string; stage: string; result: string; reasonCode: string | null; clause: string | null }[] }).rules.map((r) => (
                <tr key={r.ruleId}><td>{r.ruleId}</td><td>{r.stage}</td><td>{r.result}</td><td>{r.reasonCode ?? '—'}</td><td>{r.clause ?? '—'}</td></tr>
              ))}
            </tbody>
          </table>
          <h4>Letter</h4>
          <pre>{rendered[i]!.letter}</pre>
          <h4>Note</h4>
          <pre>{rendered[i]!.note}</pre>
          {d.payment && <p>Paid {cents(d.payment.amountCents)} on {day(d.payment.asOf)} · ref {d.payment.providerRef}</p>}
        </section>
      ))}

      <h2>Documents</h2>
      {docs.length === 0 && waivers.length === 0 && <p>None.</p>}
      <table>
        <thead><tr><th>Type</th><th>Status</th><th>Versions</th></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td>{d.type}</td><td>{status.docs[d.type] ?? '—'}</td>
              <td>{d.versions.map((v) => `v${v.version} ${status.versions[`${d.type}/${v.version}`] ?? ''}`.trim()).join(', ')}</td>
            </tr>
          ))}
          {waivers.map((w) => (
            <tr key={w.id}><td>{w.type}</td><td>waived</td><td>{w.reasonText} · {w.tier} · {who(w.waivedBy)} · {day(w.asOf)}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>Audit events</h2>
      <table>
        <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Data</th></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={String(e.id)}><td>{stamp(e.at)}</td><td>{e.action}</td><td>{e.actorUserId ? who(e.actorUserId) : 'system'}</td><td><code>{JSON.stringify(e.data)}</code></td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
