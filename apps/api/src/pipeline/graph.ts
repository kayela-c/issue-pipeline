/**
 * Dependency graph helpers. Nodes are opaque ids; an edge `[a, b]` means
 * "a depends on b".
 */

/** A cycle as a list of node ids (first id repeated at the end), or undefined. */
export function findCycle<T>(nodes: Iterable<T>, edges: Iterable<readonly [T, T]>): T[] | undefined {
  const adjacency = new Map<T, T[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const [from, to] of edges) {
    if (!adjacency.has(from)) adjacency.set(from, []);
    if (!adjacency.has(to)) adjacency.set(to, []);
    adjacency.get(from)!.push(to);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<T, number>();
  const stack: T[] = [];

  const visit = (node: T): T[] | undefined => {
    color.set(node, GREY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (c === WHITE) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return undefined;
  };

  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return undefined;
}
