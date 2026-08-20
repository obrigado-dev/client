/**
 * npm (`package-lock.json`), all three lockfile versions.
 *
 * v2 and v3 key packages by install path — `node_modules/foo`,
 * `node_modules/foo/node_modules/bar`. That nesting is tempting to use as depth
 * and is wrong: it reflects hoisting, not the dependency graph. A package hoisted
 * to the top level sits at `node_modules/x` however deep it actually is, so path
 * nesting would report almost everything as a direct dependency. Depth comes from
 * walking `dependencies` instead.
 */
import type { DepEntry } from "@obrigado/shared";

import { depthsWithFallback } from "./graph.ts";
import { safeJson, toDeps } from "./types.ts";
import type { LockfileParser, ParserInput } from "./types.ts";

interface PackageEntry {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dev?: boolean;
  link?: boolean;
}

interface PackageLock {
  lockfileVersion?: number;
  /** v1 only. */
  dependencies?: Record<string, PackageEntry & { dependencies?: Record<string, unknown> }>;
  /** v2 and v3. */
  packages?: Record<string, PackageEntry>;
}

/** `node_modules/@scope/name` → `@scope/name`; the root package is "". */
function nameFromPath(path: string): string | null {
  const marker = "node_modules/";
  const last = path.lastIndexOf(marker);
  if (last === -1) return null;
  const name = path.slice(last + marker.length);
  return name.length === 0 ? null : name;
}

function edgesOf(entry: PackageEntry): string[] {
  return [
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
  ];
}

export const npmParser: LockfileParser = {
  ecosystem: "npm",
  lockfile: "package-lock.json",

  parse({ lockfile }: ParserInput): DepEntry[] {
    const lock = safeJson<PackageLock>(lockfile);
    if (lock === null) return [];

    const edges = new Map<string, string[]>();
    const all = new Set<string>();
    let roots: string[] = [];

    // Workspace links are symlinks to sibling packages, not published
    // dependencies anyone can be paid for. Collected first, because the root
    // entry lists them among its dependencies and they would otherwise enter as
    // roots at depth 0 regardless of being skipped later.
    const linked = new Set<string>();
    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
      if (entry.link !== true) continue;
      const name = nameFromPath(path);
      if (name !== null) linked.add(name);
    }

    if (lock.packages !== undefined) {
      // v2 / v3. The "" entry is the project itself, and its dependencies are
      // the only reliable statement of what the developer chose.
      for (const [path, entry] of Object.entries(lock.packages)) {
        if (path === "") {
          roots = edgesOf(entry).filter((name) => !linked.has(name));
          continue;
        }
        // A `link` entry is a workspace symlink, not a published package.
        if (entry.link === true) continue;

        const name = nameFromPath(path);
        if (name === null) continue;
        all.add(name);
        // Several paths can resolve the same name; union their edges so a
        // shallower route is never lost.
        edges.set(name, [
          ...new Set([
            ...(edges.get(name) ?? []),
            ...edgesOf(entry).filter((dep) => !linked.has(dep)),
          ]),
        ]);
      }
    } else if (lock.dependencies !== undefined) {
      // v1 nests resolved trees and does not distinguish direct dependencies at
      // all, so the top level of `dependencies` is the best available answer.
      const walk = (
        tree: Record<string, PackageEntry & { dependencies?: Record<string, unknown> }>,
      ): void => {
        for (const [name, entry] of Object.entries(tree)) {
          all.add(name);
          edges.set(name, [...new Set([...(edges.get(name) ?? []), ...edgesOf(entry)])]);
          const nested = entry.dependencies;
          if (nested !== undefined && typeof nested === "object") {
            walk(nested as Record<string, PackageEntry>);
          }
        }
      };
      roots = Object.keys(lock.dependencies);
      walk(lock.dependencies);
    }

    return toDeps("npm", depthsWithFallback({ roots, edges }, all));
  },
};
