import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOrg } from '@/core/authz/guards';
import { ActionForm } from '@/core/ui/action-form';
import { db } from '@/core/db';
import { dictFile } from '@/adjudication/decisions';
import { money } from '@/rules/render';
import { ruleSetSchema, type Cell } from '@/rules/schema';
import { type Issue, validateDictionary } from '@/rules/validate';
import { namesOf } from '../people';
import { startDraft } from './actions';
import { Editor } from './editor';
import { diffOf, Impact } from './impact';

export const metadata = { title: 'Rule set' };

// Task 4.9. One version read as tables: the stored body printed, never evaluated. A draft mid-edit may not parse
// (D76 b); it is then shown as its JSON. Task 4.10: a draft that parses is shown as the editor instead.
const cell = (c: Cell) => `${c.fact} ${c.op}${c.value === undefined ? '' : ` ${JSON.stringify(c.value)}`}`;
const when = (cs: Cell[] | undefined) => (cs?.length ? cs.map(cell).join(' and ') : 'always');
const operand = (o: { fact: string } | { const: number } | { reg: string }) =>
  'fact' in o ? o.fact : 'reg' in o ? `reg ${o.reg}` : String(o.const);
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
// The issues the last save returned, carried on the redirect (D88). Read, never recomputed: the page does not validate.
function savedIssues(q: string | undefined): Issue[] | null {
  if (!q) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(q, 'base64url').toString());
    return Array.isArray(v) ? v.filter((i): i is Issue => typeof i?.code === 'string' && typeof i?.path === 'string' && typeof i?.message === 'string') : null;
  } catch {
    return null;
  }
}

export default async function RuleSet({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams?: Promise<{ issues?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { id } = await params;
  const q = (await searchParams) ?? {};
  const v = isUuid(id) ? await db.ruleSetVersion.findUnique({ where: { id } }) : null;
  if (!v) notFound();
  const who = await namesOf([v.authoredBy, v.publishedBy]);
  const parsed = ruleSetSchema.safeParse(v.body);
  const rs = parsed.success ? parsed.data : null;
  const open = v.status === 'draft' ? null : await db.ruleSetVersion.findFirst({ where: { kind: v.kind, product: v.product, status: 'draft' }, select: { id: true, version: true } });

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

      {v.status !== 'draft' && (open
        ? <p><Link href={`/o/${ctx.slug}/rules/${open.id}`}>Open draft v{open.version}</Link></p>
        : <ActionForm action={startDraft.bind(null, ctx.slug)}><input type="hidden" name="id" value={v.id} /><button>Start a draft from this version</button></ActionForm>)}

      {!rs && <><p>This draft does not parse as a rule set yet.</p><pre>{JSON.stringify(v.body, null, 2)}</pre></>}

      {rs && v.status === 'draft' && <Editor slug={ctx.slug} id={v.id} rs={rs} dict={validateDictionary(dictFile(rs)).dict!} issues={savedIssues(q.issues)} />}
      {rs && v.status === 'draft' && <Impact slug={ctx.slug} id={v.id} isAuthor={v.authoredBy === ctx.userId} diff={await diffOf(v.id)} />}

      {v.status !== 'draft' && rs?.rules.map((r) => (
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

      {v.status !== 'draft' && rs?.lookups?.map((l) => (
        <section key={l.id}>
          <h2>Lookup {l.id}</h2>
          {l.note && <p>{l.note}</p>}
          <table>
            <thead><tr><th>Row</th><th>When</th><th>Value</th></tr></thead>
            <tbody>{l.rows.map((row) => <tr key={row.id}><td>{row.id}</td><td>{when(row.when)}</td><td>{String(row.value)}</td></tr>)}</tbody>
          </table>
        </section>
      ))}

      {v.status !== 'draft' && rs?.payout && (
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

      {v.status !== 'draft' && rs?.fulfillment && (
        <section>
          <h2>Fulfilment</h2>
          <table>
            <thead><tr><th>Row</th><th>When</th></tr></thead>
            <tbody>{rs.fulfillment.map((f) => <tr key={f.id}><td>{f.id}</td><td>{when(f.when)}</td></tr>)}</tbody>
          </table>
        </section>
      )}

      {v.status !== 'draft' && rs?.authority && (
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

      {v.status !== 'draft' && rs?.reminders && <p>Reminders: day {rs.reminders.firstDay}, day {rs.reminders.secondDay}; closed for no response on day {rs.reminders.closeDay}.</p>}
      {v.status !== 'draft' && rs?.outcomePolicy && <p>Automatic denial {rs.outcomePolicy.autoDenyEnabled ? 'on' : 'off'}.</p>}
    </main>
  );
}
