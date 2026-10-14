import { db } from '@/core/db';

// Author and publisher ids carry no foreign key (D76 g), so an id with no user row is shown as itself.
// A null author is a version the seed loaded from a file under rules/.
export async function namesOf(ids: (string | null)[]) {
  const users = await db.user.findMany({ where: { id: { in: ids.filter((i): i is string => !!i) } }, select: { id: true, name: true, email: true } });
  const by = new Map(users.map((u) => [u.id, u.name ?? u.email]));
  return (id: string | null) => (id ? (by.get(id) ?? id) : 'file');
}
