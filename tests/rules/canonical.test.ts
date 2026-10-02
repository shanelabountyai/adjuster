import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@/rules/canonical';
import { checkDictionaryHash } from '@/rules/validate';

// Phase 1 task 1.6 (D5, D28): shuffled key order gives identical bytes and hash; floats and non-JSON values are rejected.
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

// Deterministic Fisher-Yates on keys at every level (seeded LCG: tests stay reproducible).
function shuffled(v: unknown, seed = { s: 7 }): unknown {
  if (Array.isArray(v)) return v.map((x) => shuffled(x, seed));
  if (v === null || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  for (let i = keys.length - 1; i > 0; i--) {
    seed.s = (seed.s * 1103515245 + 12345) % 2147483648;
    const j = seed.s % (i + 1);
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  }
  return Object.fromEntries(keys.map((k) => [k, shuffled((v as Record<string, unknown>)[k], seed)]));
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  for (const p of ['rules/electronics/plan-v1.json', 'rules/electronics/ops-v1.json', 'rules/electronics/facts-v1.json', 'fixtures/gc/GC-08.json']) {
    it(`${p}: shuffled key order gives identical bytes and hash`, () => {
      const doc = json(p);
      const mixed = shuffled(doc);
      expect(JSON.stringify(mixed)).not.toBe(JSON.stringify(doc)); // the shuffle actually moved something
      expect(canonicalJson(mixed)).toBe(canonicalJson(doc));
      expect(sha256Hex(mixed)).toBe(sha256Hex(doc));
    });
  }

  it('escapes strings the JSON way and normalises -0', () => {
    expect(canonicalJson({ s: 'a"\né', z: -0 })).toBe('{"s":"a\\"\\né","z":0}');
  });

  it.each([
    ['a float', { x: 79.5 }, '$.x'],
    ['NaN', [NaN], '$[0]'],
    ['Infinity', { x: Infinity }, '$.x'],
    ['an unsafe integer', { x: 2 ** 53 }, '$.x'],
    ['undefined', { x: undefined }, '$.x'],
    ['a Date object', { x: new Date(0) }, '$.x'],
    ['a Map', { x: new Map() }, '$.x'],
    ['a bigint', { x: 1n }, '$.x'],
  ])('rejects %s, naming the path', (_, v, path) => expect(() => canonicalJson(v)).toThrow(path));

  it('hash is sha256 hex of the canonical bytes', () => expect(sha256Hex({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'));
});

describe('D28: rule sets pin their fact dictionary hash', () => {
  const dict = json('rules/electronics/facts-v1.json');
  it('plan-v1 and ops-v1 match the dictionary', () => {
    expect(checkDictionaryHash(json('rules/electronics/plan-v1.json'), dict)).toEqual([]);
    expect(checkDictionaryHash(json('rules/electronics/ops-v1.json'), dict)).toEqual([]);
  });
  it('an edited dictionary no longer matches', () => {
    const edited = { ...dict, facts: dict.facts.slice(1) };
    expect(checkDictionaryHash(json('rules/electronics/plan-v1.json'), edited).map((i) => i.code)).toEqual(['DICTIONARY_HASH']);
  });
  it('a missing hash fails', () => expect(checkDictionaryHash({}, dict).map((i) => i.code)).toEqual(['DICTIONARY_HASH']));
});
