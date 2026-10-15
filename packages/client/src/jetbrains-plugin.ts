/**
 * The JetBrains plugin, put into an IDE by the IDE's own installer (A43).
 *
 * Every IntelliJ-platform IDE takes `installPlugins <id> <repository>` on its command line: it
 * starts without a window, fetches the plugin from the repository, unpacks it into its plugins
 * directory, and exits 0 once the plugin is there. JetBrains documents it with the IDE closed, and
 * an open one refuses ("Only one instance of … can be run at a time") having written nothing.
 *
 * That install does not remember the repository, and a plugin from a custom repository updates
 * only from a repository the IDE knows. So the repository also goes into `idea.plugin.hosts` in
 * the IDE's custom `idea.properties`, the setting JetBrains documents for exactly this (Help →
 * Edit Custom Properties), and the IDE offers new versions from there as it does from the
 * Marketplace. The IDE asks the developer to approve the plugin when it next starts: nothing here
 * passes `--give-consent-to-use-third-party-plugins`.
 */
import { readdirSync } from "node:fs";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "./config.ts";
import type { Ran } from "./editor-extension.ts";
import { configDirectory, pluginsDirectory } from "./jetbrains-ides.ts";
import type { JetBrainsIde, Machine } from "./jetbrains-ides.ts";

/** `<id>` in the plugin's `plugin.xml`, which the repository lists it under. */
export const PLUGIN_ID = "dev.obrigado";

/** The folder the plugin's zip unpacks to, with `lib/obrigado-jetbrains-<version>.jar` inside. */
const PLUGIN_FOLDER = "obrigado-jetbrains";

const HOSTS_KEY = "idea.plugin.hosts";
const HOSTS_LINE = /^\s*idea\.plugin\.hosts(?:\s*[=:]\s*|\s+)(.*)$/u;

/** Put above a line this adds, and taken out with it. */
export const HOSTS_COMMENT =
  "# Added by obrigado install: the Obrigado plugin updates from here. obrigado uninstall removes it.";

/** A start that takes longer than this is not going to finish. */
const LAUNCH_TIMEOUT_MS = 180_000;

/** An IDE that is running, or still starting, says so rather than installing. */
const OPEN = /only one instance|not been initialized/iu;

export function repositoryUrl(origin: string): string {
  return `${origin}/jetbrains/updatePlugins.xml`;
}

/** The plugin's version in this plugins directory, from its jar's name, or null if it is not there. */
export function installedPluginVersion(pluginsDir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(join(pluginsDir, PLUGIN_FOLDER, "lib"));
  } catch {
    return null;
  }
  for (const name of names) {
    const version = /^obrigado-jetbrains-(.+)\.jar$/u.exec(name)?.[1];
    if (version !== undefined) return version;
  }
  return null;
}

/** The last line that sets the hosts: the one `Properties.load` keeps. */
function hostsLineIndex(lines: readonly string[]): number {
  return lines.findLastIndex((line) => HOSTS_LINE.test(line));
}

/** A line ending in an odd number of backslashes runs on into the next. */
function continues(line: string): boolean {
  return (/\\+$/u.exec(line)?.[0].length ?? 0) % 2 === 1;
}

function hostsOf(line: string): string[] {
  return (HOSTS_LINE.exec(line)?.[1] ?? "")
    .split(";")
    .map((host) => host.trim())
    .filter((host) => host !== "");
}

/**
 * `text`, a properties file, with `url` among its plugin hosts: unchanged when it is already
 * there, and null when the hosts line runs on over several lines, which this does not edit.
 */
export function withRepository(text: string, url: string): string | null {
  const lines = text.split("\n");
  const index = hostsLineIndex(lines);
  if (index === -1) {
    const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}${HOSTS_COMMENT}\n${HOSTS_KEY}=${url}\n`;
  }
  const line = lines[index] ?? "";
  if (continues(line)) return null;
  const hosts = hostsOf(line);
  if (hosts.includes(url)) return text;
  lines[index] = `${HOSTS_KEY}=${[...hosts, url].join(";")}`;
  return lines.join("\n");
}

/** `text` without `url` among its plugin hosts, and without the line and comment if it was alone. */
export function withoutRepository(text: string, url: string): string {
  const lines = text.split("\n");
  const index = hostsLineIndex(lines);
  const line = lines[index] ?? "";
  if (index === -1 || continues(line)) return text;
  const hosts = hostsOf(line);
  if (!hosts.includes(url)) return text;
  const rest = hosts.filter((host) => host !== url);
  if (rest.length > 0) {
    lines[index] = `${HOSTS_KEY}=${rest.join(";")}`;
    return lines.join("\n");
  }
  const start = index > 0 && lines[index - 1] === HOSTS_COMMENT ? index - 1 : index;
  lines.splice(start, index - start + 1);
  return lines.join("\n");
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function backup(ide: JetBrainsIde, text: string, dir: string): Promise<string> {
  await ensureDir(dir);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const destination = join(dir, `jetbrains-${ide.dataDirectory}-idea-${stamp}.properties`);
  await writeFile(destination, text, { mode: 0o600 });
  return destination;
}

/** Onto the resolved file, so a symlinked one keeps its link. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const target = await realpath(path).catch(() => path);
  const temporary = `${target}.obrigado-${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o644 });
  await rename(temporary, target);
}

/**
 * The IDE's custom properties, changed by `edit`, backed up first when there were any. Null when
 * `edit` refused, and the file is left as it was.
 */
async function editProperties(
  ide: JetBrainsIde,
  machine: Machine,
  backupDir: string,
  edit: (text: string) => string | null,
): Promise<{ readonly changed: boolean; readonly backup: string | null } | null> {
  const path = join(configDirectory(ide, machine), "idea.properties");
  const before = await readText(path);
  const after = edit(before ?? "");
  if (after === null) return null;
  if (after === (before ?? "")) return { changed: false, backup: null };
  const saved = before === null ? null : await backup(ide, before, backupDir);
  await writeAtomic(path, after);
  return { changed: true, backup: saved };
}

export async function runLauncher(argv: readonly string[]): Promise<Ran> {
  const proc = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    // The IDE logs to stderr at length; what it has to say about the install is on stdout.
    stderr: "ignore",
    timeout: LAUNCH_TIMEOUT_MS,
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (proc.signalCode !== null) {
    return { code: -1, stdout: `${stdout}\ndid not finish in ${LAUNCH_TIMEOUT_MS / 1000} seconds` };
  }
  return { code, stdout };
}

export interface PluginDeps {
  readonly run: (argv: readonly string[]) => Promise<Ran>;
  /** The server whose repository the IDE installs and updates from. */
  readonly origin: string;
  readonly machine: Machine;
  readonly backupDir: string;
}

export type PluginOutcome =
  | {
      readonly status: "installed" | "already-installed";
      /** Null when the IDE keeps its plugins somewhere other than where JetBrains documents. */
      readonly version: string | null;
      /** Whether the IDE will take updates from the repository: false when it could not be added. */
      readonly updates: boolean;
      readonly backup: string | null;
    }
  /** Open is an IDE that is running, and refused; failed is anything else it said. */
  | { readonly status: "open"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/** What the IDE said last, which is why it did not install. */
function refusal(ran: Ran): PluginOutcome {
  const lines = ran.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const reason = lines.at(-1) ?? `it exited with ${ran.code}`;
  return { status: OPEN.test(ran.stdout) ? "open" : "failed", reason };
}

/**
 * The plugin in `ide`, and its repository among the IDE's plugin hosts.
 *
 * A plugin already in the IDE's plugins directory is left to the IDE, which updates it, and the
 * IDE is not started: that also leaves an IDE that is open alone.
 */
export async function installJetBrainsPlugin(
  ide: JetBrainsIde,
  deps: PluginDeps,
): Promise<PluginOutcome> {
  const plugins = pluginsDirectory(ide, deps.machine);
  const url = repositoryUrl(deps.origin);
  const found = installedPluginVersion(plugins);
  if (found === null) {
    const ran = await deps.run([ide.launcher, "installPlugins", PLUGIN_ID, url]);
    if (ran.code !== 0) return refusal(ran);
  }
  const edited = await editProperties(ide, deps.machine, deps.backupDir, (text) =>
    withRepository(text, url),
  );
  return {
    status: found === null ? "installed" : "already-installed",
    version: found ?? installedPluginVersion(plugins),
    updates: edited !== null,
    backup: edited?.backup ?? null,
  };
}

/** Takes the repository back out of the IDE's plugin hosts. Whether there was one to take out. */
export async function removeJetBrainsRepository(
  ide: JetBrainsIde,
  deps: Omit<PluginDeps, "run">,
): Promise<boolean> {
  const url = repositoryUrl(deps.origin);
  const edited = await editProperties(ide, deps.machine, deps.backupDir, (text) =>
    withoutRepository(text, url),
  );
  return edited?.changed === true;
}
