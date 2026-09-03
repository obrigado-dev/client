/**
 * How an installer tells a host to run the renderer.
 *
 * Three installers each decided this for themselves — Claude Code's `statusLine`, Codex's
 * status-line command, the Pi extension's `COMMAND` line — and each carried the same three
 * cases: `obrigado` on PATH, a compiled binary run in place, a source checkout. Three copies of
 * a decision that has to come out identical, because `isOurStatusLine` has to recognise what
 * every one of them wrote in order to uninstall it.
 *
 * The three cases, in order:
 *
 *   1. `obrigado` on PATH — the published case, and the only one that survives the binary
 *      moving.
 *   2. A compiled binary that is not on PATH — downloaded and run in place. Its sources live
 *      in Bun's virtual filesystem, so the checkout form below would write a path nothing can
 *      run; the binary IS the CLI, so it is invoked directly.
 *   3. A source checkout — `bun /path/to/cli.ts`, with the Bun running this installer, which is
 *      by definition one that can run the CLI.
 *
 * A source-checkout command written into a host's config and later invoked when the CLI is
 * not on PATH renders nothing and says nothing about why, which looks exactly like "the
 * product is broken". That is why every case is decided at install time, when the answer is a
 * fact, rather than sniffed per render.
 */
import { dirname, join } from "node:path";

/** Whether this module was loaded from a `bun build --compile` binary rather than from disk. */
function isCompiledBinary(path = import.meta.path): boolean {
  return path.includes("$bunfs") || path.includes("~BUN");
}

/**
 * The renderer command as a shell string, with `--agent <host>` appended when a host is named.
 *
 * The host is named explicitly rather than left to the renderer's default, so every installed
 * command states which agent it attributes to. A default that some callers rely on and others
 * override is a default that eventually mis-attributes revenue.
 */
export function rendererCommand(agent?: string): string {
  const suffix = agent === undefined ? "" : ` --agent ${agent}`;
  if (Bun.which("obrigado") !== null) return `obrigado statusline${suffix}`;
  if (isCompiledBinary()) return `${process.execPath} statusline${suffix}`;
  // `import.meta.path` is this module; the CLI entry sits beside it.
  const cli = join(dirname(import.meta.path), "cli.ts");
  return `${process.execPath} ${cli} statusline${suffix}`;
}
