/**
 * Python — Poetry (`poetry.lock`) and uv (`uv.lock`).
 *
 * Both are TOML arrays of `[[package]]`, and they disagree about how a dependency
 * is written:
 *
 *   poetry.lock  [package.dependencies]  urllib3 = ">=1.21"      (a table)
 *   uv.lock      [[package.dependencies]]  name = "urllib3"      (an array)
 *
 * Roots differ too. Poetry does not mark them, so `pyproject.toml` supplies them.
 * uv marks the project itself with `source = { virtual = "." }` or
 * `{ editable = "." }`, so its roots come from the lockfile alone.
 */
import type { DepEntry } from "@obrigado/shared";

import { depthsWithFallback } from "./graph.ts";
import { safeToml, toDeps } from "./types.ts";
import type { LockfileParser } from "./types.ts";

interface PoetryPackage {
  name?: string;
  dependencies?: Record<string, unknown>;
}

interface UvDependency {
  name?: string;
}

interface UvPackage {
  name?: string;
  source?: Record<string, unknown>;
  dependencies?: UvDependency[];
  "dev-dependencies"?: Record<string, UvDependency[]>;
  "optional-dependencies"?: Record<string, UvDependency[]>;
}

interface Lock {
  package?: Array<PoetryPackage & UvPackage>;
}

interface PyProject {
  project?: { dependencies?: string[]; "optional-dependencies"?: Record<string, string[]> };
  tool?: {
    poetry?: {
      dependencies?: Record<string, unknown>;
      group?: Record<string, { dependencies?: Record<string, unknown> }>;
    };
  };
}

/** `requests[socks] >= 2.0 ; python_version < "3.9"` → `requests`. */
export function requirementName(requirement: string): string {
  return (
    requirement
      .trim()
      .split(/[[\s<>=!~;(]/u)[0]
      ?.trim() ?? ""
  );
}

function pyprojectRoots(manifest: string | undefined): string[] {
  if (manifest === undefined) return [];
  const parsed = safeToml<PyProject>(manifest);
  if (parsed === null) return [];

  const roots = new Set<string>();
  // PEP 621.
  for (const requirement of parsed.project?.dependencies ?? []) {
    const name = requirementName(requirement);
    if (name.length > 0) roots.add(name);
  }
  for (const group of Object.values(parsed.project?.["optional-dependencies"] ?? {})) {
    for (const requirement of group) {
      const name = requirementName(requirement);
      if (name.length > 0) roots.add(name);
    }
  }
  // Poetry's own table, including groups.
  for (const name of Object.keys(parsed.tool?.poetry?.dependencies ?? {})) {
    if (name.toLowerCase() !== "python") roots.add(name);
  }
  for (const group of Object.values(parsed.tool?.poetry?.group ?? {})) {
    for (const name of Object.keys(group.dependencies ?? {})) roots.add(name);
  }
  return [...roots];
}

/** uv nests dev and optional dependencies one group deeper. */
function groupedNames(entry: UvPackage): string[] {
  const groups = [entry["dev-dependencies"], entry["optional-dependencies"]];
  return groups
    .flatMap((group) => Object.values(group ?? {}))
    .flat()
    .map((child) => child.name)
    .filter((child): child is string => child !== undefined && child.length > 0);
}

function build(lockfile: string, manifest: string | undefined, ecosystem: string): DepEntry[] {
  const lock = safeToml<Lock>(lockfile);
  if (lock === null) return [];

  const edges = new Map<string, string[]>();
  const all = new Set<string>();
  const lockRoots = new Set<string>();

  for (const entry of lock.package ?? []) {
    const name = entry.name;
    if (name === undefined || name.length === 0) continue;

    // uv marks the project itself; it is not a dependency anyone is paid for.
    const source = entry.source ?? {};
    const isProject = "virtual" in source || "editable" in source;
    if (!isProject) all.add(name);

    const children = new Set<string>();

    // poetry: a table keyed by name.
    if (entry.dependencies !== undefined && !Array.isArray(entry.dependencies)) {
      for (const child of Object.keys(entry.dependencies)) {
        if (child.toLowerCase() !== "python") children.add(child);
      }
    }
    // uv: an array of { name }.
    if (Array.isArray(entry.dependencies)) {
      for (const child of entry.dependencies) {
        if (child.name !== undefined && child.name.length > 0) children.add(child.name);
      }
    }
    for (const grouped of groupedNames(entry)) children.add(grouped);

    if (isProject) {
      for (const child of children) lockRoots.add(child);
      continue;
    }
    if (children.size > 0) {
      edges.set(name, [...new Set([...(edges.get(name) ?? []), ...children])]);
    }
  }

  const roots = lockRoots.size > 0 ? [...lockRoots] : pyprojectRoots(manifest);
  return toDeps(ecosystem, depthsWithFallback({ roots, edges }, all));
}

export const poetryParser: LockfileParser = {
  ecosystem: "pypi",
  lockfile: "poetry.lock",
  manifest: "pyproject.toml",
  parse: ({ lockfile, manifest }) => build(lockfile, manifest, "pypi"),
};

export const uvParser: LockfileParser = {
  ecosystem: "pypi",
  lockfile: "uv.lock",
  manifest: "pyproject.toml",
  parse: ({ lockfile, manifest }) => build(lockfile, manifest, "pypi"),
};
