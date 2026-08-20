/**
 * Ruby (`Gemfile.lock`).
 *
 * A bespoke indented format. Two sections matter:
 *
 *   GEM
 *     specs:
 *       rails (7.1.0)          <- FOUR spaces: a resolved gem
 *         actionpack (= 7.1.0) <- SIX spaces: one of its dependencies
 *   DEPENDENCIES
 *     rails                    <- what the Gemfile actually asked for
 *
 * `DEPENDENCIES` is the direct set, which is unusual and welcome: unlike yarn.lock
 * or poetry.lock, the lockfile states its own roots, so no manifest is needed.
 *
 * Indentation is the grammar, so it is matched exactly rather than by trimming —
 * a gem and its dependency differ only by two spaces, and treating them alike
 * would flatten every depth to zero.
 */
import type { DepEntry } from "@obrigado/shared";

import { depthsWithFallback } from "./graph.ts";
import { toDeps } from "./types.ts";
import type { LockfileParser, ParserInput } from "./types.ts";

/** `rails (>= 7.0, < 8)` → `rails`. */
function gemName(line: string): string {
  return line.trim().split(/[\s(]/u)[0] ?? "";
}

export const rubyParser: LockfileParser = {
  ecosystem: "rubygems",
  lockfile: "Gemfile.lock",

  parse({ lockfile }: ParserInput): DepEntry[] {
    const edges = new Map<string, string[]>();
    const all = new Set<string>();
    const roots = new Set<string>();

    let section: "specs" | "dependencies" | null = null;
    let currentGem: string | null = null;

    for (const raw of lockfile.split("\n")) {
      const line = raw.replace(/\r$/u, "");
      if (line.trim().length === 0) continue;

      // Section headers are unindented.
      if (!line.startsWith(" ")) {
        section = line.trim() === "DEPENDENCIES" ? "dependencies" : null;
        currentGem = null;
        continue;
      }

      if (line.trim() === "specs:") {
        section = "specs";
        continue;
      }

      if (section === "dependencies") {
        // Two spaces, and a trailing `!` marks a git or path source.
        const name = gemName(line).replace(/!$/u, "");
        if (name.length > 0) roots.add(name);
        continue;
      }

      if (section !== "specs") continue;

      if (/^ {4}\S/u.test(line)) {
        currentGem = gemName(line);
        if (currentGem.length > 0) all.add(currentGem);
        continue;
      }
      if (/^ {6}\S/u.test(line) && currentGem !== null) {
        const child = gemName(line);
        if (child.length === 0) continue;
        edges.set(currentGem, [...new Set([...(edges.get(currentGem) ?? []), child])]);
      }
    }

    return toDeps("rubygems", depthsWithFallback({ roots: [...roots], edges }, all));
  },
};
