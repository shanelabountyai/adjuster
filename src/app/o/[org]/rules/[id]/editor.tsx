import { ActionForm } from '@/core/ui/action-form';
import { money } from '@/rules/render';
import { OPERATORS, type Cell, type Dictionary, type RuleSet } from '@/rules/schema';
import { operatorsFor, type Issue } from '@/rules/validate';
import { saveRuleDraft } from './actions';

// Task 4.10 (D72). The form over a draft. Every input is named by its path in the body (./form.ts applies them); the
// selects come from the dictionary and from the operators the fact's type allows; values take the fact's native input.
// It renders and posts, nothing more: the issues shown are the ones the last save returned.
type Fact = Dictionary['facts'][number];
const LIST_OPS = new Set(['in', 'not_in', 'between']);
const NUMERIC = new Set(['int', 'cents', 'bps']);

function Issues({ list }: { list: Issue[] }) {
  return list.length ? <ul role="alert">{list.map((i, k) => <li key={k}><strong>{i.code}</strong> {i.message}</li>)}</ul> : null;
}

function Value({ name, fact, c }: { name: string; fact?: Fact; c: Cell }) {
  const v = c.value;
  if (LIST_OPS.has(c.op)) return <input name={name} defaultValue={Array.isArray(v) ? v.join(', ') : (v ?? '').toString()} placeholder={c.op === 'between' ? 'low, high' : 'a, b'} aria-label="values, comma-separated" />;
  const one = Array.isArray(v) ? '' : (v ?? '').toString();
  if (fact?.type === 'bool' || fact?.type === 'enum') {
    const opts = fact.type === 'bool' ? ['true', 'false'] : fact.values!;
    return <select name={name} defaultValue={one} aria-label="value"><option value="">—</option>{opts.map((o) => <option key={o}>{o}</option>)}</select>;
  }
  const type = NUMERIC.has(fact?.type ?? '') ? 'number' : fact?.type === 'date' ? 'date' : 'text';
  return <>
    <input name={name} type={type} step={type === 'number' ? 1 : undefined} defaultValue={one} aria-label="value" />
    {fact?.type === 'cents' && typeof v === 'number' && <small> {money(v)}</small>}
  </>;
}

function When({ at, cells, dict, near }: { at: string; cells: Cell[]; dict: Dictionary; near: (p: string) => Issue[] }) {
  const byId = new Map(dict.facts.map((f) => [f.id, f])); // list facts only feed derived facts, so no cell offers one
  return <>
    {cells.map((c, i) => {
      const p = `${at}.${i}`;
      const fact = byId.get(c.fact);
      const ops: readonly string[] = fact ? operatorsFor(fact.type) : OPERATORS; // an unknown fact: every operator, and the issue beside it
      return (
        <div key={i}>
          <select name={`${p}.fact`} defaultValue={c.fact} aria-label="fact">
            {!fact && <option>{c.fact}</option>}
            {dict.facts.filter((f) => f.type !== 'list' || f.id === c.fact).map((f) => <option key={f.id} value={f.id}>{f.id} ({f.type})</option>)}
          </select>{' '}
          <select name={`${p}.op`} defaultValue={c.op} aria-label="operator">
            {[...ops, ...(ops.includes(c.op) ? [] : [c.op])].map((o) => <option key={o}>{o}</option>)}
          </select>{' '}
          {c.op !== 'is_known' && <Value name={`${p}.value`} fact={fact} c={c} />}{' '}
          <button name="_do" value={`remove:${p}`}>Remove</button>
          <Issues list={near(p)} />
        </div>
      );
    })}
    <button name="_do" value={`add:${at}`}>Add condition</button>
  </>;
}

export function Editor({ slug, id, rs, dict, issues }: { slug: string; id: string; rs: RuleSet; dict: Dictionary; issues: Issue[] | null }) {
  const all = issues ?? [];
  const near = (p: string) => all.filter((i) => i.path === p || i.path.startsWith(`${p}.`));
  const exact = (p: string) => all.filter((i) => i.path === p);
  const save = <button name="_do" value="save">Save draft</button>;

  return (
    <ActionForm action={saveRuleDraft.bind(null, slug)}>
      <input type="hidden" name="id" value={id} />
      {/* first, so Enter in a field saves rather than pressing the first Remove */}
      {save}
      {issues && (all.length ? <><p>Saved with {all.length} issue(s); publishing needs none.</p><Issues list={all.map((i) => ({ ...i, message: `${i.path}: ${i.message}` }))} /></> : <p>Saved. No issues.</p>)}

      <p><label>Effective from <input type="date" name="effectiveFrom" defaultValue={rs.effectiveFrom} required /></label></p>
      <Issues list={near('effectiveFrom')} />

      {rs.rules.map((r, ri) => (
        <section key={r.id}>
          <h2>{r.id} {r.name}</h2>
          <p>Stage {r.stage} · {r.kind} · class {r.class}</p>
          <Issues list={exact(`rules.${ri}`)} />
          <table>
            <thead><tr><th>Row</th><th>When</th><th>Outcome</th><th>Templates</th><th /></tr></thead>
            <tbody>
              {r.rows.map((row, i) => {
                const p = `rules.${ri}.rows.${i}`;
                return (
                  <tr key={i}>
                    <td><input name={`${p}.id`} defaultValue={row.id} required aria-label="row id" /><Issues list={[...exact(p), ...near(`${p}.id`), ...near(`${p}.then`)]} /></td>
                    <td><When at={`${p}.when`} cells={row.when} dict={dict} near={near} /></td>
                    <td>{row.then.outcome} {row.then.reasonCode ?? ''}</td>
                    <td>
                      <label>Claimant <textarea name={`${p}.then.claimantText`} defaultValue={row.then.claimantText ?? ''} /></label>
                      <label>Note <textarea name={`${p}.then.noteText`} defaultValue={row.then.noteText ?? ''} /></label>
                    </td>
                    <td>{r.rows.length > 1 && <button name="_do" value={`remove:${p}`}>Remove row</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button name="_do" value={`add:rules.${ri}.rows`}>Add row</button>
        </section>
      ))}

      {rs.lookups?.map((l, li) => (
        <section key={l.id}>
          <h2>Lookup {l.id}</h2>
          <Issues list={exact(`lookups.${li}`)} />
          <table>
            <thead><tr><th>Row</th><th>When</th><th>Value</th><th /></tr></thead>
            <tbody>
              {l.rows.map((row, i) => {
                const p = `lookups.${li}.rows.${i}`;
                return (
                  <tr key={i}>
                    <td><input name={`${p}.id`} defaultValue={row.id} required aria-label="row id" /><Issues list={[...exact(p), ...near(`${p}.id`)]} /></td>
                    <td><When at={`${p}.when`} cells={row.when} dict={dict} near={near} /></td>
                    <td>
                      {typeof row.value === 'boolean'
                        ? <select name={`${p}.value`} defaultValue={String(row.value)} aria-label="value"><option>true</option><option>false</option></select>
                        : <input name={`${p}.value`} type={typeof row.value === 'number' ? 'number' : 'text'} step={typeof row.value === 'number' ? 1 : undefined} defaultValue={String(row.value)} required aria-label="value" />}
                      <Issues list={near(`${p}.value`)} />
                    </td>
                    <td>{l.rows.length > 1 && <button name="_do" value={`remove:${p}`}>Remove row</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button name="_do" value={`add:lookups.${li}.rows`}>Add row</button>
        </section>
      ))}

      {rs.payout && (
        <section>
          <h2>Payout</h2>
          <p>Steps are a file edit (D72); their constants are not.</p>
          <table>
            <thead><tr><th>Step</th><th>Op</th><th>Register</th><th>Operand</th><th>Label</th></tr></thead>
            <tbody>
              {rs.payout.steps.map((s, si) => {
                const ops = s.operand ? [['operand', s.operand] as const] : (s.operands ?? []).map((o, k) => [`operands.${k}`, o] as const);
                return (
                  <tr key={s.id}>
                    <td>{s.id}</td><td>{s.op}</td><td>{s.reg ?? ''}</td>
                    <td>
                      {ops.map(([k, o]) => <span key={k}>{'const' in o
                        ? <input name={`payout.steps.${si}.${k}.const`} type="number" step={1} defaultValue={o.const} required aria-label="constant" />
                        : 'fact' in o ? o.fact : `reg ${o.reg}`}{' '}</span>)}
                      <Issues list={near(`payout.steps.${si}`)} />
                    </td>
                    <td>{s.label ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {rs.fulfillment && (
        <section>
          <h2>Fulfilment</h2>
          <table>
            <thead><tr><th>Row</th><th>When</th></tr></thead>
            <tbody>{rs.fulfillment.map((f, i) => <tr key={f.id}><td>{f.id}</td><td><When at={`fulfillment.${i}.when`} cells={f.when} dict={dict} near={near} /></td></tr>)}</tbody>
          </table>
        </section>
      )}

      {rs.authority && (
        <section>
          <h2>Authority</h2>
          <table>
            <thead><tr><th>Tier</th><th>Approves up to (cents; blank is no limit)</th><th>Powers (comma-separated)</th></tr></thead>
            <tbody>
              {rs.authority.map((a, i) => (
                <tr key={a.code}>
                  <td>{a.code}</td>
                  <td><input name={`authority.${i}.approveUpToCents`} type="number" step={1} defaultValue={a.approveUpToCents ?? ''} aria-label="limit in cents" /><Issues list={near(`authority.${i}`)} /></td>
                  <td><input name={`authority.${i}.powers`} defaultValue={a.powers.join(', ')} aria-label="powers" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {rs.reminders && (
        <section>
          <h2>Reminders</h2>
          {(['firstDay', 'secondDay', 'closeDay'] as const).map((k) => (
            <label key={k}>{k} <input name={`reminders.${k}`} type="number" step={1} defaultValue={rs.reminders![k]} required /> </label>
          ))}
          <Issues list={near('reminders')} />
        </section>
      )}

      {rs.outcomePolicy && (
        <p><label>Automatic denial <select name="outcomePolicy.autoDenyEnabled" defaultValue={String(rs.outcomePolicy.autoDenyEnabled)}><option value="true">on</option><option value="false">off</option></select></label></p>
      )}

      {save}
    </ActionForm>
  );
}
