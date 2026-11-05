/** An org as the template's org lists show it. `id` is what a clone's filter keys on (an archive table, say). */
export type ListedOrg = { readonly id: string; readonly slug: string; readonly name: string };

/** The clone's `filterListedOrgs` (clone-owned `src/app/org-hooks.ts`): which of `orgs` a list may show. */
export type OrgListFilter = (userId: string, orgs: readonly ListedOrg[]) => Promise<readonly { id: string }[]> | readonly { id: string }[];

/**
 * Every template page that lists a user's orgs (`/onboarding`, `/demo`) passes them through here.
 * The filter can only take orgs away: the result is `items`, in their order and unchanged, restricted to the
 * ids the filter returned. An org it adds, a duplicate, or a field it rewrites never reaches the page, and it is
 * handed frozen copies, so it cannot edit what the page renders either. Display only: hiding an org here does not
 * stop its members opening `/o/<slug>`; a clone gates its own pages.
 */
export async function keepListedOrgs<T extends { org: ListedOrg }>(userId: string, items: readonly T[], filter: OrgListFilter): Promise<T[]> {
  if (items.length === 0) return [];
  const offered = Object.freeze(items.map((i) => Object.freeze({ id: i.org.id, slug: i.org.slug, name: i.org.name })));
  const kept = new Set((await filter(userId, offered)).map((o) => o.id));
  return items.filter((i) => kept.has(i.org.id));
}
