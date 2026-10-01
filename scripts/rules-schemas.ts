import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { dictionarySchema, ruleSetSchema, traceSchema } from '@/rules/schema';

// Emits the JSON Schema files from the zod definitions (zod is already a dependency; no ajv needed).
mkdirSync('schemas', { recursive: true });
for (const [name, s] of [['fact-dictionary', dictionarySchema], ['rule-set', ruleSetSchema], ['trace', traceSchema]] as const)
  writeFileSync(`schemas/${name}.schema.json`, JSON.stringify(z.toJSONSchema(s), null, 2) + '\n');
console.log('schemas/ written');
