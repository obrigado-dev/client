/**
 * Safe writer for OpenCode's documented TUI plugin lists.
 *
 * OpenCode 1 loads TUI plugins named in `tui.json`'s `plugin`. OpenCode 2 loads those named in
 * `cli.json`'s `plugins`, which it fills from `tui.json` once, the first time it runs, and never
 * reads `tui.json` again (2.0.29, `cli/src/config/migrate.ts`). So installation is one entry in
 * each list OpenCode reads. The rules are `statusline.ts`'s rules, for the same reason
 * (INVARIANT 11, §3):
 *
 *   1. Only the plugin list is ever touched. Every other key — `$schema`, `theme`,
 *      `keybinds`, anything the developer put there — is carried through untouched.
 *   2. No program file, binary or bundle is modified. Ever.
 *   3. Another tool's plugin entry is never removed or reordered. Ours is appended.
 *   4. The file is backed up before the write, so uninstall can restore by hand if it
 *      ever needs to.
 *   5. The write is atomic (temp file + rename): an interrupted install cannot leave
 *      OpenCode with a truncated config it refuses to start from.
 *   6. A file we cannot parse is a file we refuse to rewrite.
 *   7. `cli.json` is written only once OpenCode 2 has made it. Creating it first would stop
 *      OpenCode 2 from carrying the developer's `tui.json` over, theme, keys and every other
 *      plugin with it; left to OpenCode, the carrying-over brings our entry along.
 */
import { existsSync } from "node:fs";
import { realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { BACKUP_DIR, ensureDir } from "./config.ts";
import { isNewer, parseVersion } from "./release-assets.ts";

/**
 * OpenCode's config home.
 *
 * `XDG_CONFIG_HOME` is honoured because OpenCode honours it; hardcoding `~/.config`
 * would write to a directory the host never reads on a machine that sets it.
 */
const XDG_OPENCODE = join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "opencode");
const OPENCODE_CONFIG_HOME = process.env["OPENCODE_CONFIG"] ?? XDG_OPENCODE;

/** The two files this module writes: one per OpenCode major. */
export interface OpenCodeConfigPaths {
  /** OpenCode 1's TUI plugin list. */
  readonly tui: string;
  /** OpenCode 2's, in its config directory: `OPENCODE_CONFIG_DIR` when set, else the XDG one. */
  readonly cli: string;
}

const OPENCODE_CONFIG_PATHS: OpenCodeConfigPaths = {
  tui: join(OPENCODE_CONFIG_HOME, "tui.json"),
  // 2.0.29, `util/src/global.ts`.
  cli: join(process.env["OPENCODE_CONFIG_DIR"] ?? XDG_OPENCODE, "cli.json"),
};

const PACKAGE = "@obrigado/opencode-plugin";

/**
 * The plugin version this CLI release ships with. `test/opencode-plugin.test.ts` holds it to the
 * plugin's manifest, so a plugin release that forgets it fails the gate.
 */
export const OPENCODE_PLUGIN_VERSION = "0.4.0";

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
 * OpenCode 2 installs and caches the same way (2.0.29, `util/src/npm.ts`), so the same pin serves
 * its list (A42).
 */
export const OPENCODE_PLUGIN_SPEC = `${PACKAGE}@${OPENCODE_PLUGIN_VERSION}`;

/** What earlier installers wrote that OpenCode cannot load. Exact strings: see the spec above. */
const LEGACY_SPECS: ReadonlySet<string> = new Set([`${PACKAGE}/tui`]);

type JsonObject = Record<string, unknown>;

/**
 * One of OpenCode's plugin lists: its file and the key the list sits under.
 *
 * An entry is a spec in both, or a spec with options: `[spec, options]` in OpenCode 1 and
 * `{ package, options }` in OpenCode 2. A string that names no package — OpenCode 2's `-id`
 * that turns a plugin off, or the id of a built-in — is never ours, and is left alone.
 */
interface PluginList {
  readonly path: string;
  readonly key: "plugin" | "plugins";
  /** Named in a new or schema-less file. Only `tui.json`: `cli.json` is OpenCode 2's to make. */
  readonly schema?: string;
}

function pluginLists(paths: OpenCodeConfigPaths): readonly [PluginList, PluginList] {
  return [
    { path: paths.tui, key: "plugin", schema: "https://opencode.ai/tui.json" },
    { path: paths.cli, key: "plugins" },
  ];
}

/** Present on PATH, or its config home exists. */
export function opencodeDetected(): boolean {
  return Bun.which("opencode") !== null || existsSync(OPENCODE_CONFIG_HOME);
}

/**
 * Ours, in any of the forms either schema allows.
 *
 * Matching on the package name rather than the exact string means a developer who
 * pinned a version or passed options still gets a clean uninstall.
 */
function isOurPlugin(entry: unknown): boolean {
  const spec = specOf(entry);
  return typeof spec === "string" && spec.includes("@obrigado/opencode-plugin");
}

function specOf(entry: unknown): unknown {
  if (Array.isArray(entry)) return entry[0];
  if (typeof entry === "object" && entry !== null && "package" in entry) return entry.package;
  return entry;
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

/** A stale entry of ours brought to the current spec, in the form it was written in. */
function current(entry: unknown): unknown {
  if (Array.isArray(entry)) return [OPENCODE_PLUGIN_SPEC, ...entry.slice(1)];
  if (typeof entry === "object" && entry !== null)
    return { ...entry, package: OPENCODE_PLUGIN_SPEC };
  return OPENCODE_PLUGIN_SPEC;
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
      out.push(current(entry));
      placed = true;
    }
  }
  return out;
}

/** One of OpenCode's config files, or null when there is none. */
async function readConfigFile(path: string): Promise<JsonObject | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const text = await file.text();
  if (text.trim().length === 0) return {};

  // The schema permits comments and trailing commas. `JSON.parse` rejects both, and
  // that refusal is the right outcome: a config we cannot round-trip is one we would
  // have to rewrite from a lossy parse, silently deleting the developer's comments.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not plain JSON, so it was left as it was`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object`);
  }
  return parsed as JsonObject;
}

function pluginList(document: JsonObject, list: PluginList): unknown[] {
  const plugins = document[list.key];
  if (plugins === undefined) return [];
  if (!Array.isArray(plugins)) {
    throw new TypeError(`OpenCode ${basename(list.path)} has a non-array "${list.key}"`);
  }
  return plugins;
}

/** A list read and checked, ready to be rewritten. */
interface Loaded {
  readonly list: PluginList;
  readonly document: JsonObject;
  readonly plugins: unknown[];
}

/** A list as it stands, or null when its file is missing or is not one we would rewrite. */
async function readList(list: PluginList): Promise<Loaded | null> {
  try {
    const document = await readConfigFile(list.path);
    return document === null ? null : { list, document, plugins: pluginList(document, list) };
  } catch {
    return null;
  }
}

/** The files, of the two, whose list carries an entry of ours. */
export async function openCodePluginFiles(
  paths: OpenCodeConfigPaths = OPENCODE_CONFIG_PATHS,
): Promise<string[]> {
  const loaded = await Promise.all(pluginLists(paths).map((list) => readList(list)));
  return loaded.flatMap((item) =>
    item !== null && item.plugins.some((entry) => isOurPlugin(entry)) ? [item.list.path] : [],
  );
}

async function backup(path: string, backupDir: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  await ensureDir(backupDir);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const destination = join(backupDir, `opencode-${basename(path, ".json")}-${stamp}.json`);
  await Bun.write(destination, await file.text());
  return destination;
}

async function writeAtomic(path: string, document: JsonObject): Promise<void> {
  // Onto the resolved file, so a symlinked config keeps its link. See `statusline.ts`.
  const target = await realpath(path).catch(() => path);
  await ensureDir(dirname(target));
  const temporary = `${target}.obrigado-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export type OpenCodeInstallOutcome =
  | {
      readonly status: "installed";
      readonly backups: readonly string[];
      /** Every file whose list now carries ours. */
      readonly files: readonly string[];
    }
  | { readonly status: "already-installed"; readonly files: readonly string[] };

/**
 * Both lists, read and checked before either is written, so a file that cannot be parsed stops
 * the install instead of leaving it half done. A missing `tui.json` is an empty one; a missing
 * `cli.json` stays missing (rule 7).
 */
async function loadForInstall(paths: OpenCodeConfigPaths): Promise<Loaded[]> {
  const [tui, cli] = pluginLists(paths);
  const [tuiDocument, cliDocument] = await Promise.all([
    readConfigFile(tui.path),
    readConfigFile(cli.path),
  ]);
  const found = [
    { list: tui, document: tuiDocument ?? {} },
    ...(cliDocument === null ? [] : [{ list: cli, document: cliDocument }]),
  ];
  return found.map(({ list, document }) => ({
    list,
    document,
    plugins: pluginList(document, list),
  }));
}

/** Ours written into one list: the backup taken, or false when it was already there. */
async function installInto(
  { list, document, plugins }: Loaded,
  backupDir: string,
): Promise<{ readonly backup: string | null } | false> {
  const stale = plugins.some((entry) => isStalePlugin(entry));
  if (!stale && plugins.some((entry) => isOurPlugin(entry))) return false;

  const backupPath = await backup(list.path, backupDir);
  await writeAtomic(list.path, {
    // Added only when absent, so a developer who pinned a different schema keeps theirs.
    ...(list.schema === undefined || document["$schema"] !== undefined
      ? {}
      : { $schema: list.schema }),
    ...document,
    // Appended, never prepended: another plugin that was already drawing gets to keep
    // its position, and in OpenCode 1 ours registers at a late order anyway. A stale entry
    // is replaced where it stands instead.
    [list.key]: stale ? withStaleReplaced(plugins) : [...plugins, OPENCODE_PLUGIN_SPEC],
  });
  return { backup: backupPath };
}

export async function installOpenCodePlugin(
  paths: OpenCodeConfigPaths = OPENCODE_CONFIG_PATHS,
  backupDir = BACKUP_DIR,
): Promise<OpenCodeInstallOutcome> {
  const loaded = await loadForInstall(paths);
  const written = await Promise.all(loaded.map((item) => installInto(item, backupDir)));
  const files = loaded.map(({ list }) => list.path);
  if (!written.some((result) => result !== false)) return { status: "already-installed", files };
  const backups = written.flatMap((result) =>
    result === false || result.backup === null ? [] : [result.backup],
  );
  return { status: "installed", backups, files };
}

export type OpenCodeRepairOutcome = "repaired" | "unchanged";

/** One list's stale entry rewritten (`isStalePlugin`): true when there was one. */
async function repairIn(list: PluginList, backupDir: string): Promise<boolean> {
  const loaded = await readList(list);
  if (loaded === null || !loaded.plugins.some((entry) => isStalePlugin(entry))) return false;
  await backup(list.path, backupDir);
  await writeAtomic(list.path, {
    ...loaded.document,
    [list.key]: withStaleReplaced(loaded.plugins),
  });
  return true;
}

/**
 * Bring OpenCode's entries to this release's plugin: rewrite a stale form (`isStalePlugin`).
 *
 * Run after the CLI updates itself, as well as by `obrigado install`, because OpenCode installs a
 * new plugin version only when the pin moves (A41). It only replaces an entry that is there: a
 * developer who took ours out of a list is not given it back. Each file is its own repair, so
 * one that cannot be read leaves the other to be brought forward.
 */
export async function repairOpenCodePlugin(
  paths: OpenCodeConfigPaths = OPENCODE_CONFIG_PATHS,
  backupDir = BACKUP_DIR,
): Promise<OpenCodeRepairOutcome> {
  const repaired = await Promise.all(pluginLists(paths).map((list) => repairIn(list, backupDir)));
  return repaired.includes(true) ? "repaired" : "unchanged";
}

export type OpenCodeUninstallOutcome = "removed" | "not-installed";

/** Every entry of ours taken out of one list: true when there was one. */
async function removeFrom(list: PluginList, backupDir: string): Promise<boolean> {
  const loaded = await readList(list);
  if (loaded === null) return false;
  const kept = loaded.plugins.filter((entry) => !isOurPlugin(entry));
  if (kept.length === loaded.plugins.length) return false;

  await backup(list.path, backupDir);
  const next: JsonObject = { ...loaded.document };
  // An empty list is not the state the file was in before us, so the key goes
  // when nothing is left in it.
  if (kept.length === 0) delete next[list.key];
  else next[list.key] = kept;
  await writeAtomic(list.path, next);
  return true;
}

export async function uninstallOpenCodePlugin(
  paths: OpenCodeConfigPaths = OPENCODE_CONFIG_PATHS,
  backupDir = BACKUP_DIR,
): Promise<OpenCodeUninstallOutcome> {
  const removed = await Promise.all(pluginLists(paths).map((list) => removeFrom(list, backupDir)));
  return removed.includes(true) ? "removed" : "not-installed";
}
