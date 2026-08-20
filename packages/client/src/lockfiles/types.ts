import type { DepEntry } from "@obrigado/shared";

/**
 * One ecosystem's lockfile parser.
 *
 * A parser is a pure function of file contents, which is what makes the nine of
 * them testable against real fixtures rather than against a live filesystem. The
 * caller finds the files; the parser only interprets them.
 */
export interface LockfileParser {
  /** Namespace for `${ecosystem}:${name}` (§10.3 step 2). */
  readonly ecosystem: string;
  /** The lockfile this parser reads. Its presence selects the parser. */
  readonly lockfile: string;
  /**
   * A manifest naming the DIRECT dependencies, where the lockfile does not.
   *
   * Several formats list every resolved package without saying which the
   * developer actually chose (yarn v1, go.sum, poetry.lock). Without the
   * manifest, every package would look like a root and depth would collapse to
   * zero — flattening the `1/(1+depth)` weighting that §10.3 exists to provide.
   */
  readonly manifest?: string;
  parse(input: ParserInput): DepEntry[];
}

export interface ParserInput {
  readonly lockfile: string;
  readonly manifest?: string | undefined;
}

/** Namespaced, lowercased, deduplicated — the form the API expects. */
export function toDeps(ecosystem: string, depths: ReadonlyMap<string, number>): DepEntry[] {
  const out: DepEntry[] = [];
  const seen = new Set<string>();

  for (const [name, depth] of depths) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    const id = `${ecosystem}:${trimmed}`.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ p: id, d: depth });
  }
  return out;
}

/** Parse JSON without throwing — a malformed lockfile is not worth a crash. */
export function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function safeToml<T>(text: string): T | null {
  try {
    return Bun.TOML.parse(text) as T;
  } catch {
    return null;
  }
}

export function safeYaml<T>(text: string): T | null {
  try {
    return Bun.YAML.parse(text) as T;
  } catch {
    return null;
  }
}
