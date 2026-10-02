import { createHash } from 'node:crypto';

// D5: the one canonical-JSON serializer. Everything hashed goes through here.
// Sorted keys, arrays in order, safe integers only. Dates arrive as ISO strings already (the schemas enforce it).
// Anything else (float, NaN, undefined, Date, Map, bigint) throws: a value that cannot round-trip cannot be hashed.

export function canonicalJson(value: unknown, path = '$'): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`canonicalJson: ${path} is ${value}, not a safe integer`);
    return String(value === 0 ? 0 : value); // -0 → 0
  }
  if (Array.isArray(value)) return `[${value.map((v, i) => canonicalJson(v, `${path}[${i}]`)).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], `${path}.${k}`)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: ${path} is ${typeof value === 'object' ? Object.prototype.toString.call(value) : typeof value}, not JSON data`);
}

export const sha256Hex = (value: unknown) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
