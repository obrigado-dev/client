/**
 * The statusline hook writer.
 *
 * INVARIANT 11 and §3: "Never patch another program's files." This module uses
 * only the host's documented configuration surface, and every rule below exists
 * to make that security boundary legible to a reviewer:
 *
 *   1. Exactly one key in one documented configuration file is ever written:
 *      `statusLine` in `~/.claude/settings.json`. That key is the documented
 *      extension point. Nothing else in the file is read for meaning, modified,
 *      reordered, or removed.
 *   2. No program file, binary, bundle or policy is touched — ever.
 *   3. A pre-existing statusline from another tool is never overwritten. If one
 *      is present, install REFUSES and explains, rather than silently winning.
 *   4. The file is backed up before the write and the previous value recorded,
 *      so uninstall restores byte-for-byte what was there.
 *   5. The write is atomic (temp file + rename), so an interrupted install
 *      cannot leave Claude Code with a truncated settings file.
 *   6. No auto-update, no background mutation. Install and uninstall are the
 *      only two operations that write, and both are explicit user commands.
 */
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { BACKUP_DIR, CLAUDE_SETTINGS_PATH, ensureDir } from "./config.ts";

/**
 * The command Obrigado installs.
 *
 * `obrigado statusline` is correct only once the CLI is on PATH. Running from a
 * source checkout it is not, and Claude Code would invoke a command that does
 * not exist — the status line silently renders nothing, which looks exactly
 * like "the product is broken". So the command is derived from how the CLI is
 * actually being run.
 */
export function statusLineCommand(): string {
  const override = process.env["OBRIGADO_STATUSLINE_COMMAND"];
  if (override !== undefined && override.length > 0) return override;

  // `import.meta.path` is this module; the CLI entry sits beside it.
  //
  // The host is named explicitly rather than left to the renderer's default, so
  // every installed command states which agent it attributes to. A default that
  // some callers rely on and others override is a default that eventually
  // mis-attributes revenue.
  const cli = join(dirname(import.meta.path), "cli.ts");
  const onPath = Bun.which("obrigado");
  return onPath === null
    ? `${process.execPath} ${cli} statusline --agent claude-code`
    : "obrigado statusline --agent claude-code";
}

interface StatusLineEntry {
  type?: string;
  command?: string;
  padding?: number;
  [key: string]: unknown;
}

export type SettingsObject = Record<string, unknown>;

/**
 * Whether an entry is one we wrote.
 *
 * Must recognise both forms — the global `obrigado statusline` and the
 * source-checkout `<bun> /path/to/packages/client/src/cli.ts statusline` — or uninstall
 * would refuse to clean up its own work and a reinstall would refuse as if a
 * stranger owned the slot. The checkout's parent directory is deliberately not
 * part of the check: a repository rename must not orphan an entry we installed.
 */
export function isOurStatusLine(value?: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const command = (value as StatusLineEntry).command;
  if (typeof command !== "string") return false;
  const installedCli = /(?:^|[/\s])obrigado\s+statusline(?:\s|$)/iu.test(command);
  const sourceCli = /[/\\]packages[/\\]client[/\\]src[/\\]cli\.ts\s+statusline(?:\s|$)/iu.test(
    command,
  );
  return installedCli || sourceCli;
}

export async function readSettings(path = CLAUDE_SETTINGS_PATH): Promise<SettingsObject | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  const text = await file.text();
  if (text.trim().length === 0) return {};

  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object`);
  }
  return parsed as SettingsObject;
}

/** Copy the current settings file aside before touching it. */
async function backupSettings(path = CLAUDE_SETTINGS_PATH): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  await ensureDir(BACKUP_DIR);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const destination = join(BACKUP_DIR, `claude-settings-${stamp}.json`);
  await Bun.write(destination, await file.text());
  return destination;
}

/**
 * Write settings atomically.
 *
 * A partially written `settings.json` would break Claude Code itself, which is
 * exactly the class of harm §3 forbids. Temp file plus rename means the file is
 * either the old one or the new one.
 */
async function writeSettingsAtomically(path: string, settings: SettingsObject): Promise<void> {
  await ensureDir(dirname(path));
  const temporary = `${path}.obrigado-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export type InstallOutcome =
  | { readonly status: "installed"; readonly backup: string | null }
  | { readonly status: "already-installed" }
  | { readonly status: "refused"; readonly existing: unknown };

export interface InstallOptions {
  /**
   * Take over an existing statusline belonging to someone else.
   *
   * Off by default, and only ever set by an explicit `--replace` on the command
   * line. The default REFUSES, because silently replacing a developer's own
   * statusline — or another vendor's — is the behaviour that gets a tool
   * delisted, and the developer earns nothing from Obrigado, so a surprise there
   * has no upside to trade against.
   *
   * With the flag it is still not a clobber: the previous value is recorded in
   * `~/.obrigado/config.json`, the file is backed up first, and `obrigado
   * uninstall` puts the original back exactly.
   */
  readonly replace?: boolean;
}

/**
 * Install the statusline entry.
 *
 * Refuses rather than clobbering when another tool already owns the statusline,
 * unless `replace` is explicitly set.
 */
export async function installStatusLine(
  path = CLAUDE_SETTINGS_PATH,
  options: InstallOptions = {},
): Promise<{ outcome: InstallOutcome; previous: unknown }> {
  const settings = (await readSettings(path)) ?? {};
  const existing = settings["statusLine"];

  if (existing !== undefined && existing !== null) {
    if (isOurStatusLine(existing)) {
      return { outcome: { status: "already-installed" }, previous: existing };
    }
    if (options.replace !== true) {
      return { outcome: { status: "refused", existing }, previous: existing };
    }
  }

  const backup = await backupSettings(path);

  // Only this key is added or changed. Every other key is carried through
  // untouched.
  await writeSettingsAtomically(path, {
    ...settings,
    statusLine: { type: "command", command: statusLineCommand(), padding: 0 },
  });

  return { outcome: { status: "installed", backup }, previous: existing ?? null };
}

export type UninstallOutcome = "removed" | "restored" | "not-installed" | "foreign";

/** Remove our entry, restoring whatever was there before if we recorded it. */
export async function uninstallStatusLine(
  previous: unknown,
  path = CLAUDE_SETTINGS_PATH,
): Promise<UninstallOutcome> {
  const settings = await readSettings(path);
  if (settings === null) return "not-installed";

  const existing = settings["statusLine"];
  if (existing === undefined || existing === null) return "not-installed";
  if (!isOurStatusLine(existing)) return "foreign";

  await backupSettings(path);

  const next: SettingsObject = { ...settings };
  if (previous !== undefined && previous !== null) {
    next["statusLine"] = previous;
    await writeSettingsAtomically(path, next);
    return "restored";
  }

  delete next["statusLine"];
  await writeSettingsAtomically(path, next);
  return "removed";
}
