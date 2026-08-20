/**
 * Lockfile discovery and merging (§10.3, Phase 1).
 *
 * All nine v1 ecosystems. A workspace can legitimately have several — a Rust
 * binary with a TypeScript frontend has both `Cargo.lock` and `pnpm-lock.yaml` —
 * and every one contributes, because the developer depends on all of it.
 *
 * Ordering is deliberate: where two npm-family lockfiles coexist (a repo migrated
 * from npm to pnpm and left the old file behind), the first match wins per
 * ecosystem. Merging them would double-count a package at two different depths
 * and let a stale file dilute a live one.
 */
import { join } from "node:path";

import type { DepEntry } from "@obrigado/shared";

import { bunParser } from "./bun.ts";
import { cargoParser } from "./cargo.ts";
import { goParser } from "./go.ts";
import { npmParser } from "./npm.ts";
import { pnpmParser } from "./pnpm.ts";
import { poetryParser, uvParser } from "./python.ts";
import { rubyParser } from "./ruby.ts";
import { yarnParser } from "./yarn.ts";
import type { LockfileParser } from "./types.ts";

/**
 * Preference order within an ecosystem.
 *
 * bun, pnpm and yarn before npm: a `package-lock.json` is frequently a leftover,
 * whereas nobody keeps a stray `bun.lock`. uv before poetry for the same reason —
 * uv is what a migrated project uses.
 */
export const PARSERS: readonly LockfileParser[] = [
  bunParser,
  pnpmParser,
  yarnParser,
  npmParser,
  cargoParser,
  uvParser,
  poetryParser,
  goParser,
  rubyParser,
];

export interface ResolvedDeps {
  readonly deps: DepEntry[];
  /** Which lockfiles were read, for `obrigado status` and debugging. */
  readonly sources: string[];
}

async function readIfPresent(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
}

/**
 * Read every lockfile in `cwd` and merge into one dependency set.
 *
 * Not recursive: a monorepo's lockfiles live at its root, and walking a tree from
 * an arbitrary working directory would make the fingerprint depend on which
 * subdirectory the agent happened to start in — the same dependency set would
 * hash differently per terminal tab.
 */
export async function readLockfiles(cwd: string): Promise<ResolvedDeps> {
  const deps: DepEntry[] = [];
  const sources: string[] = [];
  const covered = new Set<string>();

  for (const parser of PARSERS) {
    if (covered.has(parser.ecosystem)) continue;

    // oxlint-disable-next-line eslint/no-await-in-loop -- first match per ecosystem wins, so later parsers are skipped rather than raced
    const lockfile = await readIfPresent(join(cwd, parser.lockfile));
    if (lockfile === undefined) continue;

    const manifest =
      parser.manifest === undefined
        ? undefined
        : // oxlint-disable-next-line eslint/no-await-in-loop -- only read when the lockfile matched
          await readIfPresent(join(cwd, parser.manifest));

    const parsed = parser.parse({ lockfile, manifest });
    if (parsed.length === 0) continue;

    covered.add(parser.ecosystem);
    sources.push(parser.lockfile);
    deps.push(...parsed);
  }

  return { deps: mergeShallowest(deps), sources };
}

/**
 * Deduplicate, keeping the SHALLOWEST depth for each package.
 *
 * A package can appear in two ecosystems' lockfiles at different depths — and
 * within one, via two parsers. Keeping the shallowest matches `canonicalizeDeps`
 * on the server, so the client and the server agree about the depth map that
 * decides money.
 */
export function mergeShallowest(deps: readonly DepEntry[]): DepEntry[] {
  const shallowest = new Map<string, number>();
  for (const dep of deps) {
    const existing = shallowest.get(dep.p);
    if (existing === undefined || dep.d < existing) shallowest.set(dep.p, dep.d);
  }
  return [...shallowest.entries()].map(([p, d]) => ({ p, d }));
}
