/**
 * The plugin repository the CLI keeps on this machine for the JetBrains IDEs (A43).
 *
 * An IDE pointed at obrigado.dev's repository downloads the plugin itself, and nothing checks
 * those bytes against the release's signed checksums: whoever answered for obrigado.dev would
 * choose the code that runs inside the IDE. So the CLI fetches the release's zip the way it fetches
 * the `.vsix` (`verifiedAsset`), keeps it in `~/.obrigado/jetbrains` beside an `updatePlugins.xml`
 * that names it by a `file:` URL, and points each IDE there. The IDE installs and updates from
 * bytes already checked, and obrigado.dev only counts the download on its way past.
 *
 * The daily update puts the next release's zip in, and the IDE offers it at its next update
 * check. Read from the release's signed `editors.json` too, so the range of IDE builds the feed
 * claims is the one the plugin was built for.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ensureDir, OBRIGADO_DIR } from "./config.ts";
import { latestReleaseTag, verifiedAsset } from "./release-assets.ts";
import type { ReleaseDeps } from "./release-assets.ts";

export const JETBRAINS_REPOSITORY_DIR = join(OBRIGADO_DIR, "jetbrains");

const FEED = "updatePlugins.xml";
const BUILD = /^\d{3}(?:\.\d+)*(?:\.\*)?$/u;

export interface RepositoryDeps extends ReleaseDeps {
  /** obrigado.dev, which counts the download and redirects it to the release. */
  readonly origin: string;
  readonly repositoryDir: string;
}

/** The URL an IDE is given for the repository: the same file, whichever release is in it. */
export function localRepositoryUrl(dir: string): string {
  return pathToFileURL(join(dir, FEED)).href;
}

interface PluginEntry {
  readonly id: string;
  readonly file: string;
  readonly sinceBuild: string;
  readonly untilBuild: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The plugin as the release's `editors.json` names it, or null if it is not what is expected. */
function pluginEntry(bytes: Uint8Array, version: string): PluginEntry | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(manifest) || manifest["version"] !== version) return null;
  const plugin = manifest["jetbrains"];
  if (!isRecord(plugin)) return null;
  const { id, file, sinceBuild, untilBuild } = plugin;
  const valid =
    typeof id === "string" &&
    /^[a-z][\w.-]{2,63}$/u.test(id) &&
    file === `obrigado-jetbrains-${version}.zip` &&
    typeof sinceBuild === "string" &&
    BUILD.test(sinceBuild) &&
    (untilBuild === null || (typeof untilBuild === "string" && BUILD.test(untilBuild)));
  return valid ? { id, file, sinceBuild, untilBuild: untilBuild as string | null } : null;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The feed, in the shape obrigado.dev serves, naming the zip beside it. */
function localFeed(plugin: PluginEntry, version: string, zipUrl: string): string {
  const until = plugin.untilBuild === null ? "" : ` until-build="${escapeXml(plugin.untilBuild)}"`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<plugins>",
    `  <plugin id="${escapeXml(plugin.id)}" url="${escapeXml(zipUrl)}" version="${escapeXml(version)}">`,
    `    <idea-version since-build="${escapeXml(plugin.sinceBuild)}"${until}/>`,
    "    <name>Obrigado</name>",
    '    <vendor url="https://obrigado.dev">Obrigado</vendor>',
    "    <description>One labelled sponsored line in the status bar, only while an agent session",
    "      is running. Checked against the release's signed checksums by the obrigado CLI.</description>",
    "  </plugin>",
    "</plugins>",
    "",
  ].join("\n");
}

/** The version the feed here names, when the zip it names is here too. */
async function versionHere(dir: string): Promise<string | null> {
  let feed: string;
  try {
    feed = await readFile(join(dir, FEED), "utf8");
  } catch {
    return null;
  }
  const version = /<plugin [^>]*\bversion="([^"]+)"/u.exec(feed)?.[1];
  if (version === undefined) return null;
  return existsSync(join(dir, `obrigado-jetbrains-${version}.zip`)) ? version : null;
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.obrigado-${process.pid}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, path);
}

export type LocalRepository =
  | { readonly ok: true; readonly url: string; readonly version: string; readonly fresh: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * The repository here, holding the latest release's plugin: fetched and checked when it holds an
 * older one or none, and left alone when it is current.
 */
export async function prepareRepository(deps: RepositoryDeps): Promise<LocalRepository> {
  const tag = await latestReleaseTag(deps);
  if (tag === null) return { ok: false, reason: "could not read the latest release" };
  const version = tag.replace(/^v/u, "");
  const url = localRepositoryUrl(deps.repositoryDir);
  if ((await versionHere(deps.repositoryDir)) === version) {
    return { ok: true, url, version, fresh: false };
  }

  const manifest = await verifiedAsset(deps, tag, "editors.json");
  if (!manifest.ok) return manifest;
  const plugin = pluginEntry(manifest.bytes, version);
  if (plugin === null)
    return { ok: false, reason: `${tag}'s editors.json does not name the plugin` };
  // Through obrigado.dev first, so the download is counted; GitHub's own URL if that cannot
  // answer. Either way the bytes are held to the signed checksums.
  const counted = `${deps.origin}/jetbrains/download/${version}?via=cli`;
  let fetched = await verifiedAsset(deps, tag, plugin.file, counted);
  if (!fetched.ok && fetched.reason.startsWith("could not download")) {
    fetched = await verifiedAsset(deps, tag, plugin.file);
  }
  if (!fetched.ok) return fetched;

  await ensureDir(deps.repositoryDir);
  const zip = join(deps.repositoryDir, plugin.file);
  await writeAtomic(zip, fetched.bytes);
  await writeAtomic(
    join(deps.repositoryDir, FEED),
    localFeed(plugin, version, pathToFileURL(zip).href),
  );
  // The feed no longer names an older zip, and an IDE that has not updated yet is offered this one.
  const stale = (await readdir(deps.repositoryDir)).filter(
    (name) => name.endsWith(".zip") && name !== plugin.file,
  );
  await Promise.all(stale.map((name) => rm(join(deps.repositoryDir, name), { force: true })));
  return { ok: true, url, version, fresh: true };
}

/** Removes the repository, once no IDE is pointed at it. */
export async function removeRepository(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
