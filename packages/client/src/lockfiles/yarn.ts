/**
 * Yarn (`yarn.lock`) — classic v1 and Berry v2+.
 *
 * Two formats behind one filename. Berry is YAML with a `__metadata` key; v1 is a
 * bespoke indented format that predates it. The `__metadata` key is the
 * discriminator.
 *
 * Neither records which dependencies are DIRECT, so `package.json` is required
 * for roots. Without it every resolved package would look like a root and depth
 * would collapse to zero, flattening the `1/(1+depth)` weighting §10.3 exists to
 * provide — so when the manifest is missing this reports depth 1 for everything
 * rather than pretending to know.
 */
import type { DepEntry } from "@obrigado/shared";

import { depthsWithFallback } from "./graph.ts";
import { safeJson, safeYaml, toDeps } from "./types.ts";
import type { LockfileParser, ParserInput } from "./types.ts";

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface BerryEntry {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** `foo@npm:^1.0.0` / `foo@^1.0.0` / `@scope/foo@npm:1.0.0` → `foo`. */
export function descriptorName(descriptor: string): string {
  const cleaned = descriptor.trim().replaceAll(/^"|"$/gu, "");
  const at = cleaned.lastIndexOf("@");
  if (at <= 0) return cleaned;
  return cleaned.slice(0, at);
}

function rootsFrom(manifest: string | undefined): string[] {
  if (manifest === undefined) return [];
  const parsed = safeJson<Manifest>(manifest);
  if (parsed === null) return [];
  return [
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.devDependencies ?? {}),
    ...Object.keys(parsed.optionalDependencies ?? {}),
    ...Object.keys(parsed.peerDependencies ?? {}),
  ];
}

function parseBerry(lockfile: string): { edges: Map<string, string[]>; all: Set<string> } {
  const lock = safeYaml<Record<string, BerryEntry>>(lockfile) ?? {};
  const edges = new Map<string, string[]>();
  const all = new Set<string>();

  for (const [key, entry] of Object.entries(lock)) {
    if (key === "__metadata") continue;
    // A key can list several descriptors for one resolution.
    for (const descriptor of key.split(",")) {
      const name = descriptorName(descriptor);
      if (name.length === 0 || name.startsWith("__")) continue;
      all.add(name);

      const children = [
        ...Object.keys(entry.dependencies ?? {}),
        ...Object.keys(entry.peerDependencies ?? {}),
      ];
      if (children.length > 0) {
        edges.set(name, [...new Set([...(edges.get(name) ?? []), ...children])]);
      }
    }
  }
  return { edges, all };
}

/**
 * Classic v1: entry headers at column zero, `dependencies:` nested two spaces,
 * each child four spaces in as `name "range"`.
 */
function parseClassic(lockfile: string): { edges: Map<string, string[]>; all: Set<string> } {
  const edges = new Map<string, string[]>();
  const all = new Set<string>();

  let current: string[] = [];
  let inDependencies = false;

  for (const raw of lockfile.split("\n")) {
    const line = raw.replace(/\r$/u, "");
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;

    // An entry header is unindented and ends with a colon.
    if (!line.startsWith(" ") && line.trimEnd().endsWith(":")) {
      const header = line.trimEnd().slice(0, -1);
      current = header
        .split(",")
        .map((descriptor) => descriptorName(descriptor))
        .filter((name) => name.length > 0);
      for (const name of current) all.add(name);
      inDependencies = false;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "dependencies:" || trimmed === "optionalDependencies:") {
      inDependencies = true;
      continue;
    }
    // Any other key at the two-space level ends the dependency block.
    if (inDependencies && /^ {2}\S/u.test(line)) {
      inDependencies = false;
    }

    if (inDependencies && /^ {4}\S/u.test(line)) {
      const child = trimmed.split(/\s+/u)[0]?.replaceAll(/^"|"$/gu, "");
      if (child === undefined || child.length === 0) continue;
      for (const name of current) {
        edges.set(name, [...new Set([...(edges.get(name) ?? []), child])]);
      }
    }
  }
  return { edges, all };
}

export const yarnParser: LockfileParser = {
  ecosystem: "npm",
  lockfile: "yarn.lock",
  manifest: "package.json",

  parse({ lockfile, manifest }: ParserInput): DepEntry[] {
    const isBerry = /^__metadata:/mu.test(lockfile);
    const { edges, all } = isBerry ? parseBerry(lockfile) : parseClassic(lockfile);

    const roots = rootsFrom(manifest);
    // With no manifest there is no honest way to identify direct dependencies,
    // so nothing is claimed to be one.
    return toDeps("npm", depthsWithFallback({ roots, edges }, all));
  },
};
