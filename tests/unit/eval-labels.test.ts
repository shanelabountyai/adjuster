import { describe, expect, it } from 'vitest';
import { plan, render, split } from '../../eval/generate';
import { labelIds, loadSchema, loadSignedLabels, readLabel, shapeProblems, sign, unsignedReason, type Label } from '../../eval/labels';

// D91: the label set's shape, the split, the generator's determinism, and the rule that only signed labels are read.

const specs = plan();
const schema = loadSchema();

describe('eval label set (D91 b)', () => {
  it('is 120 files: 28 per type, 8 other, 15 real photos, at least 5 adversarial', () => {
    const count = (f: (s: (typeof specs)[number]) => boolean) => specs.filter(f).length;
    expect(specs).toHaveLength(120);
    for (const type of Object.keys(schema.types)) expect(count((s) => s.type === type)).toBe(28);
    expect(count((s) => s.type === 'other')).toBe(8);
    expect(count((s) => s.kind === 'real_photo')).toBe(15);
    expect(count((s) => s.kind === 'adversarial')).toBeGreaterThanOrEqual(5);
    expect(new Set(specs.map((s) => s.id)).size).toBe(120);
  });

  it('splits 60/60 by document, disjoint, with real photos and adversarial files on both sides', () => {
    const { dev, test } = split(specs);
    expect([dev.length, test.length]).toEqual([60, 60]);
    expect(new Set([...dev, ...test]).size).toBe(120);
    const kind = new Map(specs.map((s) => [s.id, s.kind]));
    for (const side of [dev, test]) {
      expect(side.filter((id) => kind.get(id) === 'real_photo').length).toBeGreaterThanOrEqual(5);
      expect(side.some((id) => kind.get(id) === 'adversarial')).toBe(true);
    }
    expect(split(plan())).toEqual(split(specs));
  });

  it('renders identical bytes on a second run, one spec per type and kind', async () => {
    const sample = [...new Map(specs.map((s) => [`${s.type}/${s.kind}/${s.variant}`, s])).values()];
    for (const s of sample) {
      const [a, b] = [await render(s), await render(s)];
      expect(Object.keys(a.outputs)).toEqual(Object.keys(b.outputs));
      for (const p of Object.keys(a.outputs)) expect(a.outputs[p]!.equals(b.outputs[p]!), `${s.id} ${p}`).toBe(true);
      expect(a.doc.fields).toEqual(b.doc.fields);
    }
  }, 60_000);

  it('writes a draft label for every file that matches its schema', () => {
    expect(labelIds()).toEqual(specs.map((s) => s.id).sort());
    for (const id of labelIds()) expect(shapeProblems(readLabel(id), schema), id).toEqual([]);
  });
});

describe('only signed labels are read (D91 d)', () => {
  const draft: Label = { ...readLabel('pop-022'), signed: null };

  it('refuses a draft; loadSignedLabels names every unusable label or returns all 120', () => {
    expect(unsignedReason(draft, schema)).toBe('not signed');
    const bad = labelIds().filter((id) => unsignedReason(readLabel(id), schema));
    if (bad.length) expect(() => loadSignedLabels()).toThrow(`${bad.length} label(s) unusable`);
    else expect(loadSignedLabels()).toHaveLength(120);
  });

  it('accepts a signed label, then refuses it once the fields or the file change', () => {
    const signed = sign(draft, 'tester', '2026-10-14T00:00:00Z');
    expect(unsignedReason(signed, schema)).toBeNull();
    expect(unsignedReason({ ...signed, fields: { ...signed.fields, total_paid: { value: 1, raw: '$0.01' } } }, schema)).toBe('fields changed since signing');
    expect(unsignedReason({ ...signed, signed: { ...signed.signed!, fileSha256: '0'.repeat(64) } }, schema)).toBe('file changed since signing');
    expect(unsignedReason({ ...signed, file: 'photos/nope.jpg' }, schema)).toMatch(/missing/);
  });

  it('refuses a signed label whose fields do not fit the schema', () => {
    const fields = { ...draft.fields };
    delete fields.serial_or_imei;
    const bad = sign({ ...draft, fields: { ...fields, item_price: { value: '12.00' } } }, 'tester', '2026-10-14T00:00:00Z');
    expect(unsignedReason(bad, schema)).toMatch(/serial_or_imei: missing/);
    expect(unsignedReason(bad, schema)).toMatch(/item_price: "12.00" is not a cents/);
  });
});
