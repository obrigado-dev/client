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
import { rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BACKUP_DIR, ensureDir } from "./config.ts";

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

/** The published entry point OpenCode resolves and loads. */
export const OPENCODE_PLUGIN_SPEC = "@obrigado/opencode-plugin/tui";

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
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return typeof spec === "string" && spec.includes("@obrigado/opencode-plugin");
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
  await ensureDir(dirname(path));
  const temporary = `${path}.obrigado-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
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
  if (plugins.some((entry) => isOurPlugin(entry))) return { status: "already-installed" };

  const backupPath = await backup(path, backupDir);
  await writeAtomic(path, {
    // Added only when absent, so a developer who pinned a different schema keeps theirs.
    ...(document["$schema"] === undefined ? { $schema: SCHEMA_URL } : {}),
    ...document,
    // Appended, never prepended: another plugin that was already drawing gets to keep
    // its position, and ours registers at a late order anyway.
    plugin: [...plugins, OPENCODE_PLUGIN_SPEC],
  });
  return { status: "installed", backup: backupPath };
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
