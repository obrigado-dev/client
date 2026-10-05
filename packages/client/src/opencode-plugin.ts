/**
 * Safe writer for OpenCode's documented TUI plugin list.
 *
 * OpenCode loads TUI plugins named in `tui.json`, so installation is one entry appended
 * to one array in one documented file. The rules are `statusline.ts`'s rules, for the
 * same reason (INVARIANT 11, §3):
 *
 *   1. Only the `plugin` array is ever touched. Every other key — `$schema`, `theme`,
 *      `keybinds`, anything the developer put there — is carried through untouched.
 *   2. No program file, binary or bundle is modified. Ever.
 *   3. Another tool's plugin entry is never removed or reordered. Ours is appended.
 *   4. The file is backed up before the write, so uninstall can restore by hand if it
 *      ever needs to.
 *   5. The write is atomic (temp file + rename): an interrupted install cannot leave
 *      OpenCode with a truncated config it refuses to start from.
 *   6. A file we cannot parse is a file we refuse to rewrite.
 */
import { existsSync } from "node:fs";
import { realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BACKUP_DIR, ensureDir } from "./config.ts";
import { isNewer, parseVersion } from "./release-assets.ts";

/**
 * OpenCode's config home.
 *
 * `XDG_CONFIG_HOME` is honoured because OpenCode honours it; hardcoding `~/.config`
 * would write to a directory the host never reads on a machine that sets it.
 */
const OPENCODE_CONFIG_HOME =
  process.env["OPENCODE_CONFIG"] ??
  join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "opencode");

/** Where the TUI plugin list lives. */
export const OPENCODE_TUI_CONFIG_PATH = join(OPENCODE_CONFIG_HOME, "tui.json");

const PACKAGE = "@obrigado/opencode-plugin";

/**
 * The plugin version this CLI release ships with. `test/opencode-plugin.test.ts` holds it to the
 * plugin's manifest, so a plugin release that forgets it fails the gate.
 */
export const OPENCODE_PLUGIN_VERSION = "0.2.0";

/**
 * What `tui.json` names for OpenCode to load: the package, at this release's version (A41).
 *
 * The package, not its `./tui` entry: OpenCode installs the spec with npm and then finds `./tui`
 * in the package's own `exports`. Given `@obrigado/opencode-plugin/tui`, npm's spec parser reads
 * a local directory rather than a package, the install fails without a word, and OpenCode loads
 * nothing (verified against OpenCode 1.18.34, `plugin/shared.ts`).
 *
 * At a version, because OpenCode never asks npm again about a plugin it has installed: its
 * `Npm.add` returns the cached copy whenever there is one (1.18.34, `core/src/npm.ts`), so an
 * unpinned spec stays on whatever version it first got, for good. A pin is its own install, so
 * moving the pin is how the plugin updates: install writes this one, and the CLI moves it forward
 * after it updates itself (`repairOpenCodePlugin`). A41 corrects A38, which said OpenCode would.
 */
export const OPENCODE_PLUGIN_SPEC = `${PACKAGE}@${OPENCODE_PLUGIN_VERSION}`;

/** What earlier installers wrote that OpenCode cannot load. Exact strings: see the spec above. */
const LEGACY_SPECS: ReadonlySet<string> = new Set([`${PACKAGE}/tui`]);

const SCHEMA_URL = "https://opencode.ai/tui.json";

type JsonObject = Record<string, unknown>;

/** Present on PATH, or its config home exists. */
export function opencodeDetected(): boolean {
  return Bun.which("opencode") !== null || existsSync(OPENCODE_CONFIG_HOME);
}

/**
 * Ours, in either the bare or the `[spec, options]` form the schema allows.
 *
 * Matching on the package name rather than the exact string means a developer who
 * pinned a version or passed options still gets a clean uninstall.
 */
function isOurPlugin(entry: unknown): boolean {
  const spec = specOf(entry);
  return typeof spec === "string" && spec.includes("@obrigado/opencode-plugin");
}

function specOf(entry: unknown): unknown {
  return Array.isArray(entry) ? entry[0] : entry;
}

/** The version an entry of ours is pinned to, or null for any other form. */
function pinnedVersion(entry: unknown): string | null {
  const spec = specOf(entry);
  if (typeof spec !== "string" || !spec.startsWith(`${PACKAGE}@`)) return null;
  const version = spec.slice(PACKAGE.length + 1);
  return parseVersion(version) === null ? null : version;
}

/** Pinned to this release's version or a later one: OpenCode has, or will install, a current copy. */
function isCurrentPlugin(entry: unknown): boolean {
  const pinned = pinnedVersion(entry);
  return pinned !== null && !isNewer(OPENCODE_PLUGIN_VERSION, pinned);
}

/**
 * An older form of ours, which this release rewrites: the `/tui` spec OpenCode cannot load, the
 * unpinned one it never updates, or a pin to an earlier version. Never a local path, which a
 * developer wrote on purpose, and never a later pin.
 */
function isStalePlugin(entry: unknown): boolean {
  const spec = specOf(entry);
  if (typeof spec !== "string") return false;
  if (LEGACY_SPECS.has(spec) || spec === PACKAGE) return true;
  const pinned = pinnedVersion(entry);
  return pinned !== null && isNewer(OPENCODE_PLUGIN_VERSION, pinned);
}

/**
 * The list with every stale entry gone and the current spec where the first of them stood, so
 * the developer's order is kept. Not added again where a current entry is already there, and an
 * entry's options travel with it.
 */
function withStaleReplaced(plugins: readonly unknown[]): unknown[] {
  let placed = plugins.some((entry) => isCurrentPlugin(entry));
  const out: unknown[] = [];
  for (const entry of plugins) {
    if (!isStalePlugin(entry)) out.push(entry);
    else if (!placed) {
      out.push(
        Array.isArray(entry) ? [OPENCODE_PLUGIN_SPEC, ...entry.slice(1)] : OPENCODE_PLUGIN_SPEC,
      );
      placed = true;
    }
  }
  return out;
}

export async function readTuiConfig(path = OPENCODE_TUI_CONFIG_PATH): Promise<JsonObject | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const text = await file.text();
  if (text.trim().length === 0) return {};

  // The schema permits comments and trailing commas. `JSON.parse` rejects both, and
  // that refusal is the right outcome: a config we cannot round-trip is one we would
  // have to rewrite from a lossy parse, silently deleting the developer's comments.
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object`);
  }
  return parsed as JsonObject;
}

function pluginList(document: JsonObject): unknown[] {
  const plugins = document["plugin"];
  if (plugins === undefined) return [];
  if (!Array.isArray(plugins)) throw new TypeError('OpenCode tui.json has a non-array "plugin"');
  return plugins;
}

export function hasOurPlugin(document: JsonObject | null): boolean {
  if (document === null) return false;
  try {
    return pluginList(document).some((entry) => isOurPlugin(entry));
  } catch {
    return false;
  }
}

async function backup(path: string, backupDir: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  await ensureDir(backupDir);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const destination = join(backupDir, `opencode-tui-${stamp}.json`);
  await Bun.write(destination, await file.text());
  return destination;
}

async function writeAtomic(path: string, document: JsonObject): Promise<void> {
  // Onto the resolved file, so a symlinked `tui.json` keeps its link. See `statusline.ts`.
  const target = await realpath(path).catch(() => path);
  await ensureDir(dirname(target));
  const temporary = `${target}.obrigado-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export type OpenCodeInstallOutcome =
  | { readonly status: "installed"; readonly backup: string | null }
  | { readonly status: "already-installed" };

export async function installOpenCodePlugin(
  path = OPENCODE_TUI_CONFIG_PATH,
  backupDir = BACKUP_DIR,
): Promise<OpenCodeInstallOutcome> {
  const document = (await readTuiConfig(path)) ?? {};
  const plugins = pluginList(document);
  const stale = plugins.some((entry) => isStalePlugin(entry));
  if (!stale && plugins.some((entry) => isOurPlugin(entry))) {
    return { status: "already-installed" };
  }

  const backupPath = await backup(path, backupDir);
  await writeAtomic(path, {
    // Added only when absent, so a developer who pinned a different schema keeps theirs.
    ...(document["$schema"] === undefined ? { $schema: SCHEMA_URL } : {}),
    ...document,
    // Appended, never prepended: another plugin that was already drawing gets to keep
    // its position, and ours registers at a late order anyway. A stale entry is replaced
    // where it stands instead.
    plugin: stale ? withStaleReplaced(plugins) : [...plugins, OPENCODE_PLUGIN_SPEC],
  });
  return { status: "installed", backup: backupPath };
}

export type OpenCodeRepairOutcome = "repaired" | "unchanged";

/**
 * Bring OpenCode's entry to this release's plugin: rewrite a stale form (`isStalePlugin`).
 *
 * Run after the CLI updates itself, as well as by `obrigado install`, because OpenCode installs a
 * new plugin version only when the pin moves (A41). It only replaces an entry that is there: a
 * developer who took ours out of the list is not given it back.
 */
export async function repairOpenCodePlugin(
  path = OPENCODE_TUI_CONFIG_PATH,
  backupDir = BACKUP_DIR,
): Promise<OpenCodeRepairOutcome> {
  const document = await readTuiConfig(path).catch(() => null);
  if (document === null) return "unchanged";

  let plugins: unknown[];
  try {
    plugins = pluginList(document);
  } catch {
    return "unchanged";
  }
  if (!plugins.some((entry) => isStalePlugin(entry))) return "unchanged";

  await backup(path, backupDir);
  await writeAtomic(path, { ...document, plugin: withStaleReplaced(plugins) });
  return "repaired";
}

export type OpenCodeUninstallOutcome = "removed" | "not-installed";

export async function uninstallOpenCodePlugin(
  path = OPENCODE_TUI_CONFIG_PATH,
  backupDir = BACKUP_DIR,
): Promise<OpenCodeUninstallOutcome> {
  const document = await readTuiConfig(path).catch(() => null);
  if (document === null) return "not-installed";

  let plugins: unknown[];
  try {
    plugins = pluginList(document);
  } catch {
    return "not-installed";
  }
  const kept = plugins.filter((entry) => !isOurPlugin(entry));
  if (kept.length === plugins.length) return "not-installed";

  await backup(path, backupDir);
  const next: JsonObject = { ...document };
  // An empty `plugin: []` is not the state the file was in before us, so the key goes
  // when nothing is left in it.
  if (kept.length === 0) delete next["plugin"];
  else next["plugin"] = kept;
  await writeAtomic(path, next);
  return "removed";
}
