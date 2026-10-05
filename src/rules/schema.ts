import { z } from 'zod';

// The closed vocabulary (D1, D17). Anything outside these lists must fail validation; extending one needs a
// docs/decisions.md entry and a fixture (CLAUDE.md working rules). Structure only: cross-references live in validate.ts.

export const OPERATORS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in', 'between', 'is_known'] as const;
export const CALC_STEPS = ['start_from', 'subtract', 'apply_bps', 'cap_at', 'floor_at', 'min_of'] as const;
export const DERIVED_FNS = ['days_between', 'full_years_between', 'ratio_bps', 'ratio_exceeds_bps', 'count_claims_in_window', 'sum_prior_paid'] as const;
export const FACT_TYPES = ['bool', 'int', 'cents', 'bps', 'date', 'string', 'enum', 'list'] as const;
export const FACT_SOURCES = ['input', 'derived', 'lookup', 'calc'] as const;
// Fixed stage order (D12). Stage logic is data; the order is code.
export const STAGES = ['intake', 'contract_verification', 'coverage_period', 'peril_exclusions', 'frequency_limits', 'evidence', 'red_flags', 'valuation', 'deductible_limits', 'authority', 'decision'] as const;
export const OUTCOMES = ['PASS', 'DENY', 'REFER', 'PEND'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const scalar = z.union([z.string(), z.number().int(), z.boolean()]); // .int(): floats never enter rule data (D16)

// ---- fact dictionary
export const factSchema = z.object({
  id: z.string().regex(/^[a-z][A-Za-z0-9]*\.[A-Za-z0-9]+$/),
  type: z.enum(FACT_TYPES),
  source: z.enum(FACT_SOURCES),
  description: z.string().optional(),
  values: z.array(z.string()).min(1).optional(), // enum members
  planIdentifier: z.boolean().optional(), // rules:lint greps src/ for this fact's enum values
  fn: z.enum(DERIVED_FNS).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  itemFields: z.record(z.string(), z.string()).optional(), // list facts
}).strict();
export const dictionarySchema = z.object({
  schema: z.literal('adjuster.facts/1'), id: z.string(), product: z.string(), facts: z.array(factSchema).min(1),
}).strict();

// ---- decision tables
export const cellSchema = z.object({
  fact: z.string(), op: z.enum(OPERATORS), value: z.union([scalar, z.array(scalar)]).optional(),
}).strict();

const thenSchema = z.object({
  outcome: z.enum(OUTCOMES),
  reasonCode: z.string().optional(), clause: z.string().optional(),
  params: z.record(z.string(), scalar).optional(), bind: z.record(z.string(), z.string()).optional(),
  claimantText: z.string().optional(), claimantVisible: z.boolean().optional(), noteText: z.string().optional(),
}).strict();
export const rowSchema = z.object({ id: z.string(), when: z.array(cellSchema), then: thenSchema }).strict();
export const ruleSchema = z.object({
  id: z.string().regex(/^[EF]\d+(\.[A-Za-z]+)?$/),
  name: z.string(), class: z.enum(['C', 'O']), stage: z.enum(STAGES), kind: z.enum(['eligibility', 'flag']),
  rows: z.array(rowSchema).min(1), note: z.string().optional(),
}).strict();
export const lookupSchema = z.object({
  id: z.string(), hitPolicy: z.literal('unique'), note: z.string().optional(),
  rows: z.array(z.object({ id: z.string(), when: z.array(cellSchema), value: scalar }).strict()).min(1),
}).strict();

// ---- calc steps (D1): an ordered list over named registers; `when` guards pick the repair or replace branch
export const operandSchema = z.union([
  z.object({ fact: z.string() }).strict(), z.object({ const: z.number().int() }).strict(), z.object({ reg: z.string() }).strict(),
]);
export const stepSchema = z.object({
  id: z.string(), op: z.enum(CALC_STEPS), reg: z.string().optional(),
  operand: operandSchema.optional(), operands: z.array(operandSchema).min(2).optional(),
  when: z.array(cellSchema).optional(), label: z.string().optional(),
}).strict();
export const payoutSchema = z.object({ steps: z.array(stepSchema).min(1), outputs: z.record(z.string(), z.string()) }).strict();

// ---- rule-set envelope. Status and hash are not in the file: they belong to the DB row (D2, task 1.10).
export const ruleSetSchema = z.object({
  schema: z.literal('adjuster.ruleset/1'), kind: z.enum(['plan', 'ops']), product: z.string(), version: z.number().int().min(1),
  effectiveFrom: isoDate, factDictionary: z.string(),
  // D28: sha256Hex of the dictionary file. Optional here so validate-only fixtures stay minimal; checkDictionaryHash requires it at publish.
  factDictionaryHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  roundingMode: z.literal('half_up'),
  rules: z.array(ruleSchema).min(1),
  lookups: z.array(lookupSchema).optional(), payout: payoutSchema.optional(),
  fulfillment: z.array(z.object({ id: z.string(), when: z.array(cellSchema) }).strict()).optional(),
  authority: z.array(z.object({ code: z.string(), approveUpToCents: z.number().int().nullable(), powers: z.array(z.string()) }).strict()).optional(),
  reminders: z.object({ firstDay: z.number().int(), secondDay: z.number().int(), closeDay: z.number().int() }).strict().optional(),
  outcomePolicy: z.object({ autoDenyEnabled: z.boolean() }).strict().optional(),
}).strict();

// ---- trace v1 (D34): self-contained. v0 was confirmed against docs/trace-by-hand.md (D32: every rule stored; letters
// show non-PASS only); v1 adds each deciding row's resolved placeholders (`vars`) and visibility, and hashed versions,
// so a letter and note render from the stored trace alone.
const factsRead = z.record(z.string(), z.union([scalar, z.null()]));
export const ruleResultSchema = z.object({
  ruleId: z.string(), stage: z.enum(STAGES), result: z.enum(['PASS', 'DENY', 'REFER', 'PEND', 'GAP']),
  rowIds: z.array(z.string()), reasonCode: z.string().nullable(), clause: z.string().nullable(),
  factsRead, missing: z.array(z.string()), claimantText: z.string().nullable(), noteText: z.string().nullable(),
  claimantVisible: z.boolean(), vars: factsRead,
}).strict();
const versionRef = z.object({ name: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), effectiveFrom: isoDate }).strict();
export const calcStepTraceSchema = z.object({
  id: z.string(), op: z.enum(CALC_STEPS), reg: z.string(), applied: z.boolean(),
  operand: z.union([z.object({ kind: z.enum(['fact', 'const', 'reg']), name: z.string().nullable(), value: z.number().int() }).strict(), z.null()]),
  inputCents: z.number().int().nullable(), outputCents: z.number().int().nullable(),
}).strict();
export const traceSchema = z.object({
  schema: z.literal('adjuster.trace/1'), asOf: isoDate,
  // How each version was chosen (D35). The engine states the rule; `selectVersions` applies it and verify re-checks it.
  versions: z.object({
    plan: versionRef.extend({ selectedBy: z.literal('contract_pin') }).strict(),
    ops: versionRef.extend({ selectedBy: z.literal('latest_effective_on_asOf') }).strict(),
  }).strict(),
  skipped: z.array(z.enum(STAGES)),
  rules: z.array(ruleResultSchema),
  // `labels`: each step's label as the plan had it at decision time, by step id (D42). The letter's amount lines read these.
  // `outputs`: which register holds each amount, as the plan had it (D43). Without it the steps do not say which one is paid.
  valuation: z.object({ path: z.enum(['repair', 'replace']), steps: z.array(calcStepTraceSchema), labels: z.record(z.string(), z.string()), outputs: z.record(z.string(), z.string()) }).strict().nullable(),
  decision: z.object({
    outcome: z.enum(['APPROVE', 'PARTIAL', 'DENY', 'REFER', 'PEND']),
    reasons: z.array(z.string()), payableCents: z.number().int().nullable(), contractFulfilled: z.boolean().nullable(),
  }).strict(),
}).strict();

export type RuleSet = z.infer<typeof ruleSetSchema>;
export type Dictionary = z.infer<typeof dictionarySchema>;
export type Cell = z.infer<typeof cellSchema>;
