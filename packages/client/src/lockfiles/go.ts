/**
 * Go (`go.sum`, with `go.mod` for depth).
 *
 * `go.sum` is a flat list of `module version hash` lines with no graph at all, so
 * it cannot yield depth on its own. `go.mod` can: the toolchain annotates
 * transitive requirements with `// indirect`, which is exactly the direct/indirect
 * split depth needs.
 *
 * So depth here is 0 or 1 and never deeper. That is a genuine limit of the format
 * rather than a shortcut — recovering true depth would mean resolving the module
 * graph, which needs the network and every dependency's own go.mod. Stated plainly
 * because it means a deep Go dependency is weighted as though it were one level
 * down, and is therefore slightly overpaid relative to a deep npm dependency.
 */
import type { DepEntry } from "@obrigado/shared";

import { toDeps } from "./types.ts";
import type { LockfileParser, ParserInput } from "./types.ts";

/**
 * Module paths from go.sum.
 *
 * Two lines exist per module — the module and its `/go.mod` — and the `/go.mod`
 * suffix is part of the hash entry, not the module path.
 */
function modulesFromSum(lockfile: string): Set<string> {
  const modules = new Set<string>();
  for (const raw of lockfile.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const path = line.split(/\s+/u)[0];
    if (path === undefined || path.length === 0) continue;
    modules.add(path);
  }
  return modules;
}

/** Direct requirements from go.mod — everything without `// indirect`. */
function directFromMod(manifest: string): Set<string> {
  const direct = new Set<string>();
  let inBlock = false;

  for (const raw of manifest.split("\n")) {
    const withoutComment = raw.split("//")[0] ?? "";
    const isIndirect = /\/\/\s*indirect/u.test(raw);
    const line = withoutComment.trim();
    if (line.length === 0) continue;

    if (/^require\s*\($/u.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }

    // Either `require path version` on one line, or `path version` in a block.
    const single = /^require\s+(\S+)\s+\S+/u.exec(line);
    if (single?.[1] !== undefined) {
      if (!isIndirect) direct.add(single[1]);
      continue;
    }
    if (inBlock) {
      const path = line.split(/\s+/u)[0];
      if (path !== undefined && path.length > 0 && !isIndirect) direct.add(path);
    }
  }
  return direct;
}

export const goParser: LockfileParser = {
  ecosystem: "go",
  lockfile: "go.sum",
  manifest: "go.mod",

  parse({ lockfile, manifest }: ParserInput): DepEntry[] {
    const modules = modulesFromSum(lockfile);
    const direct = manifest === undefined ? new Set<string>() : directFromMod(manifest);

    const depths = new Map<string, number>();
    for (const module of modules) {
      depths.set(module, direct.has(module) ? 0 : 1);
    }
    // A go.mod requirement absent from go.sum still counts; the developer chose it.
    for (const module of direct) depths.set(module, 0);

    return toDeps("go", depths);
  },
};
