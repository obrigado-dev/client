/**
 * Bun (`bun.lock`).
 *
 * JSONC — trailing commas are normal — with two sections that matter:
 *
 *   "workspaces": { "": { devDependencies: {...} }, "packages/client": {...} }
 *   "packages":   { "name": ["name@version", "", { dependencies: {...} }, "sha..."] }
 *
 * Every workspace's own dependencies are roots. In a monorepo that is the honest
 * answer: a developer working in the repo depends on all of it, and picking one
 * workspace would mean guessing which directory they meant from a lockfile that
 * does not say.
 *
 * Workspace packages themselves are excluded — `@obrigado/shared` is not a
 * published dependency anyone can be paid for.
 */
import type { DepEntry } from "@obrigado/shared";

import { depthsWithFallback } from "./graph.ts";
import { toDeps } from "./types.ts";
import type { LockfileParser, ParserInput } from "./types.ts";

interface WorkspaceEntry {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface BunLock {
  workspaces?: Record<string, WorkspaceEntry>;
  packages?: Record<string, unknown[]>;
}

/**
 * Strip trailing commas so `JSON.parse` accepts bun's JSONC.
 *
 * Deliberately narrow: only `,` followed by whitespace and a closing brace or
 * bracket. A general JSONC parser would also have to handle comments, and the
 * format does not use them — a wider transform would risk mangling a version
 * string that happens to contain a brace.
 */
function stripTrailingCommas(text: string): string {
  return text.replaceAll(/,(\s*[}\]])/gu, "$1");
}

function depsOf(entry: WorkspaceEntry): string[] {
  return [
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.devDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
  ];
}

export const bunParser: LockfileParser = {
  ecosystem: "npm",
  lockfile: "bun.lock",

  parse({ lockfile }: ParserInput): DepEntry[] {
    let lock: BunLock;
    try {
      lock = JSON.parse(stripTrailingCommas(lockfile)) as BunLock;
    } catch {
      return [];
    }

    // Workspace package names are not publishable dependencies.
    const workspaceNames = new Set(
      Object.values(lock.workspaces ?? {})
        .map((entry) => entry.name)
        .filter((name): name is string => name !== undefined),
    );

    const roots = [
      ...new Set(Object.values(lock.workspaces ?? {}).flatMap((entry) => depsOf(entry))),
    ].filter((name) => !workspaceNames.has(name));

    const edges = new Map<string, string[]>();
    const all = new Set<string>();

    for (const [name, tuple] of Object.entries(lock.packages ?? {})) {
      if (workspaceNames.has(name)) continue;
      all.add(name);

      // The third element carries the dependency map, when there is one.
      const meta = tuple[2];
      if (typeof meta === "object" && meta !== null) {
        const entry = meta as WorkspaceEntry;
        edges.set(name, [...new Set(depsOf(entry).filter((dep) => !workspaceNames.has(dep)))]);
      }
    }

    return toDeps("npm", depthsWithFallback({ roots, edges }, all));
  },
};
