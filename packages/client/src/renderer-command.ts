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
 *      moving. Named by its full path when a package manager installed it (A44).
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
 *
 * On Windows a path is written for the shell that will read it (A46): see `forShell`.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Whether this module was loaded from a `bun build --compile` binary rather than from disk. */
function isCompiledBinary(path = import.meta.path): boolean {
  return path.includes("$bunfs") || path.includes("~BUN");
}

/**
 * The renderer as argv, for a host that does not start with the installing shell's PATH.
 *
 * The same three cases, with `obrigado` named by its full path. The Claude desktop app starts
 * Claude Code with the PATH the app itself was started with, and on a Mac opened from the Dock
 * that did not include `~/.local/bin`, where install.sh puts the binary (A37).
 */
export function absoluteRendererArgv(): string[] {
  const onPath = Bun.which("obrigado");
  if (onPath !== null) return [onPath, "statusline"];
  if (isCompiledBinary()) return [process.execPath, "statusline"];
  return [process.execPath, join(dirname(import.meta.path), "cli.ts"), "statusline"];
}

/** The machine a command is written for, passed in so a test can stand up Windows anywhere. */
export interface RendererMachine {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** `HOME`, which Git Bash expands `~` to wherever it is set. */
  readonly homeVariable?: string | undefined;
}

function thisMachine(): RendererMachine {
  return { platform: process.platform, home: homedir(), homeVariable: process.env["HOME"] };
}

/** A Windows path in forward slashes, without a trailing one. Compared without case, as Windows does. */
function plain(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

/**
 * A path as the shell a host runs the command in will read it (A46).
 *
 * Elsewhere a path is written as it is. On Windows, Claude Code runs a status line through Git
 * Bash, or through PowerShell where Git Bash is not installed. Bash takes a backslash for an
 * escape and drops it, so `C:\Users\…` arrives as `C:Users…` and the line goes blank with no
 * error. Forward slashes name the same file to both shells, and so does `~` for the home
 * directory, which keeps a profile folder with a space in its name (`C:\Users\Jo Doe`) out of a
 * command that cannot quote it.
 */
export function forShell(path: string, machine: RendererMachine = thisMachine()): string {
  if (machine.platform !== "win32") return path;
  const slashed = plain(path);
  const home = plain(machine.home);
  // Git Bash expands `~` to HOME where it is set, and some set it elsewhere for their dotfiles.
  const bashHome = machine.homeVariable ?? "";
  const tildeIsHome = bashHome === "" || plain(bashHome).toLowerCase() === home.toLowerCase();
  const underHome =
    tildeIsHome && home.length > 0 && slashed.toLowerCase().startsWith(`${home.toLowerCase()}/`);
  return underHome ? `~${slashed.slice(home.length)}` : slashed;
}

/** Whether npm, pnpm, bun or yarn put this binary where it is: in their `node_modules` (A44). */
function fromPackageManager(binary: string): boolean {
  return binary.split(/[\\/]/u).includes("node_modules");
}

/**
 * The renderer command as a shell string, with `--agent <host>` appended when a host is named.
 *
 * The host is named explicitly rather than left to the renderer's default, so every installed
 * command states which agent it attributes to. A default that some callers rely on and others
 * override is a default that eventually mis-attributes revenue.
 *
 * `obrigado` on PATH is named bare, except where a package manager installed it (A44). Under a
 * Node version manager such as nvm, fnm or Vite+, that bin directory is one Node version's, so
 * the bare name stops resolving in any shell on another version and the line goes blank. Its
 * `obrigado` is a shell script that runs under any Node, so the path it has now keeps working.
 * Only a path that needs no quoting: `statusLineOwner` takes a quote for a command of the
 * developer's, and uninstall would then leave ours behind. On Windows that rules out any path
 * with a space that `~` cannot stand in for, and the bare name is written instead (A46): it runs
 * once `obrigado` is on PATH, and install.ps1 says how to put it there.
 */
export function rendererCommand(
  agent?: string,
  found?: Found,
  machine: RendererMachine = thisMachine(),
): string {
  const suffix = agent === undefined ? "" : ` --agent ${agent}`;
  const onPath = found === undefined ? Bun.which("obrigado") : found.onPath;
  if (onPath !== null) {
    const binary = found?.binary ?? process.execPath;
    const byPath = fromPackageManager(binary) && /^[\w./+@-]+$/u.test(onPath);
    return `${byPath ? onPath : "obrigado"} statusline${suffix}`;
  }
  const argv = installedArgv(found);
  const command = argv.map((part) => forShell(part, machine));
  if (machine.platform === "win32" && !command.every((part) => /^[\w./:~+@-]+$/u.test(part))) {
    return `obrigado statusline${suffix}`;
  }
  return `${command.join(" ")} statusline${suffix}`;
}

/** What the installer found: `obrigado` on PATH, and the binary running the install. */
export interface Found {
  readonly onPath: string | null;
  readonly binary: string;
  /** Whether that binary is a compiled release; asked of this module when not given. */
  readonly compiled?: boolean;
}

/** The renderer without `obrigado` on PATH: the binary itself, or Bun and a checkout's CLI. */
function installedArgv(found?: Found): string[] {
  const binary = found?.binary ?? process.execPath;
  if (found?.compiled ?? isCompiledBinary()) return [binary];
  // `import.meta.path` is this module; the CLI entry sits beside it.
  return [binary, join(dirname(import.meta.path), "cli.ts")];
}

/**
 * `argv` as one command that `splitCommand` in `@obrigado/surface` reads back into the same argv:
 * a part with anything but plain path characters goes in single quotes, inside which nothing is
 * special. Windows paths among them, whose backslashes and spaces a shell would take apart.
 */
export function quotedCommand(argv: readonly string[]): string {
  return argv
    .map((part) => (/^[\w./:@%+=,-]+$/u.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

/**
 * The renderer command for a host that splits it and spawns it with no shell, as the Pi extension
 * does (A46).
 *
 * Where `obrigado` is on PATH, the command `rendererCommand` writes. Elsewhere the full argv,
 * quoted for `splitCommand`: no shell will expand `~` for this host, and a Windows path holds
 * backslashes and, as often as not, a space.
 */
export function spawnedRendererCommand(found?: Found): string {
  const onPath = found === undefined ? Bun.which("obrigado") : found.onPath;
  if (onPath !== null) return rendererCommand(undefined, found);
  return quotedCommand([...installedArgv(found), "statusline"]);
}
