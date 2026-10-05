import { readFileSync } from 'node:fs';
import { adjudicate, ENGINE_SEMANTICS_VERSION } from '@/rules/adjudicate';
import { sha256Hex } from '@/rules/canonical';
import type { Snapshot } from '@/rules/derive';
import { traceSchema, type RuleSet } from '@/rules/schema';
import { selectVersions } from '@/rules/select';
import { checkDictionaryHash, validateDictionary } from '@/rules/validate';

// Writing decisions and proving them (D6, P0-3). Raw SQL on a `pg` client, so the verifier reads exactly what is
// stored, with nothing in between. `recordDecision` is the one writer until the Phase 2 pipeline replaces it.

export type Db = { query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

export const FAILURE_CODES = ['RULESET_HASH_MISMATCH', 'FACTS_HASH_MISMATCH', 'REPLAY_DIVERGED', 'EXPLANATION_INCONSISTENT',
  'VERSION_NOT_EFFECTIVE', 'CHAIN_BROKEN', 'OVERRIDE_INVALID', 'SEMANTICS_UNSUPPORTED'] as const;
export type Failure = { code: (typeof FAILURE_CODES)[number]; id: string; detail: string };

type Version = { id: string; kind: string; product: string; version: number; status: string; effectiveFrom: string; body: RuleSet; contentHash: string | null };
type Row = {
  id: string; claimId: string; planVersionId: string; planHash: string; opsVersionId: string; opsHash: string; asOf: string;
  facts: Snapshot; inputHash: string; outputHash: string; engineSemanticsVersion: string; outcome: string; payableCents: number | null;
  explanation: unknown; supersedesId: string | null; overridesId: string | null; createdAt: Date;
};

export const inputHashOf = (d: Pick<Row, 'asOf' | 'facts' | 'planHash' | 'opsHash'>) =>
  sha256Hex({ asOf: d.asOf, facts: d.facts, planHash: d.planHash, opsHash: d.opsHash });

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const dictFile = (body: RuleSet) => readJson(`rules/${body.product}/${body.factDictionary}.json`);

export async function publishRuleSet(db: Db, body: RuleSet): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO "RuleSetVersion" ("id", "kind", "product", "version", "status", "effectiveFrom", "body", "contentHash", "publishedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, 'published', $4, $5, $6, now()) RETURNING "id"`,
    [body.kind, body.product, body.version, body.effectiveFrom, body, sha256Hex(body)]);
  return rows[0]!.id;
}

const loadVersions = async (db: Db) => new Map((await db.query<Version>(
  `SELECT "id", "kind", "product", "version", "status", "effectiveFrom"::text AS "effectiveFrom", "body", "contentHash" FROM "RuleSetVersion"`,
)).rows.map((v) => [v.id, v]));

export async function recordDecision(db: Db, d: { claimId: string; planVersionId: string; opsVersionId: string; snapshot: Snapshot; asOf: string; supersedesId?: string }) {
  const versions = await loadVersions(db);
  const [plan, ops] = [versions.get(d.planVersionId)!, versions.get(d.opsVersionId)!];
  const { dict } = validateDictionary(dictFile(plan.body));
  const trace = adjudicate({ plan: plan.body, ops: ops.body, dict: dict!, snapshot: d.snapshot, asOf: d.asOf });
  const row = { asOf: d.asOf, facts: d.snapshot, planHash: plan.contentHash!, opsHash: ops.contentHash! };
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO "Decision" ("id", "claimId", "planVersionId", "planHash", "opsVersionId", "opsHash", "asOf", "facts", "inputHash", "outputHash",
       "engineSemanticsVersion", "outcome", "payableCents", "explanation", "supersedesId")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING "id"`,
    [d.claimId, d.planVersionId, row.planHash, d.opsVersionId, row.opsHash, d.asOf, JSON.stringify(d.snapshot), inputHashOf(row), sha256Hex(trace),
      ENGINE_SEMANTICS_VERSION, trace.decision.outcome, trace.decision.payableCents, trace, d.supersedesId ?? null]);
  return rows[0]!.id;
}

/** Replays every stored decision (with `asOf` on or before `until`, when given) from what it pinned. */
export async function verifyDecisions(db: Db, until?: string): Promise<{ checked: number; failures: Failure[] }> {
  const versions = await loadVersions(db);
  const all = (await db.query<Row>(
    `SELECT *, "asOf"::text AS "asOf" FROM "Decision" ORDER BY "createdAt", "id"`,
  )).rows;
  const decisions = until ? all.filter((d) => d.asOf <= until) : all;
  const byId = new Map(all.map((d) => [d.id, d]));
  const failures: Failure[] = [];
  const fail = (code: Failure['code'], id: string, detail: string) => failures.push({ code, id, detail });

  // A rule set is intact when its body still hashes to the published hash and its dictionary to the pinned one.
  const intact = new Map([...versions.values()].map((v) => [v.id,
    v.contentHash !== null && sha256Hex(v.body) === v.contentHash && checkDictionaryHash(v.body, dictFile(v.body)).length === 0]));

  for (const d of decisions) {
    const [plan, ops] = [versions.get(d.planVersionId)!, versions.get(d.opsVersionId)!];
    if (d.engineSemanticsVersion !== ENGINE_SEMANTICS_VERSION) {
      fail('SEMANTICS_UNSUPPORTED', d.id, `${d.engineSemanticsVersion}; this engine replays ${ENGINE_SEMANTICS_VERSION}`);
      continue; // nothing below can be interpreted under semantics this engine does not have
    }

    let inputsOk = true;
    for (const [v, pinned] of [[plan, d.planHash], [ops, d.opsHash]] as const)
      if (!intact.get(v.id) || pinned !== v.contentHash) { inputsOk = false; fail('RULESET_HASH_MISMATCH', d.id, `${v.kind}-v${v.version} (${v.id})`); }
    if (inputHashOf(d) !== d.inputHash) { inputsOk = false; fail('FACTS_HASH_MISMATCH', d.id, 'facts, asOf or pins do not hash to inputHash'); }

    // The stored row must agree with itself. An override's outcome is a person's, so only its trace is checked.
    const t = traceSchema.safeParse(d.explanation);
    const e = t.success ? t.data : null;
    if (!e || sha256Hex(d.explanation) !== d.outputHash || e.asOf !== d.asOf
      || (!d.overridesId && (e.decision.outcome !== d.outcome || e.decision.payableCents !== d.payableCents)))
      fail('EXPLANATION_INCONSISTENT', d.id, e ? 'explanation, outputHash and outcome columns disagree' : 'explanation is not a trace');

    // Replay only from verified inputs: with a tampered input the replay would diverge too, and hide the cause.
    if (inputsOk) {
      const { dict } = validateDictionary(dictFile(plan.body));
      const replay = adjudicate({ plan: plan.body, ops: ops.body, dict: dict!, snapshot: d.facts, asOf: d.asOf });
      if (sha256Hex(replay) !== d.outputHash) fail('REPLAY_DIVERGED', d.id, `replay gives ${replay.decision.outcome} ${replay.decision.payableCents}`);
    }

    // D3: the plan was in force, and the ops set is the latest one effective on the adjudication date.
    const selected = selectVersions({ planVersion: plan.id },
      [...versions.values()].filter((v) => v.product === ops.product).map((v) => ({ ...v, name: v.id })), d.asOf);
    if ('error' in selected || selected.ops.id !== ops.id)
      fail('VERSION_NOT_EFFECTIVE', d.id, `asOf ${d.asOf}: plan from ${plan.effectiveFrom}, ops pinned ${ops.id}, effective ${'error' in selected ? `none (${selected.kind})` : selected.ops.id}`);

    if (d.overridesId) {
      // D18: an override sits beside the engine decision it overrides and preserves that decision's result.
      const target = byId.get(d.overridesId);
      if (!target || target.overridesId || target.claimId !== d.claimId || target.inputHash !== d.inputHash || target.outputHash !== d.outputHash || d.supersedesId)
        fail('OVERRIDE_INVALID', d.id, `overrides ${d.overridesId}`);
    } else if (d.supersedesId) {
      // D13: same claim, same plan version, later, and on changed facts (an unchanged inputHash is a no-op).
      const prev = byId.get(d.supersedesId);
      if (!prev || prev.overridesId || prev.claimId !== d.claimId || prev.planVersionId !== d.planVersionId || prev.inputHash === d.inputHash || prev.createdAt > d.createdAt)
        fail('CHAIN_BROKEN', d.id, `supersedes ${d.supersedesId}`);
    }
  }

  // Each claim's engine decisions form one chain: exactly one has no predecessor.
  const roots = new Map<string, string[]>();
  for (const d of decisions) if (!d.overridesId && !d.supersedesId) roots.set(d.claimId, [...(roots.get(d.claimId) ?? []), d.id]);
  for (const [claimId, ids] of roots) if (ids.length > 1) fail('CHAIN_BROKEN', ids[1]!, `claim ${claimId} has ${ids.length} unchained decisions`);

  return { checked: decisions.length, failures };
}
