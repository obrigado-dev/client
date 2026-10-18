/**
 * Antigravity CLI's status line.
 *
 * Google's terminal agent documents the contract Claude Code's `statusLine` set: a `statusLine`
 * block in `~/.gemini/antigravity-cli/settings.json` naming a command, which the TUI runs whenever
 * the agent's state changes, with a JSON payload on stdin (`session_id`, `cwd`, `version` and the
 * rest), drawing what it prints (antigravity.google/docs/cli/statusline). So the renderer runs
 * unchanged, and this module is the same write `statusline.ts` makes, into a second file, with
 * that module's rules: one key, a backup first, an atomic write, and nothing of anybody else's
 * overwritten or removed.
 *
 * Two things differ, and both make it simpler than Claude Code's:
 *
 *   - `stack_with_default: true` draws our line under the host's built-in one instead of in its
 *     place. The built-in line is the developer's model, context and quota, and it stays.
 *   - There is no `--chain` or `--replace`. A `statusLine` already in the file is a script of the
 *     developer's that has replaced the built-in line, and the host runs one command, so the only
 *     ways in would be to displace theirs or to wrap it. Neither is done unasked, and nobody has
 *     asked yet: install refuses and says why, and the developer's line stays exactly as it was.
 *
 * What the payload does not carry is a prompt id or a time. It says what the agent is doing
 * instead, and `prompt-signal.ts` dates a prompt from how that changes between renders (A47).
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

import { ANTIGRAVITY_CLI_SETTINGS_PATH, BACKUP_DIR } from "./config.ts";
import { rendererCommand } from "./renderer-command.ts";
import {
  backupSettings,
  isOurStatusLine,
  readSettings,
  statusLineOwner,
  writeSettingsAtomically,
} from "./statusline.ts";
import type { InstallOutcome, StatusLineOwner } from "./statusline.ts";

/** What the backups of this file are called, beside Claude Code's in `~/.obrigado/backups`. */
const BACKUP_NAME = "antigravity-cli-settings";

/**
 * Present when its settings directory exists, or `agy` is on PATH outside an app bundle.
 *
 * The bundle check is the Antigravity rename again: before 2.0, `agy` on PATH was the IDE's tool,
 * a link into `Antigravity.app`, and a machine that still has one has an editor, not this agent.
 */
export function antigravityCliDetected(): boolean {
  if (existsSync(dirname(ANTIGRAVITY_CLI_SETTINGS_PATH))) return true;
  const onPath = Bun.which("agy");
  if (onPath === null) return false;
  try {
    return !realpathSync(onPath).includes(".app/");
  } catch {
    return false;
  }
}

/** The entry install writes: the renderer, named for this host, under the built-in line. */
export function antigravityStatusLine(): Record<string, unknown> {
  return {
    type: "command",
    command: rendererCommand("antigravity-cli"),
    padding: 0,
    stack_with_default: true,
  };
}

/** Write the entry, unless it is there already or a command of the developer's holds the slot. */
export async function installAntigravityStatusLine(
  path = ANTIGRAVITY_CLI_SETTINGS_PATH,
  backupDir = BACKUP_DIR,
): Promise<InstallOutcome> {
  const settings = (await readSettings(path)) ?? {};
  const existing = settings["statusLine"];

  if (existing !== undefined && existing !== null) {
    return isOurStatusLine(existing)
      ? { status: "already-installed" }
      : { status: "refused", existing };
  }

  const backup = await backupSettings(path, backupDir, BACKUP_NAME);
  // Only this key is added. Every other key is carried through untouched.
  await writeSettingsAtomically(path, { ...settings, statusLine: antigravityStatusLine() });
  return { status: "installed", backup };
}

export type AntigravityUninstallOutcome =
  | "removed"
  | "not-installed"
  | Exclude<StatusLineOwner, "ours">;

/**
 * Remove the entry if it is wholly ours.
 *
 * Nothing is restored, because install never displaced anything: it writes only where the key
 * was empty. A command of the developer's that runs ours inside it comes back `nested` and is
 * left exactly as it is, as it is in Claude Code's file.
 */
export async function uninstallAntigravityStatusLine(
  path = ANTIGRAVITY_CLI_SETTINGS_PATH,
  backupDir = BACKUP_DIR,
): Promise<AntigravityUninstallOutcome> {
  const settings = await readSettings(path);
  if (settings === null) return "not-installed";

  const existing = settings["statusLine"];
  if (existing === undefined || existing === null) return "not-installed";
  const owner = statusLineOwner(existing);
  if (owner !== "ours") return owner;

  await backupSettings(path, backupDir, BACKUP_NAME);
  const next = { ...settings };
  delete next["statusLine"];
  await writeSettingsAtomically(path, next);
  return "removed";
}
