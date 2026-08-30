/**
 * Safe writer for Pi's documented extension directory.
 *
 * Pi discovers extensions by PLACEMENT rather than by a manifest: any `*.ts` in
 * `~/.pi/agent/extensions/` is loaded. So installation here is not a config merge — there is no
 * foreign document to preserve — it is one file written into a directory the host already
 * watches. The rules from `opencode-plugin.ts` still hold where they apply (INVARIANT 11, §3):
 *
 *   1. Only our own file is ever touched. Another extension in that directory is never read,
 *      moved or rewritten, and the directory is never cleared.
 *   2. No program file, binary or bundle is modified. Ever.
 *   3. An existing file at our path is backed up before it is replaced, so a developer who
 *      edited their copy can get it back.
 *   4. The write is atomic (temp file + rename): an interrupted install cannot leave the host
 *      loading a half-written extension, which — unlike a truncated JSON config — would be
 *      executable code.
 *
 * The file is copied rather than symlinked or stubbed. A developer who finds an unexpected
 * `.ts` in their extensions directory should be able to read the thing that is actually running,
 * and an absolute path into `node_modules` breaks the moment the package is reinstalled.
 */
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKUP_DIR, ensureDir } from "./config.ts";

/** The two hosts that load this extension unmodified. */
export type PiHost = "pi" | "oh-my-pi";

/** The filename we own inside the extensions directory. */
const PI_EXTENSION_FILENAME = "obrigado.ts";

/**
 * Where each host keeps its user-level agent directory.
 *
 * oh-my-pi is a fork of Pi and rebranded the namespace to `.omp`, so the paths diverge even
 * though the extension API does not. This is the only reason `oh-my-pi` needs its own install
 * target at all: one extension, two directories.
 */
const AGENT_DIR: Record<PiHost, string> = {
  pi: join(homedir(), ".pi", "agent"),
  "oh-my-pi": join(homedir(), ".omp", "agent"),
};

/**
 * The override both hosts read, honoured because they read it.
 *
 * Verified in oh-my-pi's shipped binary, which calls `process.env.PI_CODING_AGENT_DIR` under
 * upstream's name rather than an `OMP_`-prefixed one. That it is SHARED is the awkward part: if
 * it is set, both hosts resolve to the same directory, and two copies of this file cannot live
 * there under one name. `piExtensionTargets` below is where that collision is resolved.
 *
 * oh-my-pi's `--profile` moves the path again at runtime, which no install-time check can see.
 * A developer using profiles installs per profile by setting this variable.
 */
function agentDir(host: PiHost): string {
  const override = process.env["PI_CODING_AGENT_DIR"];
  if (override !== undefined && override.length > 0) {
    return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
  }
  return AGENT_DIR[host];
}

function piExtensionPath(host: PiHost): string {
  return join(agentDir(host), "extensions", PI_EXTENSION_FILENAME);
}

/** Present on PATH, or its config home exists. */
export function piDetected(): boolean {
  return Bun.which("pi") !== null || existsSync(join(homedir(), ".pi"));
}

export function ohMyPiDetected(): boolean {
  return Bun.which("omp") !== null || existsSync(join(homedir(), ".omp"));
}

/**
 * The hosts to actually write for, with the shared-override collision resolved.
 *
 * When `PI_CODING_AGENT_DIR` points both hosts at one directory, installing both would write
 * the same path twice and the second `--agent` would win silently — so revenue would attribute
 * to whichever host was installed last, for both. One target is kept instead, preferring the
 * one the developer named.
 */
export function piExtensionTargets(
  requested: readonly PiHost[],
  explicit: PiHost | null = null,
): readonly PiHost[] {
  const seen = new Map<string, PiHost>();
  for (const host of requested) {
    const path = piExtensionPath(host);
    const held = seen.get(path);
    if (held === undefined || host === explicit) seen.set(path, host);
  }
  return [...seen.values()];
}

/**
 * The extension's source, read from the package that owns it.
 *
 * Resolved through the package's own `exports` rather than by a relative path, so it works the
 * same from a workspace checkout and from an installed copy under `node_modules`.
 */
async function extensionSource(): Promise<string> {
  const resolved = import.meta.resolve("@obrigado/pi-extension/extension");
  return await readFile(fileURLToPath(resolved), "utf8");
}

/**
 * The line the installer rewrites, and the only difference between the two copies.
 *
 * Asserted in both directions by `pi-extension.test.ts`: the marker must appear exactly once in
 * the source, because a silent miss would ship an oh-my-pi copy that bills as Pi.
 */
const AGENT_MARKER = 'const AGENT = "pi";';

/** The second rewritten line: how the copy reaches the renderer. */
const COMMAND_MARKER = 'const COMMAND = "obrigado statusline";';

function rewrite(source: string, marker: string, replacement: string): string {
  const occurrences = source.split(marker).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Pi extension source must contain \`${marker}\` exactly once (found ${occurrences})`,
    );
  }
  return source.replace(marker, replacement);
}

/**
 * How the installed copy invokes the renderer.
 *
 * The same decision `statusline.ts` makes for Claude Code, for the same reason: `obrigado` on
 * PATH is the published case, but a source checkout has no such binary, and an extension that
 * spawns a missing command renders nothing and says nothing about why. `process.execPath` is
 * the Bun running this installer, which is by definition one that can run the CLI.
 */
export function rendererCommand(): string {
  if (Bun.which("obrigado") !== null) return "obrigado statusline";
  const cli = join(dirname(import.meta.dir), "src", "cli.ts");
  return `${process.execPath} ${cli} statusline`;
}

export function sourceForHost(source: string, host: PiHost, command = rendererCommand()): string {
  const withCommand = rewrite(
    source,
    COMMAND_MARKER,
    `const COMMAND = ${JSON.stringify(command)};`,
  );
  if (host === "pi") return withCommand;
  return rewrite(withCommand, AGENT_MARKER, `const AGENT = "${host}";`);
}

async function backup(path: string, backupDir: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  await ensureDir(backupDir);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const destination = join(backupDir, `pi-extension-${stamp}.ts`);
  await Bun.write(destination, await file.text());
  return destination;
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await ensureDir(dirname(path));
  const temporary = `${path}.obrigado-${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

export type PiInstallOutcome =
  | { readonly status: "installed"; readonly path: string; readonly backup: string | null }
  | { readonly status: "already-installed"; readonly path: string };

export async function installPiExtension(
  host: PiHost,
  path = piExtensionPath(host),
  backupDir = BACKUP_DIR,
): Promise<PiInstallOutcome> {
  const wanted = sourceForHost(await extensionSource(), host);

  const file = Bun.file(path);
  // Byte-identical means there is nothing to do — and, importantly, nothing to back up. A
  // re-run of `obrigado install` should not deposit a copy of our own file every time.
  if ((await file.exists()) && (await file.text()) === wanted) {
    return { status: "already-installed", path };
  }

  const backupPath = await backup(path, backupDir);
  await writeAtomic(path, wanted);
  return { status: "installed", path, backup: backupPath };
}

export type PiUninstallOutcome = "removed" | "not-installed";

/**
 * Removes our file and nothing else.
 *
 * A file at our path that we did not write is left alone: the header is checked first, because
 * deleting a developer's own `obrigado.ts` would be destroying work to tidy up after ourselves.
 */
export async function uninstallPiExtension(
  host: PiHost,
  path = piExtensionPath(host),
  backupDir = BACKUP_DIR,
): Promise<PiUninstallOutcome> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "not-installed";

  const text = await file.text();
  if (!text.includes("Obrigado's Pi surface")) return "not-installed";

  await backup(path, backupDir);
  await file.delete();
  return "removed";
}
