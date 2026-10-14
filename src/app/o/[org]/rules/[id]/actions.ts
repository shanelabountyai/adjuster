'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { notRef, orgAction } from '@/core/authz/action';
import type { OrgCtx } from '@/core/authz/guards';
import { db } from '@/core/db';
import { dictFile } from '@/adjudication/decisions';
import { OutOfAuthorityError } from '@/adjudication/documents';
import { createDraft, DraftError, saveDraft } from '@/adjudication/drafts';
import { pool } from '@/adjudication/pool';
import { ruleSetSchema } from '@/rules/schema';
import { validateDictionary } from '@/rules/validate';
import { applyForm } from './form';

// Task 4.10. Rule sets are global (D73), so the id is notRef: there is no org to scope it to, and the harness drives
// these for INV-01 and INV-22 only. The power to author is the service's to check (D66); its refusal is returned for
// ActionForm to show. A save redirects back with saveDraft's issues on the URL, and the page shows only those (D88).

const today = () => new Date().toISOString().slice(0, 10);
const page = (ctx: OrgCtx, id: string) => `/o/${ctx.slug}/rules/${id}`;
const refused = (e: unknown) => e instanceof DraftError || e instanceof OutOfAuthorityError;

export const saveRuleDraft = orgAction(null, z.looseObject({ id: notRef(z.uuid()) }), async (ctx, { id, ...fields }) => {
  const v = await db.ruleSetVersion.findUnique({ where: { id } });
  const stored = v?.status === 'draft' ? ruleSetSchema.safeParse(v.body) : null;
  if (!stored?.success) return { error: 'Only a draft that parses can be edited here.' };
  const body = applyForm(stored.data, validateDictionary(dictFile(stored.data)).dict!, fields);
  let issues;
  try {
    issues = await saveDraft(pool, { id, userId: ctx.userId, body, asOf: today() });
  } catch (e) {
    if (refused(e)) return { error: (e as Error).message };
    throw e;
  }
  redirect(`${page(ctx, id)}?issues=${Buffer.from(JSON.stringify(issues)).toString('base64url')}`);
});

export const startDraft = orgAction(null, z.object({ id: notRef(z.uuid()) }), async (ctx, { id }) => {
  const v = await db.ruleSetVersion.findUnique({ where: { id } });
  if (!v || v.status === 'draft') return { error: 'Start a draft from a published version.' };
  let draft;
  try {
    draft = await createDraft(pool, { kind: v.kind as 'plan' | 'ops', product: v.product, userId: ctx.userId, asOf: today() });
  } catch (e) {
    if (refused(e)) return { error: (e as Error).message };
    throw e;
  }
  redirect(page(ctx, draft));
});
