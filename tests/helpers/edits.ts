// The draft an AU or ID fixture describes: its `base` rule file with its `edits` applied (fixtures/README.md).
// A string step into a list names the element with that id (a tier by its code); a number is a position.
type Edit = { path: (string | number)[]; value?: unknown; remove?: boolean };
type Node = Record<string | number, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function applyEdits<T>(base: T, edits: Edit[]): T {
  const out = structuredClone(base);
  for (const e of edits) {
    let node = out as Node;
    e.path.forEach((step, i) => {
      const k = Array.isArray(node) && typeof step === 'string' ? node.findIndex((x) => x.id === step || x.code === step) : step;
      if (k === -1 || !(k in node) && i < e.path.length - 1) throw new Error(`edit path does not resolve at ${String(step)}: ${e.path.join('/')}`);
      if (i < e.path.length - 1) node = node[k];
      else if (e.remove) delete node[k];
      else node[k] = e.value;
    });
  }
  return out;
}
