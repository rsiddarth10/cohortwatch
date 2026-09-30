/**
 * Union-find over campaign ids (reference plan §9.8), persisted as `merged_into`. Path compression makes each
 * operation amortised O(α(n)). The root is chosen deterministically (the older group; ties by id), so a replay
 * merges the same way. Only groups of the SAME family key are ever unioned (different depots never merge).
 */
export type Parents = Record<string, string>;

export function find(parents: Parents, id: string): string {
  let root = id;
  while (parents[root] !== undefined && parents[root] !== root) root = parents[root]!;
  let c = id;
  while (parents[c] !== undefined && parents[c] !== root) {
    const next = parents[c]!;
    parents[c] = root;
    c = next;
  }
  return root;
}

/** Union a and b; `older(x, y)` says whether x should stay root. Returns the root. */
export function union(parents: Parents, a: string, b: string, older: (x: string, y: string) => boolean): string {
  const ra = find(parents, a);
  const rb = find(parents, b);
  if (ra === rb) return ra;
  const [root, child] = older(ra, rb) ? [ra, rb] : [rb, ra];
  parents[child] = root;
  parents[root] ??= root;
  return root;
}
