/**
 * Rust (`Cargo.lock`).
 *
 * TOML, an array of `[[package]]` tables, each with a `dependencies` list of
 * names (sometimes `"name version"` or `"name version (registry+...)"`).
 *
 * Cargo.lock does not say which crates are the workspace's own, so roots come
 * from `Cargo.toml` when present. Without it, the roots are inferred as the
 * crates nothing else depends on — which is what a workspace member is. That
 * inference is stated rather than hidden because it can be wrong: a genuinely
 * unused transitive crate would be promoted to depth 0 and slightly overpaid.
 */
import type { DepEntry } from "@obrigado/shared";

import { depthsWithFallback } from "./graph.ts";
import { safeToml, toDeps } from "./types.ts";
import type { LockfileParser, ParserInput } from "./types.ts";

interface CargoPackage {
  name?: string;
  dependencies?: string[];
}

interface CargoLock {
  package?: CargoPackage[];
}

interface CargoManifest {
  dependencies?: Record<string, unknown>;
  "dev-dependencies"?: Record<string, unknown>;
  "build-dependencies"?: Record<string, unknown>;
  workspace?: {
    dependencies?: Record<string, unknown>;
  };
}

/** `serde 1.0.2 (registry+https://…)` → `serde`. */
function dependencyName(entry: string): string {
  return entry.trim().split(/\s+/u)[0] ?? "";
}

export const cargoParser: LockfileParser = {
  ecosystem: "cargo",
  lockfile: "Cargo.lock",
  manifest: "Cargo.toml",

  parse({ lockfile, manifest }: ParserInput): DepEntry[] {
    const lock = safeToml<CargoLock>(lockfile);
    if (lock === null) return [];

    const edges = new Map<string, string[]>();
    const all = new Set<string>();
    const depended = new Set<string>();

    for (const entry of lock.package ?? []) {
      const name = entry.name;
      if (name === undefined || name.length === 0) continue;
      all.add(name);

      const children = (entry.dependencies ?? [])
        .map((dependency) => dependencyName(dependency))
        .filter((child) => child.length > 0);
      if (children.length > 0) {
        edges.set(name, [...new Set([...(edges.get(name) ?? []), ...children])]);
        for (const child of children) depended.add(child);
      }
    }

    let roots: string[] = [];
    const parsedManifest = manifest === undefined ? null : safeToml<CargoManifest>(manifest);
    if (parsedManifest !== null) {
      roots = [
        ...Object.keys(parsedManifest.dependencies ?? {}),
        ...Object.keys(parsedManifest["dev-dependencies"] ?? {}),
        ...Object.keys(parsedManifest["build-dependencies"] ?? {}),
        ...Object.keys(parsedManifest.workspace?.dependencies ?? {}),
      ];
    }
    if (roots.length === 0) {
      // Nothing depends on a workspace member, so the crates with no incoming
      // edge are the closest available answer.
      roots = [...all].filter((name) => !depended.has(name));
    }

    return toDeps("cargo", depthsWithFallback({ roots, edges }, all));
  },
};
