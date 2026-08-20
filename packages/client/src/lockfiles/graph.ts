/**
 * Depth from a dependency graph.
 *
 * §10.3 stores depth and weights settlement by `1/(1+depth)`, so depth decides
 * money: a package one level deeper earns half as much from the same session.
 * That makes two properties non-negotiable.
 *
 * **Shallowest wins.** A package reachable both directly and transitively is a
 * direct dependency. Anything else would let an unrelated deep path demote a
 * package the developer actually chose.
 *
 * **Breadth-first, not depth-first.** BFS reaches every node by its shortest
 * path, which is the definition of depth here. A DFS would assign whatever depth
 * it happened to arrive by, making payouts depend on traversal order — a bug
 * that would look like nothing at all in a test with one path per package.
 */

/** Maximum depth to walk. Beyond this a package's weight is a rounding error. */
export const MAX_DEPTH = 12;

export interface DependencyGraph {
  /** Direct dependencies — depth 0. */
  readonly roots: readonly string[];
  /** name → the names it depends on. */
  readonly edges: ReadonlyMap<string, readonly string[]>;
}

/**
 * Shortest-path depth for every reachable node.
 *
 * Cycles are common in real lockfiles and are handled by the visited set rather
 * than a depth cap, so a cycle costs nothing and does not silently truncate the
 * graph.
 */
export function computeDepths(graph: DependencyGraph): Map<string, number> {
  const depths = new Map<string, number>();
  let frontier = [...new Set(graph.roots)];
  let depth = 0;

  for (const name of frontier) depths.set(name, 0);

  while (frontier.length > 0 && depth < MAX_DEPTH) {
    depth += 1;
    const next: string[] = [];

    for (const name of frontier) {
      for (const child of graph.edges.get(name) ?? []) {
        if (depths.has(child)) continue;
        depths.set(child, depth);
        next.push(child);
      }
    }
    frontier = next;
  }

  return depths;
}

/**
 * Everything in the lockfile, including packages the graph does not reach.
 *
 * An unreachable entry is usually an optional or platform-specific dependency
 * whose edge we could not follow. Dropping it would silently deny a real
 * dependency its allocation, so it is included at `fallbackDepth` — deliberately
 * deep, because we could not prove it is shallow.
 */
export function depthsWithFallback(
  graph: DependencyGraph,
  allNames: Iterable<string>,
  fallbackDepth = 1,
): Map<string, number> {
  const depths = computeDepths(graph);
  for (const name of allNames) {
    if (!depths.has(name)) depths.set(name, fallbackDepth);
  }
  return depths;
}
