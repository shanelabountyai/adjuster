import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { money } from '@/rules/render';
import { ruleSetSchema, type Cell } from '@/rules/schema';
import { namesOf } from '../people';

export const metadata = { title: 'Rule set' };

// Task 4.9. One version read as tables: the stored body printed, never evaluated. A draft mid-edit may not parse
// (D76 b); it is then shown as its JSON.
const cell = (c: Cell) => `${c.fact} ${c.op}${c.value === undefined ? '' : ` ${JSON.stringify(c.value)}`}`;
const when = (cs: Cell[] | undefined) => (cs?.length ? cs.map(cell).join(' and ') : 'always');
const operand = (o: { fact: string } | { const: number } | { reg: string }) =>
  'fact' in o ? o.fact : 'reg' in o ? `reg ${o.reg}` : String(o.const);
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export default async function RuleSet({ params }: { params: Promise<{ org: string; id: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  const v = isUuid(id) ? await db.ruleSetVersion.findUnique({ where: { id } }) : null;
  if (!v) notFound();
  const who = await namesOf([v.authoredBy, v.publishedBy]);
  const parsed = ruleSetSchema.safeParse(v.body);
  const rs = parsed.success ? parsed.data : null;

  return (
    <main>
      <p><Link href={`/o/${ctx.slug}/rules`}>Rule sets</Link></p>
      <h1>{v.product} {v.kind} v{v.version}</h1>
      <dl>
        <dt>Status</dt><dd>{v.status}</dd>
        <dt>Effective</dt><dd>{v.effectiveFrom.toISOString().slice(0, 10)}</dd>
        <dt>Hash</dt><dd><code>{v.contentHash ?? '—'}</code></dd>
        <dt>Author</dt><dd>{who(v.authoredBy)}</dd>
        <dt>Publisher</dt><dd>{v.status === 'draft' ? '—' : who(v.publishedBy)}</dd>
        {rs && <><dt>Fact dictionary</dt><dd>{rs.factDictionary}</dd></>}
      </dl>

      {!rs && <><p>This draft does not parse as a rule set yet.</p><pre>{JSON.stringify(v.body, null, 2)}</pre></>}

      {rs?.rules.map((r) => (
        <section key={r.id}>
          <h2>{r.id} {r.name}</h2>
          <p>Stage {r.stage} · {r.kind} · class {r.class}{r.note && <> · {r.note}</>}</p>
          <table>
            <thead><tr><th>Row</th><th>When</th><th>Outcome</th><th>Reason</th><th>Clause</th></tr></thead>
            <tbody>
              {r.rows.map((row) => (
                <tr key={row.id}><td>{row.id}</td><td>{when(row.when)}</td><td>{row.then.outcome}</td><td>{row.then.reasonCode ?? ''}</td><td>{row.then.clause ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {rs?.lookups?.map((l) => (
        <section key={l.id}>
          <h2>Lookup {l.id}</h2>
          {l.note && <p>{l.note}</p>}
          <table>
            <thead><tr><th>Row</th><th>When</th><th>Value</th></tr></thead>
            <tbody>{l.rows.map((row) => <tr key={row.id}><td>{row.id}</td><td>{when(row.when)}</td><td>{String(row.value)}</td></tr>)}</tbody>
          </table>
        </section>
      ))}

      {rs?.payout && (
        <section>
          <h2>Payout</h2>
          <table>
            <thead><tr><th>Step</th><th>Op</th><th>Register</th><th>Operand</th><th>When</th><th>Label</th></tr></thead>
            <tbody>
              {rs.payout.steps.map((s) => (
                <tr key={s.id}>
                  <td>{s.id}</td><td>{s.op}</td><td>{s.reg ?? ''}</td>
                  <td>{s.operand ? operand(s.operand) : (s.operands?.map(operand).join(', ') ?? '')}</td>
                  <td>{when(s.when)}</td><td>{s.label ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Outputs: {Object.entries(rs.payout.outputs).map(([k, reg]) => `${k} ← ${reg}`).join(' · ')}</p>
        </section>
      )}

      {rs?.fulfillment && (
        <section>
          <h2>Fulfilment</h2>
          <table>
            <thead><tr><th>Row</th><th>When</th></tr></thead>
            <tbody>{rs.fulfillment.map((f) => <tr key={f.id}><td>{f.id}</td><td>{when(f.when)}</td></tr>)}</tbody>
          </table>
        </section>
      )}

      {rs?.authority && (
        <section>
          <h2>Authority</h2>
          <table>
            <thead><tr><th>Tier</th><th>Approves up to</th><th>Powers</th></tr></thead>
            <tbody>
              {rs.authority.map((a) => (
                <tr key={a.code}><td>{a.code}</td><td>{a.approveUpToCents === null ? 'no limit' : money(a.approveUpToCents)}</td><td>{a.powers.join(', ')}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {rs?.reminders && <p>Reminders: day {rs.reminders.firstDay}, day {rs.reminders.secondDay}; closed for no response on day {rs.reminders.closeDay}.</p>}
      {rs?.outcomePolicy && <p>Automatic denial {rs.outcomePolicy.autoDenyEnabled ? 'on' : 'off'}.</p>}
    </main>
  );
}
