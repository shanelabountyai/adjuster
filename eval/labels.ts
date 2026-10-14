import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@/rules/canonical';
import { intakeSchemaFile, OTHER_TYPE, type FieldKind, type IntakeSchemaFile } from '@/intake/schema';

// Eval labels (D91 d). A draft label is the generator's claim about a file; it becomes a label only when a person
// signs it in eval:signoff. The signature binds the file's bytes and the field values, so a regenerated file, a
// swapped photo or a hand edit after signing all read as unsigned. loadSignedLabels is the only reader downstream.

export const EVAL_DIR = 'eval';
export const LABEL_DIR = join(EVAL_DIR, 'labels');
export const SCHEMA_PATH = join('intake', 'electronics', 'schemas-v1.json');

export type FieldValue = string | number | boolean;
/** The true value, as code would normalize it, plus the characters printed (absent for booleans). */
export type FieldLabel = { value: FieldValue; raw?: string } | 'absent';
export type Kind = 'clean' | 'rotated' | 'lowres' | 'stain' | 'adversarial' | 'real_photo';
export type Signature = { by: string; at: string; fileSha256: string; fieldsSha256: string };
export type Label = {
  id: string;
  type: string; // a schema type or "other"
  kind: Kind;
  note?: string; // what makes an adversarial file adversarial
  file: string; // relative to eval/
  schema: string;
  fields: Record<string, FieldLabel>;
  signed: Signature | null;
};

export const fileSha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export const loadSchema = (): IntakeSchemaFile => intakeSchemaFile.parse(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
export const readLabel = (id: string): Label => JSON.parse(readFileSync(join(LABEL_DIR, `${id}.json`), 'utf8'));
export const labelIds = () => readdirSync(LABEL_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

const KIND_CHECK: Record<FieldKind, (v: FieldValue) => boolean> = {
  text: (v) => typeof v === 'string' && v.length > 0,
  serial: (v) => typeof v === 'string' && /^[A-Z0-9]+$/.test(v),
  date: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)),
  cents: (v) => Number.isSafeInteger(v) && (v as number) >= 0,
  bool: (v) => typeof v === 'boolean',
};

/** Field-shape problems, empty when the label matches its schema. Used by sign-off before it signs and by the loader. */
export function shapeProblems(label: Label, schema: IntakeSchemaFile): string[] {
  if (label.schema !== schema.id) return [`schema ${label.schema}, expected ${schema.id}`];
  const fields = label.type === OTHER_TYPE ? [] : schema.types[label.type];
  if (!fields) return [`unknown type ${label.type}`];
  const problems: string[] = [];
  const names = new Set(fields.map((f) => f.name));
  for (const k of Object.keys(label.fields)) if (!names.has(k)) problems.push(`${k}: not in the ${label.type} schema`);
  for (const f of fields) {
    const l = label.fields[f.name];
    if (l === undefined) problems.push(`${f.name}: missing (use "absent")`);
    else if (l !== 'absent' && !KIND_CHECK[f.kind](l.value)) problems.push(`${f.name}: ${JSON.stringify(l.value)} is not a ${f.kind}`);
  }
  return problems;
}

/** Why a label cannot be used, or null when it is signed and still matches its file and fields. */
export function unsignedReason(label: Label, schema: IntakeSchemaFile): string | null {
  if (!label.signed) return 'not signed';
  const path = join(EVAL_DIR, label.file);
  if (!existsSync(path)) return `file ${label.file} missing`;
  if (fileSha256(path) !== label.signed.fileSha256) return 'file changed since signing';
  if (sha256Hex(label.fields) !== label.signed.fieldsSha256) return 'fields changed since signing';
  const shape = shapeProblems(label, schema);
  return shape.length ? shape.join('; ') : null;
}

/** Every label, signed and intact, or a throw naming each one that is not. Nothing downstream reads labels any other way. */
export function loadSignedLabels(ids: string[] = labelIds()): Label[] {
  const schema = loadSchema();
  const labels = ids.map(readLabel);
  const bad = labels.map((l) => [l.id, unsignedReason(l, schema)] as const).filter(([, r]) => r);
  if (bad.length) throw new Error(`${bad.length} label(s) unusable:\n${bad.map(([id, r]) => `  ${id}: ${r}`).join('\n')}`);
  return labels;
}

export const sign = (label: Label, by: string, at: string): Label => ({
  ...label,
  signed: { by, at, fileSha256: fileSha256(join(EVAL_DIR, label.file)), fieldsSha256: sha256Hex(label.fields) },
});
