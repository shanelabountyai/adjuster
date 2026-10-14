import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { namesOf } from './people';

export const metadata = { title: 'Rule sets' };

// Task 4.9. Every version of every product and kind. Rule sets are global (D73); the org is the session only.
export default async function RuleSets({ params }: { params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const versions = await db.ruleSetVersion.findMany({
    orderBy: [{ product: 'asc' }, { kind: 'asc' }, { version: 'desc' }],
    select: { id: true, kind: true, product: true, version: true, status: true, effectiveFrom: true, contentHash: true, authoredBy: true, publishedBy: true },
  });
  const who = await namesOf(versions.flatMap((v) => [v.authoredBy, v.publishedBy]));
  const groups = new Map<string, typeof versions>();
  for (const v of versions) groups.set(`${v.product} ${v.kind}`, [...(groups.get(`${v.product} ${v.kind}`) ?? []), v]);

  return (
    <main>
      <h1>Rule sets</h1>
      <p>&ldquo;file&rdquo; is a version the seed loaded from <code>rules/</code>, with no author or publisher.</p>
      {[...groups].map(([name, rows]) => (
        <section key={name}>
          <h2>{name}</h2>
          <table>
            <thead><tr><th>Version</th><th>Status</th><th>Effective</th><th>Hash</th><th>Author</th><th>Publisher</th></tr></thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td><Link href={`/o/${ctx.slug}/rules/${v.id}`}>v{v.version}</Link></td>
                  <td>{v.status}</td>
                  <td>{v.effectiveFrom.toISOString().slice(0, 10)}</td>
                  <td><code title={v.contentHash ?? undefined}>{v.contentHash?.slice(0, 12) ?? '—'}</code></td>
                  <td>{who(v.authoredBy)}</td>
                  <td>{v.status === 'draft' ? '—' : who(v.publishedBy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}
