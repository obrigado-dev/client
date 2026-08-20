/**
 * Dependency resolution (§10.3, Phase 1).
 *
 * Reads every lockfile in the workspace and merges them, with real depth. Phase 0
 * read only `package.json`'s direct dependencies, which meant depth was always 0
 * and every transitive dependency was invisible — on this repository that was 7
 * packages instead of 175, and it flattened the `1/(1+depth)` weighting that
 * §10.3 exists to provide.
 *
 * `package.json` remains as a fallback for a workspace with no lockfile at all,
 * because a dependency set is better than nothing and direct dependencies are
 * still real dependencies.
 */
import { join } from "node:path";

import type { DepEntry } from "@obrigado/shared";

import { readLockfiles } from "./lockfiles/index.ts";

export interface ResolvedDeps {
  readonly deps: DepEntry[];
  /** Where the set came from, for `obrigado status` and `doctor`. */
  readonly source: string;
}

interface PackageManifest {
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function manifestOf(cwd: string): Promise<PackageManifest | null> {
  const file = Bun.file(join(cwd, "package.json"));
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as PackageManifest;
  } catch {
    // A malformed manifest is not worth failing a session over.
    return null;
  }
}

/** Direct dependencies only, at depth 0 — the no-lockfile fallback. */
function fromManifest(manifest: PackageManifest): DepEntry[] {
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  return [...names].map((name) => ({ p: `npm:${name}`.toLowerCase(), d: 0 }));
}

export async function resolveDeps(cwd: string = process.cwd()): Promise<ResolvedDeps> {
  const { deps, sources } = await readLockfiles(cwd);
  if (deps.length > 0) {
    return { deps, source: sources.join(", ") };
  }

  const manifest = await manifestOf(cwd);
  if (manifest !== null) {
    const fallback = fromManifest(manifest);
    if (fallback.length > 0) {
      return { deps: fallback, source: "package.json (no lockfile — direct dependencies only)" };
    }
  }

  return { deps: [], source: "none" };
}

/**
 * Whether this looks like a private repository.
 *
 * §10.4 treats these as sensitive: "a private monorepo's exact package set can be
 * effectively unique to one company", so the fingerprint is flagged and its
 * packages are not registered publicly.
 */
export async function isPrivateRepo(cwd: string = process.cwd()): Promise<boolean> {
  const manifest = await manifestOf(cwd);
  return manifest?.private === true;
}
