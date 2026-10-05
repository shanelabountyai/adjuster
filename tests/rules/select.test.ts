import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectVersions } from '@/rules/select';

// VP-02..VP-04 (D35): contract pin + version list + asOf → the versions a decision runs under, or a coded error.
// Each case carries a date of loss and a date reported so that ignoring them is what the fixture proves.
type V = { name: string; kind: string; status: string; effectiveFrom: string };
type Case = { name: string; contract: { planVersion: string }; asOf: string; versions?: V[]; expected: Record<string, string> };
const read = (id: string): { title: string; versions: V[]; cases: Case[] } => JSON.parse(readFileSync(`fixtures/vp/${id}.json`, 'utf8'));

for (const id of ['VP-02', 'VP-03', 'VP-04']) {
  const fx = read(id);
  describe(`${id} ${fx.title}`, () => {
    for (const c of fx.cases) {
      it(c.name, () => {
        const r = selectVersions(c.contract, c.versions ?? fx.versions, c.asOf);
        expect('error' in r ? r : { plan: r.plan.name, ops: r.ops.name }).toEqual(c.expected);
      });
    }
  });
}

it('a pin that names no version in the list is not effective either', () => {
  expect(selectVersions({ planVersion: 'plan-v9' }, read('VP-02').versions, '2026-08-06')).toEqual({ error: 'NO_EFFECTIVE_VERSION', kind: 'plan' });
});
