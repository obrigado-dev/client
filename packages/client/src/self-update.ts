/**
 * The CLI keeps itself current, and says so when it does (A38).
 *
 * §3 asks for "no silent auto-update", and the word doing the work is silent. So it is said three
 * ways: `obrigado install` and install.sh tell the developer it happens, the first renders after
 * an update show a line saying so in the sponsored slot, and `obrigado config auto_update false`
 * turns it off.
 *
 * ## How
 *
 * At most once a day, after a render has put its line on screen, the renderer starts
 * `obrigado update --background` detached and exits without waiting for it. That command asks
 * GitHub for the latest release. When it is newer than this binary, it downloads the asset this
 * binary was built as, the release's SHA256SUMS and their signature. The signature must be by a
 * key compiled into this binary (`release-signature.ts`) or nothing is trusted; then the asset
 * must match its line in SHA256SUMS, as install.sh checks it. It runs the download once to
 * confirm it is the version it claims, and renames it over this binary. A render already running
 * keeps the file it started from; the next one is the new version.
 *
 * Only a release binary does any of this: `scripts/build-binaries.ts` compiles in which asset it
 * is, and a checkout, or anybody else's build, has no such name and never tries.
 *
 * ## What it sends
 *
 * The requests install.sh makes, to GitHub, and nothing else: no install key, no project, and no
 * version but the `User-Agent` GitHub requires.
 */
import { spawn } from "node:child_process";
import { chmod, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ClientNotice } from "@obrigado/shared";

import { isCiEnvironment } from "./api.ts";
import { ensureDir, OBRIGADO_DIR, opencodeIntegration, piIntegration } from "./config.ts";
import type { ClientConfig } from "./config.ts";
import { repairOpenCodePlugin } from "./opencode-plugin.ts";
import { installPiExtension } from "./pi-extension.ts";
import { isNewer, latestReleaseTag, REPO, verifiedAsset } from "./release-assets.ts";
import type { ReleaseDeps } from "./release-assets.ts";
import type { PiHost } from "./pi-extension.ts";
import { CLIENT_VERSION } from "./version.ts";

/** Compiled in by `scripts/build-binaries.ts` (`release.ts`); undeclared everywhere else. */
declare const OBRIGADO_RELEASE_TARGET: string | undefined;

/** Which release asset this binary was built as, or null for anything that is not one. */
export function releaseTarget(): string | null {
  return typeof OBRIGADO_RELEASE_TARGET === "string" ? OBRIGADO_RELEASE_TARGET : null;
}

const UPDATE_PATH = join(OBRIGADO_DIR, "update.json");
const UPDATE_LOCK_PATH = join(OBRIGADO_DIR, "update.lock");

/** At most one check a day per install, whatever the number of hosts and sessions. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** A lock older than this is a run that died, not one still going. */
const LOCK_STALE_MS = 10 * 60 * 1000;

export interface UpdateState {
  /** When a render last started a check, so that a day passes between them. */
  readonly checked_at?: number;
  /** The version this install last updated itself to, and when: what the announcement says. */
  readonly updated_to?: string;
  readonly updated_at?: number;
  /** The version whose files the host integrations were last refreshed from. */
  readonly refreshed_for?: string;
}

export async function readUpdateState(path = UPDATE_PATH): Promise<UpdateState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as UpdateState) : {};
  } catch {
    return {};
  }
}

/** Atomic, like the notice ledger: a torn write would read back as "never checked". */
async function writeUpdateState(state: UpdateState, path = UPDATE_PATH): Promise<void> {
  await ensureDir(dirname(path));
  const temporary = `${path}.obrigado-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

// Moved to `release-assets.ts` with the rest of a release's reading, and still exported here
// for the callers that read them as the update's own.
export { checksumFor, isNewer, parseVersion } from "./release-assets.ts";

/** Whether this install updates itself: a release binary, installed, and not turned off. */
export function updatesItself(
  config: ClientConfig | null,
  target: string | null = releaseTarget(),
): boolean {
  return target !== null && config !== null && config.auto_update !== false;
}

/** Said at install, because §3 asks that an update never be silent (A38). */
export function reportUpdates(config: ClientConfig, target: string | null = releaseTarget()): void {
  if (!updatesItself(config, target)) return;
  console.log(
    "Updates itself daily and says so in the line; `obrigado config auto_update false` stops it.",
  );
}

/**
 * Start the day's check in the background, if one is due. Called after a render's line is out.
 *
 * The time is written before the check starts, so renders that follow within the day, in this
 * session or any other, find it already done whether the check succeeds or not.
 */
export async function scheduleUpdate(
  config: ClientConfig | null,
  options: {
    readonly now?: number;
    readonly target?: string | null;
    readonly path?: string;
    readonly start?: () => void;
  } = {},
): Promise<boolean> {
  if (!updatesItself(config, options.target === undefined ? releaseTarget() : options.target)) {
    return false;
  }
  const now = options.now ?? Date.now();
  const state = await readUpdateState(options.path);
  const age = state.checked_at === undefined ? Infinity : now - state.checked_at;
  if (age >= 0 && age < CHECK_EVERY_MS) return false;

  await writeUpdateState({ ...state, checked_at: now }, options.path);
  (options.start ?? startBackgroundUpdate)();
  return true;
}

function startBackgroundUpdate(): void {
  // Detached, inheriting nothing: a host reads the render's stdout to its end, and a child that
  // held it open would hold the line up for as long as a download takes.
  const child = spawn(process.execPath, ["update", "--background"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export interface UpdateDeps extends ReleaseDeps {
  /** The release asset this binary is, `darwin-arm64` and the like. */
  readonly target: string;
  /** The file to replace: this binary, through any symlink. */
  readonly binary: string;
  /** What a binary prints for `obrigado version`. */
  readonly reportedVersion: (path: string) => Promise<string>;
  readonly now?: () => number;
  readonly statePath?: string;
}

export type UpdateOutcome =
  | { readonly status: "current"; readonly version: string }
  | { readonly status: "updated"; readonly from: string; readonly to: string }
  | { readonly status: "failed"; readonly reason: string };

const failed = (reason: string): UpdateOutcome => ({ status: "failed", reason });

/**
 * One update, start to finish. Returns what happened; never throws.
 *
 * The download is staged beside the binary, so the final step is a rename within one directory
 * and the binary is the old file or the new one, never half of either.
 */
export async function runUpdate(deps: UpdateDeps): Promise<UpdateOutcome> {
  const latest = await latestReleaseTag(deps);
  if (latest === null) return failed("could not read the latest release from GitHub");
  if (!isNewer(latest, deps.current)) return { status: "current", version: deps.current };

  const version = latest.replace(/^v/u, "");
  const fetched = await verifiedAsset(deps, latest, `obrigado-${deps.target}`);
  if (!fetched.ok) return failed(fetched.reason);
  const { bytes } = fetched;

  const staged = `${deps.binary}.obrigado-update-${process.pid}`;
  try {
    await writeFile(staged, bytes, { mode: 0o755 });
    await chmod(staged, 0o755);
    // Not echoed back: a binary that does not know `version` answers with its whole usage.
    if ((await deps.reportedVersion(staged)).trim() !== version) {
      return failed(`the download does not report ${version}: not installed`);
    }
    await rename(staged, deps.binary);
  } catch (error) {
    return failed(
      `could not replace ${deps.binary}: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    await rm(staged, { force: true });
  }

  const now = (deps.now ?? Date.now)();
  const state = await readUpdateState(deps.statePath);
  await writeUpdateState({ ...state, updated_to: version, updated_at: now }, deps.statePath);
  return { status: "updated", from: deps.current, to: version };
}

/**
 * Run `body` holding the update lock, or return null if another run holds it.
 *
 * Renders in several sessions can start a check in the same minute; one of them downloads.
 */
export async function withUpdateLock<T>(
  body: () => Promise<T>,
  path = UPDATE_LOCK_PATH,
  now = Date.now(),
): Promise<T | null> {
  const take = async (): Promise<boolean> => {
    try {
      await ensureDir(dirname(path));
      await (await open(path, "wx")).close();
      return true;
    } catch {
      return false;
    }
  };
  if (!(await take())) {
    const held = await stat(path).catch(() => null);
    if (held !== null && now - held.mtimeMs < LOCK_STALE_MS) return null;
    await rm(path, { force: true });
    if (!(await take())) return null;
  }
  try {
    return await body();
  } finally {
    await rm(path, { force: true });
  }
}

/**
 * The line that says an update happened, for a day after it did, or null (A38).
 *
 * Shown in the sponsored slot as Obrigado's own notice (A30), so it is paced, labelled `obrigado`
 * rather than as an ad, and never billed. This is what keeps the update from being silent.
 */
export function updateNotice(
  state: UpdateState,
  now = Date.now(),
  current = CLIENT_VERSION,
): ClientNotice | null {
  if (state.updated_to !== current || state.updated_at === undefined) return null;
  const age = now - state.updated_at;
  if (age < 0 || age >= CHECK_EVERY_MS) return null;
  return {
    id: `updated-${current}`.slice(0, 32),
    body: `Updated itself to ${current}. Turn that off with: obrigado config auto_update false`,
    url: `https://github.com/${REPO}/releases/tag/v${current}`,
  };
}

const PI_HOSTS: readonly PiHost[] = ["pi", "oh-my-pi"];

/**
 * Rewrite the host files a release carries inside itself, once per version (A38).
 *
 * The Pi extension is one: the CLI copies it into Pi's extensions directory at install,
 * stamped with the version that wrote it, so a binary that updated itself would otherwise leave
 * the old copy running. Only for hosts this install put it in, and `installPiExtension` writes
 * only when the bytes differ.
 *
 * OpenCode's entry is the other: installs before 0.3.3 named the plugin in a form OpenCode
 * cannot load, and `repairOpenCodePlugin` rewrites that form where it finds it and nothing else.
 */
export async function refreshIntegrations(
  config: ClientConfig | null,
  state: UpdateState,
  options: {
    readonly target?: string | null;
    readonly path?: string;
    readonly refresh?: (host: PiHost) => Promise<unknown>;
    readonly repairOpenCode?: () => Promise<unknown>;
  } = {},
): Promise<boolean> {
  const target = options.target === undefined ? releaseTarget() : options.target;
  if (target === null || config === null || state.refreshed_for === CLIENT_VERSION) return false;
  const refresh = options.refresh ?? installPiExtension;
  for (const host of PI_HOSTS) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- two hosts, and one may share the other's directory
    if (piIntegration(config, host)?.installed === true) await refresh(host);
  }
  if (opencodeIntegration(config)?.installed === true) {
    await (options.repairOpenCode ?? repairOpenCodePlugin)();
  }
  await writeUpdateState(
    { ...(await readUpdateState(options.path)), refreshed_for: CLIENT_VERSION },
    options.path,
  );
  return true;
}

/**
 * After a render, whatever it drew (A38): the host files a new version carries, rewritten once
 * per version, then the day's check, started in the background. Never in a build, never for a
 * machine nothing is installed on, and never at a cost to the render beyond a file read.
 */
export async function afterRender(config: ClientConfig | null): Promise<void> {
  if (config === null || isCiEnvironment()) return;
  await refreshIntegrations(config, await readUpdateState()).catch(() => false);
  await scheduleUpdate(config).catch(() => false);
}
