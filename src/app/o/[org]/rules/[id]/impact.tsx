import { ActionForm } from '@/core/ui/action-form';
import { impactOfDraft } from '@/adjudication/drafts';
import { pool } from '@/adjudication/pool';
import { money } from '@/rules/render';
import { publishRuleDraft } from './actions';

// Task 4.11. The impact diff of 4.4 as tables, and the publish button. `before` is the stored trace, `after` is the
// draft run over it; the page prints both and computes nothing. A draft that does not validate has no diff (D71).
const cents = (c: number | null) => (c === null ? '—' : money(c));
const list = (a: readonly string[]) => (a.length ? a.join(', ') : '—');

type Diff = Awaited<ReturnType<typeof impactOfDraft>>;

/** The page fetches (a component that awaits cannot be rendered by the page tests); this prints. */
export const diffOf = (id: string): Promise<Diff | string> => impactOfDraft(pool, { id }).catch((e: Error) => e.message);

export function Impact({ slug, id, isAuthor, diff }: { slug: string; id: string; isAuthor: boolean; diff: Diff | string }) {
  if (typeof diff === 'string') return <section><h2>Impact</h2><p>No impact diff yet: {diff}</p></section>;
  return (
    <section>
      <h2>Impact</h2>
      <p>{diff.changed.length} claim(s) move; {diff.unchanged} do not.</p>
      {diff.changed.length > 0 && (
        <table>
          <thead><tr><th>Claim</th><th>Before</th><th>After</th><th>Reasons added</th><th>Reasons removed</th><th>Cents before</th><th>Cents after</th></tr></thead>
          <tbody>
            {diff.changed.map((d) => (
              <tr key={d.claim}>
                <td>{d.claim}</td><td>{d.before.outcome}</td><td>{d.after.outcome}</td>
                <td>{list(d.after.reasons.filter((r) => !d.before.reasons.includes(r)))}</td>
                <td>{list(d.before.reasons.filter((r) => !d.after.reasons.includes(r)))}</td>
                <td>{cents(d.before.payableCents)}</td><td>{cents(d.after.payableCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Rows no stored decision hit</h3>
      {diff.unhit.length ? <ul>{diff.unhit.map((u) => <li key={`${u.ruleId}/${u.rowId}`}>{u.ruleId} {u.rowId}</li>)}</ul> : <p>None.</p>}
      {isAuthor
        ? <p>You last saved this draft, so someone else has to publish it.</p>
        : null}
      <ActionForm action={publishRuleDraft.bind(null, slug)}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="diffHash" value={diff.diffHash} />
        <button disabled={isAuthor}>Publish this draft</button>
      </ActionForm>
    </section>
  );
}
