import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { intakeSchemaFile, OTHER_TYPE } from '@/intake/schema';

// Hardening 2026-10-20. The extraction schemas are data (D90 H, D91 a); intakeSchemaFile is their structure, and was
// exercised only through rules:lint and eval/. These hold what it must refuse, and that the committed file passes.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const committed = read('intake/electronics/schemas-v1.json');
const file = (types: unknown, extra: object = {}) => ({ id: 'x-intake-v1', factDictionary: 'facts-v1', types, ...extra });
const ok = (v: unknown) => intakeSchemaFile.safeParse(v).success;

describe('intake extraction schema file', () => {
  it('the committed electronics schema parses, and each type is a document its fact dictionary declares', () => {
    const parsed = intakeSchemaFile.parse(committed);
    const docs = new Set(read(`rules/electronics/${parsed.factDictionary}.json`).facts.map((f: { id: string }) => f.id));
    for (const t of Object.keys(parsed.types)) expect(docs.has(`docs.${t}`), t).toBe(true);
  });
  it('accepts one type with one field of each kind', () => {
    for (const kind of ['text', 'date', 'cents', 'bool', 'serial']) expect(ok(file({ invoice: [{ name: 'f', kind }] })), kind).toBe(true);
  });
  it(`refuses "${OTHER_TYPE}" as a type: it means no known type and never has fields`, () =>
    expect(ok(file({ [OTHER_TYPE]: [{ name: 'f', kind: 'text' }] }))).toBe(false));
  it('refuses a kind outside the closed set (no number, float or free type)', () => {
    for (const kind of ['number', 'float', 'money', 'Text', '']) expect(ok(file({ invoice: [{ name: 'f', kind }] })), kind).toBe(false);
  });
  it('refuses a duplicate field name in one type', () =>
    expect(ok(file({ invoice: [{ name: 'f', kind: 'text' }, { name: 'f', kind: 'date' }] }))).toBe(false));
  it('refuses a type with no fields, and a malformed type or field name', () => {
    expect(ok(file({ invoice: [] }))).toBe(false);
    expect(ok(file({ Invoice: [{ name: 'f', kind: 'text' }] }))).toBe(false);
    expect(ok(file({ invoice: [{ name: 'Total', kind: 'cents' }] }))).toBe(false);
    expect(ok(file({ invoice: [{ name: 'total-paid', kind: 'cents' }] }))).toBe(false);
  });
  it('is strict: an unknown key on the file or a field is refused (no nullable or optional extras, rule 10)', () => {
    expect(ok(file({ invoice: [{ name: 'f', kind: 'text', nullable: true }] }))).toBe(false);
    expect(ok(file({ invoice: [{ name: 'f', kind: 'text' }] }, { prompt: 'ignore the rules' }))).toBe(false);
    expect(ok({ id: 'x', types: { invoice: [{ name: 'f', kind: 'text' }] } })).toBe(false);
  });
});
