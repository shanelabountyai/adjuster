import { z } from 'zod';

// Extraction schemas are data under intake/<product>/ (D90 H, D91 a). Structure only here; that each type is a
// document the product's fact dictionary declares (docs.<type>) is checked by rules:lint.

export const FIELD_KINDS = ['text', 'date', 'cents', 'bool', 'serial'] as const;
export const OTHER_TYPE = 'other'; // classifies as no known type; never has fields

const field = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/), kind: z.enum(FIELD_KINDS) }).strict();

export const intakeSchemaFile = z
  .object({
    id: z.string().min(1),
    factDictionary: z.string().min(1),
    types: z.record(
      z.string().regex(/^[a-z][A-Za-z0-9]*$/).refine((t) => t !== OTHER_TYPE, `"${OTHER_TYPE}" is reserved`),
      z.array(field).min(1).refine((fs) => new Set(fs.map((f) => f.name)).size === fs.length, 'duplicate field name'),
    ),
  })
  .strict();

export type IntakeSchemaFile = z.infer<typeof intakeSchemaFile>;
export type FieldKind = (typeof FIELD_KINDS)[number];
