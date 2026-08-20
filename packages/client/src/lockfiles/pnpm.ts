/**
 * pnpm (`pnpm-lock.yaml`).
 *
 * v9 splits what earlier versions combined: `packages` holds resolution metadata
 * and `snapshots` holds the dependency graph. v6 and earlier put dependencies
 * inside `packages`. Both are read, because a developer's lockfile version is
 * not ours to choose.
 *
 * Roots come from `importers`, which names every workspace's direct dependencies
 * — the one part of the file that records what a human actually chose.
 */
import type { DepEntry } from "@obrigado/shared";

import { depthsWithFallback } from "./graph.ts";
import { safeYaml, toDeps } from "./types.ts";
import type { LockfileParser, ParserInput } from "./types.ts";

interface Importer {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

interface Snapshot {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PnpmLock {
  importers?: Record<string, Importer>;
  packages?: Record<string, Snapshot>;
  snapshots?: Record<string, Snapshot>;
  /** v5 and earlier put direct dependencies at the top level. */
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/**
 * `@scope/name@1.2.3(peer@4)` → `@scope/name`.
 *
 * The version separator is the LAST `@` that is not the leading one of a scope,
 * and pnpm appends peer-resolution suffixes in parentheses that must go first.
 */
export function packageName(key: string): string {
  const withoutPeers = key.replace(/\(.*\)$/u, "");
  const at = withoutPeers.lastIndexOf("@");
  if (at <= 0) return withoutPeers;
  return withoutPeers.slice(0, at);
}

export const pnpmParser: LockfileParser = {
  ecosystem: "npm",
  lockfile: "pnpm-lock.yaml",

  parse({ lockfile }: ParserInput): DepEntry[] {
    const lock = safeYaml<PnpmLock>(lockfile);
    if (lock === null) return [];

    const roots = new Set<string>();
    for (const importer of Object.values(lock.importers ?? {})) {
      for (const group of [
        importer.dependencies,
        importer.devDependencies,
        importer.optionalDependencies,
      ]) {
        for (const name of Object.keys(group ?? {})) roots.add(name);
      }
    }
    // v5 and earlier.
    for (const group of [lock.dependencies, lock.devDependencies]) {
      for (const name of Object.keys(group ?? {})) roots.add(name);
    }

    const edges = new Map<string, string[]>();
    const all = new Set<string>();

    // snapshots (v9) or packages (v6 and earlier) — whichever carries edges.
    for (const source of [lock.snapshots, lock.packages]) {
      for (const [key, snapshot] of Object.entries(source ?? {})) {
        const name = packageName(key);
        if (name.length === 0) continue;
        all.add(name);

        const children = [
          ...Object.keys(snapshot.dependencies ?? {}),
          ...Object.keys(snapshot.optionalDependencies ?? {}),
        ];
        if (children.length > 0) {
          edges.set(name, [...new Set([...(edges.get(name) ?? []), ...children])]);
        }
      }
    }

    return toDeps("npm", depthsWithFallback({ roots: [...roots], edges }, all));
  },
};
