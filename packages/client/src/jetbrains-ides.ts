/**
 * The JetBrains IDEs on this machine, and where each keeps its settings and plugins (A43).
 *
 * Every IntelliJ-platform IDE ships a `product-info.json` saying what it is: its name and build,
 * the vendor and data directory its settings live under, and the launcher that runs it. That file
 * is what is looked for, in the places the IDEs' own installers and the Toolbox App put them, so a
 * JetBrains IDE this file has never heard of is found like the rest.
 *
 * The directories are the ones JetBrains documents ("Directories used by the IDE to store
 * settings, caches, plugins and logs"), under the IDE's own vendor folder: `Google` for Android
 * Studio. A developer who moved them with `idea.config.path` or `idea.plugins.path` is not
 * followed there. On Windows they are under `%APPDATA%`, plugins inside the settings (A46).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface JetBrainsIde {
  /** What it calls itself: "IntelliJ IDEA", "PyCharm", "Android Studio". */
  readonly name: string;
  /** `IU`, `PY`, `AI`: what its builds are prefixed with. */
  readonly productCode: string;
  /** `251.23774.435`, the platform's branch first. */
  readonly build: string;
  /** `JetBrains`, or `Google` for Android Studio: the folder its directories sit in. */
  readonly vendor: string;
  /** `IntelliJIdea2025.1`: names its configuration and plugins directories. */
  readonly dataDirectory: string;
  /** The program that runs it, which also takes `installPlugins`. */
  readonly launcher: string;
}

/** The machine as these lookups see it, passed in so a test can stand up its own. */
export interface Machine {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function thisMachine(): Machine {
  return { platform: process.platform, arch: process.arch, home: homedir(), env: process.env };
}

/**
 * The oldest platform the plugin claims: `sinceBuild` in the plugin's `build.gradle.kts`, and the
 * release that build is. `jetbrains-ides.test.ts` holds both to the plugin's build.
 */
export const SINCE_BUILD = 251;
export const SINCE_RELEASE = "2025.1";

/**
 * Whether this command runs in a JetBrains IDE's own terminal, which every IDE marks with
 * `TERMINAL_EMULATOR=JetBrains-JediTerm`. Such a terminal closes with its IDE, and an IDE takes the
 * plugin only while it is closed, so the install has to be run again from somewhere else.
 */
export function inJetBrainsTerminal(machine: Machine): boolean {
  return machine.env["TERMINAL_EMULATOR"] === "JetBrains-JediTerm";
}

/** Thin clients for an IDE that runs elsewhere: nothing renders in them. */
const THIN_CLIENTS = new Set(["GW", "JBC"]);

/** What `product-info.json` calls each architecture this client is built for. */
const ARCH: Readonly<Record<string, readonly string[]>> = {
  arm64: ["aarch64", "arm64"],
  x64: ["amd64", "x86_64", "x64"],
};

function setting(env: Machine["env"], name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** `%APPDATA%`, where a Windows IDE keeps its settings and plugins. */
function roaming(machine: Machine): string {
  return setting(machine.env, "APPDATA") ?? join(machine.home, "AppData", "Roaming");
}

/** Where IDEs are installed, and how far below each folder one can sit. */
function installRoots(machine: Machine): ReadonlyArray<readonly [string, number]> {
  const { home } = machine;
  if (machine.platform === "win32") {
    const local = setting(machine.env, "LOCALAPPDATA") ?? join(home, "AppData", "Local");
    const programs = setting(machine.env, "ProgramFiles") ?? "C:\\Program Files";
    return [
      // The installers' default, Program Files\JetBrains\<name>, and Android Studio's beside it.
      [join(programs, "JetBrains"), 1],
      [join(programs, "Android"), 1],
      // The Toolbox App's since its second version, Programs\<name>, and a per-user install's.
      [join(local, "Programs"), 2],
      // The Toolbox App's first version: apps\<code>\ch-0\<build>.
      [join(local, "JetBrains", "Toolbox", "apps"), 3],
    ];
  }
  if (machine.platform === "darwin") {
    return [
      ["/Applications", 1],
      // The Toolbox App's default, and the "JetBrains Toolbox" folder its first version used.
      [join(home, "Applications"), 2],
      // That first version's own copies: apps/<code>/ch-0/<build>/<name>.app.
      [join(home, "Library/Application Support/JetBrains/Toolbox/apps"), 4],
    ];
  }
  if (machine.platform !== "linux") return [];
  const data = setting(machine.env, "XDG_DATA_HOME") ?? join(home, ".local/share");
  return [
    // apps/<name> since Toolbox 2, apps/<code>/ch-0/<build> before it.
    [join(data, "JetBrains/Toolbox/apps"), 3],
    ["/opt", 1],
    ["/usr/local", 1],
    [home, 1],
    // /snap/<name>/current.
    ["/snap", 2],
  ];
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()),
      )
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function productInfoIn(dir: string): string | null {
  const file = dir.endsWith(".app")
    ? join(dir, "Contents/Resources/product-info.json")
    : join(dir, "product-info.json");
  return existsSync(file) ? file : null;
}

/** Every `product-info.json` within `depth` folders of `root`, not looking inside an IDE. */
function productInfos(root: string, depth: number): string[] {
  const found: string[] = [];
  let level = [root];
  for (let step = 0; step < depth && level.length > 0; step += 1) {
    const next: string[] = [];
    for (const dir of level) {
      for (const child of subdirectories(dir)) {
        const file = productInfoIn(child);
        if (file !== null) found.push(file);
        else if (!child.endsWith(".app")) next.push(child);
      }
    }
    level = next;
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What `product-info.json` calls each operating system. */
const OS_NAME: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** The launcher this machine runs, by the `launch` entry for its operating system. */
function launcherOf(info: Record<string, unknown>, file: string, machine: Machine): string | null {
  const os = OS_NAME[machine.platform];
  const entries = (Array.isArray(info["launch"]) ? info["launch"] : [])
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => entry["os"] === os && typeof entry["launcherPath"] === "string");
  const archNames = ARCH[machine.arch] ?? [];
  const entry =
    entries.find((candidate) => archNames.includes(String(candidate["arch"]))) ?? entries[0];
  if (entry === undefined) return null;
  const launcher = resolve(dirname(file), String(entry["launcherPath"]));
  return existsSync(launcher) ? launcher : null;
}

function readProductInfo(file: string, machine: Machine): JetBrainsIde | null {
  let info: unknown;
  try {
    info = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(info)) return null;
  const { name, buildNumber, productCode, dataDirectoryName, productVendor } = info;
  if (
    typeof name !== "string" ||
    typeof buildNumber !== "string" ||
    typeof productCode !== "string" ||
    typeof dataDirectoryName !== "string"
  ) {
    return null;
  }
  const launcher = launcherOf(info, file, machine);
  if (launcher === null) return null;
  return {
    name,
    productCode,
    build: buildNumber,
    vendor: typeof productVendor === "string" ? productVendor : "JetBrains",
    dataDirectory: dataDirectoryName,
    launcher,
  };
}

/**
 * The IDEs here, one per data directory: two installs of one version share their settings and
 * plugins, so installing into either is installing into both.
 */
export function jetbrainsIdes(
  machine: Machine = thisMachine(),
  roots: ReadonlyArray<readonly [string, number]> = installRoots(machine),
): JetBrainsIde[] {
  const byDirectory = new Map<string, JetBrainsIde>();
  for (const [root, depth] of roots) {
    for (const file of productInfos(root, depth)) {
      const ide = readProductInfo(file, machine);
      if (ide === null || THIN_CLIENTS.has(ide.productCode)) continue;
      const key = `${ide.vendor}/${ide.dataDirectory}`;
      if (!byDirectory.has(key)) byDirectory.set(key, ide);
    }
  }
  return [...byDirectory.values()].toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.dataDirectory.localeCompare(b.dataDirectory),
  );
}

/** Where its settings live, and its custom `idea.properties` with them. */
export function configDirectory(ide: JetBrainsIde, machine: Machine): string {
  if (machine.platform === "darwin") {
    return join(machine.home, "Library/Application Support", ide.vendor, ide.dataDirectory);
  }
  if (machine.platform === "win32") return join(roaming(machine), ide.vendor, ide.dataDirectory);
  const config = setting(machine.env, "XDG_CONFIG_HOME") ?? join(machine.home, ".config");
  return join(config, ide.vendor, ide.dataDirectory);
}

/** Where its plugins are unpacked: inside the settings on macOS and Windows, beside them on Linux. */
export function pluginsDirectory(ide: JetBrainsIde, machine: Machine): string {
  if (machine.platform === "darwin" || machine.platform === "win32") {
    return join(configDirectory(ide, machine), "plugins");
  }
  const data = setting(machine.env, "XDG_DATA_HOME") ?? join(machine.home, ".local/share");
  return join(data, ide.vendor, ide.dataDirectory);
}

/**
 * Whether the plugin can go in now.
 *
 * `never-opened` is an IDE with no settings yet. Installing into it would create them, and an IDE
 * that finds settings on its first start does not offer to import the previous version's.
 */
export type IdeReadiness = "ready" | "too-old" | "never-opened";

export function readiness(ide: JetBrainsIde, machine: Machine): IdeReadiness {
  if (Number(ide.build.split(".")[0]) < SINCE_BUILD) return "too-old";
  return existsSync(join(configDirectory(ide, machine), "options")) ? "ready" : "never-opened";
}
