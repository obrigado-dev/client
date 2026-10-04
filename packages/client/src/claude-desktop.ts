/**
 * Safe writer for the Claude desktop app's plugin settings (A37).
 *
 * The app runs Claude Code, and Claude Code installs a plugin that a settings file enables from
 * a marketplace that a settings file declares: once a session starts it clones the marketplace
 * and fetches the plugin in the background. So installing the mod is three documented keys in
 * the `~/.claude/settings.json` the status line already lives in, under `statusline.ts`'s rules:
 *
 *   1. Only our entries are written: `obrigado` under `extraKnownMarketplaces`,
 *      `obrigado@obrigado` under `enabledPlugins`, and `OBRIGADO_STATUSLINE_COMMAND` under
 *      `env`. Every other key, and every other entry of those three, is carried through.
 *   2. Another tool's entry under one of our names is never overwritten: install refuses.
 *   3. The file is backed up before the write, and the write is atomic.
 *   4. The marketplace is declared with `autoUpdate`, which Claude Code leaves off for every
 *      marketplace but Anthropic's own unless a settings entry turns it on (A38). Claude Code
 *      then fetches each release itself and says so: "Plugin updated: obrigado".
 *
 * The renderer is named in `env` because the app starts Claude Code with the PATH the app was
 * started with, which need not be the shell's: on a Mac opened from the Dock it lacked
 * `~/.local/bin`, where install.sh puts `obrigado`. The mod already reads that variable as its
 * override, and `env` reaches a plugin's processes, so the installer names the renderer by its
 * full path.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CLAUDE_SETTINGS_PATH } from "./config.ts";
import { absoluteRendererArgv } from "./renderer-command.ts";
import { backupSettings, readSettings, writeSettingsAtomically } from "./statusline.ts";
import type { SettingsObject } from "./statusline.ts";

/** The marketplace at the client repository's root, as `extraKnownMarketplaces` declares it. */
const CLAUDE_DESKTOP_MARKETPLACE = "obrigado";
const MARKETPLACE_SOURCE = { source: "github", repo: "obrigado-dev/client" } as const;

/** The plugin's id: the marketplace entry's name, then the marketplace's. */
export const CLAUDE_DESKTOP_PLUGIN_ID = `obrigado@${CLAUDE_DESKTOP_MARKETPLACE}`;

/** The mod's override for the renderer, the same variable every host's shim reads. */
const RENDERER_VARIABLE = "OBRIGADO_STATUSLINE_COMMAND";

/**
 * Where the app keeps the Claude Code it runs, present once its Code tab has been used.
 *
 * Seen on macOS. Elsewhere the app is not detected and `--agent claude-desktop` installs it.
 */
const APP_CLAUDE_CODE_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude-code",
);

export function claudeDesktopDetected(): boolean {
  return process.platform === "darwin" && existsSync(APP_CLAUDE_CODE_DIR);
}

/** The renderer command for the mod: full paths, quoted where `splitCommand` needs them. */
export function desktopRendererCommand(argv = absoluteRendererArgv()): string {
  return argv
    .map((part) => (/^[\w./:@%+=,-]+$/u.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

function objectAt(settings: SettingsObject, key: string): SettingsObject {
  const value = settings[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SettingsObject)
    : {};
}

/** `object` without `key`, leaving every other entry where it was. */
function without(object: SettingsObject, key: string): SettingsObject {
  return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
}

/** `settings` with `key` holding `value`, or with no `key` at all once `value` is empty. */
function withObject(settings: SettingsObject, key: string, value: SettingsObject): SettingsObject {
  return Object.keys(value).length === 0 ? without(settings, key) : { ...settings, [key]: value };
}

function isOurMarketplace(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const source = (entry as { source?: unknown }).source;
  return (
    typeof source === "object" &&
    source !== null &&
    (source as { source?: unknown }).source === MARKETPLACE_SOURCE.source &&
    (source as { repo?: unknown }).repo === MARKETPLACE_SOURCE.repo
  );
}

export type DesktopInstallOutcome =
  | { readonly status: "installed"; readonly backup: string | null }
  | { readonly status: "already-installed" }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Declare the marketplace, enable the plugin and name the renderer.
 *
 * `rendererCommand` is what to write, and `recorded` is what an earlier install wrote, so a
 * reinstall from a moved binary replaces our own value without mistaking it for a stranger's.
 */
export async function installClaudeDesktopPlugin(
  rendererCommand: string,
  recorded: string | undefined,
  path = CLAUDE_SETTINGS_PATH,
): Promise<DesktopInstallOutcome> {
  const settings = (await readSettings(path)) ?? {};
  const marketplaces = objectAt(settings, "extraKnownMarketplaces");
  const plugins = objectAt(settings, "enabledPlugins");
  const env = objectAt(settings, "env");

  const declared = marketplaces[CLAUDE_DESKTOP_MARKETPLACE];
  if (declared !== undefined && !isOurMarketplace(declared)) {
    return {
      status: "refused",
      reason: `another marketplace is already declared as "${CLAUDE_DESKTOP_MARKETPLACE}"`,
    };
  }
  const named = env[RENDERER_VARIABLE];
  if (named !== undefined && named !== recorded && named !== rendererCommand) {
    return { status: "refused", reason: `${RENDERER_VARIABLE} is already set in its env` };
  }
  if (
    isOurMarketplace(declared) &&
    (declared as { autoUpdate?: unknown }).autoUpdate === true &&
    plugins[CLAUDE_DESKTOP_PLUGIN_ID] === true &&
    named === rendererCommand
  ) {
    return { status: "already-installed" };
  }

  const backup = await backupSettings(path);
  await writeSettingsAtomically(path, {
    ...settings,
    extraKnownMarketplaces: {
      ...marketplaces,
      [CLAUDE_DESKTOP_MARKETPLACE]: { source: { ...MARKETPLACE_SOURCE }, autoUpdate: true },
    },
    enabledPlugins: { ...plugins, [CLAUDE_DESKTOP_PLUGIN_ID]: true },
    env: { ...env, [RENDERER_VARIABLE]: rendererCommand },
  });
  return { status: "installed", backup };
}

export type DesktopUninstallOutcome = "removed" | "not-installed";

/**
 * Turn the plugin off and take back what install wrote.
 *
 * Disabled rather than deleted from `enabledPlugins`: a plugin Claude Code has installed starts
 * enabled when settings name it nowhere, so only an explicit `false` is sure to keep it off. The
 * marketplace and the renderer are removed only where they are still ours.
 */
export async function uninstallClaudeDesktopPlugin(
  recorded: string | undefined,
  path = CLAUDE_SETTINGS_PATH,
): Promise<DesktopUninstallOutcome> {
  const settings = await readSettings(path);
  if (settings === null) return "not-installed";
  const marketplaces = objectAt(settings, "extraKnownMarketplaces");
  const plugins = objectAt(settings, "enabledPlugins");
  const env = objectAt(settings, "env");

  const ours = isOurMarketplace(marketplaces[CLAUDE_DESKTOP_MARKETPLACE]);
  if (!ours && plugins[CLAUDE_DESKTOP_PLUGIN_ID] !== true) return "not-installed";

  await backupSettings(path);
  let next: SettingsObject = {
    ...settings,
    enabledPlugins: { ...plugins, [CLAUDE_DESKTOP_PLUGIN_ID]: false },
  };
  if (ours) {
    next = withObject(
      next,
      "extraKnownMarketplaces",
      without(marketplaces, CLAUDE_DESKTOP_MARKETPLACE),
    );
  }
  if (recorded !== undefined && env[RENDERER_VARIABLE] === recorded) {
    next = withObject(next, "env", without(env, RENDERER_VARIABLE));
  }
  await writeSettingsAtomically(path, next);
  return "removed";
}
