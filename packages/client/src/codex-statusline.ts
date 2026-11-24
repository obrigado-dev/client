/**
 * Codex's status line: three settings in `~/.codex/config.toml`.
 *
 * Until 0.171.0 Codex drew its footer from a closed list of its own items, and there was nowhere
 * for a line of ours to go: install refused, and said why (A19). 0.171.0 added a provider, a stdio
 * MCP server Codex starts and reads its footer from (openai/codex#17827, closed 2026-11-21). The
 * provider is `obrigado codex-provider` (`codex-provider.ts`), and this module is the write that
 * tells Codex to use it:
 *
 *   - `[mcp_servers.obrigado]`, the command that starts it;
 *   - `tui.status_line_provider`, which picks it for the footer;
 *   - `features.tui_extensions_statusline`, because Codex ships the provider behind an
 *     experimental switch that is off until somebody turns it on. Those three in the file are the
 *     whole of it: no `/experimental`, no `/statusline` picker (checked on 0.171.0).
 *
 * The rules are the ones every installer here keeps (INVARIANT 11): only our keys are written, a
 * backup is taken first, the write is atomic, and uninstall puts back exactly what was there. Two
 * things are particular to this host.
 *
 * The provider slot is the whole footer, not a place beside it. So install looks at what the
 * developer has there before it takes it. Codex's own footer is redrawn item for item, and where
 * it shows something a provider is not told (`UNREDRAWABLE_ITEMS`) install refuses and names it.
 * Another provider in the slot is left there, unless `--chain` asks for ours to run it and draw
 * its footer beside ours (`codex-chain.ts`). `--replace` takes the slot either way, as it does
 * for Claude Code, and uninstall hands it back.
 *
 * And the file is TOML that a developer keeps by hand, so it is edited on its lines and the result
 * is held to the change that was asked for (`toml-edit.ts`), then read by Codex itself in a
 * scratch directory before it replaces anything. A file this cannot edit safely is left alone,
 * with the three settings printed for the developer to add.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { providerIdFrom } from "./codex-chain.ts";
import { isOurs, planCodexInstall, planCodexUninstall } from "./codex-plan.ts";
import type { CodexRecord, CodexRefusal, CodexRemoval } from "./codex-plan.ts";
import { BACKUP_DIR, CODEX_HOME, ensureDir } from "./config.ts";
import type { CodexIntegrationConfig } from "./config.ts";
import { providerArgv } from "./renderer-command.ts";
import { parseToml } from "./toml-edit.ts";

/** Codex's user-level config. */
export const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");

/** The first Codex with a status line provider. */
const MINIMUM_VERSION = [0, 171, 0] as const;
export const MINIMUM_CODEX = MINIMUM_VERSION.join(".");

/** Where upstream announced it, for a refusal that has to point somewhere. */
export const CODEX_PROVIDER_ISSUE = "https://github.com/openai/codex/issues/17827";

/**
 * How Codex starts the provider: the client, `codex-provider`, and where Codex's config is when
 * that is not `~/.codex`.
 *
 * Codex starts an MCP server with a short list of variables, `HOME` and `PATH` among them and
 * `CODEX_HOME` not (checked on 0.171.0). A developer who keeps Codex's files somewhere else has
 * said so in a variable the provider will never see, so install says it again as an argument.
 */
export function codexProviderArgv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const moved = env["CODEX_HOME"] !== undefined && env["CODEX_HOME"].length > 0;
  return [...providerArgv(), ...(moved ? ["--codex-home", CODEX_HOME] : [])];
}

/** Whether Codex is present at all, independent of whether its version can serve us. */
export function codexDetected(): boolean {
  return Bun.which("codex") !== null || existsSync(CODEX_HOME);
}

/**
 * The version of the `codex` on PATH, or null where there is none or it will not say.
 *
 * Asked of the program, since nothing in `~/.codex` records it. The Codex inside the ChatGPT
 * desktop app is a different copy with its own version and no footer; it is not what this asks.
 */
export function codexVersion(binary: string | null = Bun.which("codex")): string | null {
  if (binary === null) return null;
  try {
    const result = Bun.spawnSync([binary, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.exitCode !== 0) return null;
    return /\d+\.\d+\.\d+/u.exec(result.stdout.toString())?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Whether a Codex of this version reads a provider. A pre-release of 0.171.0 counts as one. */
export function supportsProvider(version: string): boolean {
  const parts = version.split(".").map((part) => Math.trunc(Number(part)));
  for (const [index, minimum] of MINIMUM_VERSION.entries()) {
    const part = parts[index] ?? 0;
    if (part !== minimum) return part > minimum;
  }
  return true;
}

/**
 * Whether Codex itself reads `text` as its config.
 *
 * `toml-edit.ts` holds an edit to the change it was asked for by this runtime's TOML parser. Codex
 * has its own, and it is the one that has to open the file tomorrow. So the result is put in a
 * scratch directory and `codex features list`, which loads the whole config and does nothing else,
 * is run against it. Anything short of a clear refusal counts as read: no `codex` to ask, or one
 * that hangs, is not evidence against a file the first check already passed.
 */
function readByCodex(text: string, binary: string | null): boolean {
  if (binary === null) return true;
  let home: string | null = null;
  try {
    home = mkdtempSync(join(tmpdir(), "obrigado-codex-"));
    writeFileSync(join(home, "config.toml"), text, { mode: 0o600 });
    const result = Bun.spawnSync([binary, "features", "list"], {
      env: { ...process.env, CODEX_HOME: home },
      stdout: "ignore",
      stderr: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
    return result.exitCode === 0 || result.exitCode === null;
  } catch {
    return true;
  } finally {
    if (home !== null) rmSync(home, { recursive: true, force: true });
  }
}

/** A copy of the file as it is now, beside the other hosts' in `~/.obrigado/backups`. */
async function backupConfig(path: string, backupDir: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  await ensureDir(backupDir);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const destination = join(backupDir, `codex-config-${stamp}.toml`);
  await Bun.write(destination, await file.text());
  return destination;
}

/** Onto the file the path resolves to, so a `config.toml` that is a dotfiles symlink stays one. */
async function writeConfigAtomically(path: string, text: string): Promise<void> {
  const target = await realpath(path).catch(() => path);
  await ensureDir(dirname(target));
  const temporary = `${target}.obrigado-${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, target);
}

async function readConfigText(path: string): Promise<string> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : "";
}

export type CodexInstallOutcome =
  | { readonly status: "refused"; readonly refusal: CodexRefusal }
  | {
      readonly status: "installed" | "already-installed";
      readonly backup: string | null;
      readonly record: CodexRecord;
      readonly dropped: readonly string[];
    };

export interface CodexInstallOptions {
  readonly chain?: boolean;
  readonly replace?: boolean;
  readonly record?: CodexIntegrationConfig | null;
  /** The rest are the machine, passed in so a test can stand one up. */
  readonly path?: string;
  readonly backupDir?: string;
  readonly binary?: string | null;
  readonly version?: string | null;
  readonly argv?: readonly string[];
}

/** Write the three settings, unless they are there already or something of the developer's is. */
export async function installCodexStatusLine(
  options: CodexInstallOptions = {},
): Promise<CodexInstallOutcome> {
  const binary = options.binary === undefined ? Bun.which("codex") : options.binary;
  const version = options.version === undefined ? codexVersion(binary) : options.version;
  if (version === null) return { status: "refused", refusal: { kind: "no-binary" } };
  if (!supportsProvider(version)) {
    return { status: "refused", refusal: { kind: "too-old", version } };
  }

  const path = options.path ?? CODEX_CONFIG_PATH;
  const text = await readConfigText(path);
  const plan = planCodexInstall(text, {
    argv: options.argv ?? codexProviderArgv(),
    record: options.record ?? null,
    ...(options.chain === undefined ? {} : { chain: options.chain }),
    ...(options.replace === undefined ? {} : { replace: options.replace }),
  });
  if (plan.status === "refused") return plan;
  if (plan.next === text) {
    return { status: "already-installed", backup: null, record: plan.record, dropped: [] };
  }
  if (!readByCodex(plan.next, binary)) {
    return {
      status: "refused",
      refusal: { kind: "uneditable", why: "Codex would not read the file with the change made" },
    };
  }

  const backup = await backupConfig(path, options.backupDir ?? BACKUP_DIR);
  await writeConfigAtomically(path, plan.next);
  return { status: "installed", backup, record: plan.record, dropped: plan.dropped };
}

/** Take ours out of `config.toml`, and put back what install found there. */
export async function uninstallCodexStatusLine(
  record: CodexIntegrationConfig | null,
  options: Pick<CodexInstallOptions, "path" | "backupDir"> = {},
): Promise<CodexRemoval["outcome"]> {
  const path = options.path ?? CODEX_CONFIG_PATH;
  const text = await readConfigText(path);
  const removal = planCodexUninstall(text, record);
  if (removal.next === text) return removal.outcome;
  await backupConfig(path, options.backupDir ?? BACKUP_DIR);
  await writeConfigAtomically(path, removal.next);
  return removal.outcome;
}

/** Whether `config.toml` has ours in the footer's slot right now, for `status` and `doctor`. */
export async function codexConfigured(path = CODEX_CONFIG_PATH): Promise<boolean> {
  const tui = parseToml(await readConfigText(path))?.["tui"];
  const selected =
    typeof tui === "object" && tui !== null
      ? (tui as Record<string, unknown>)["status_line_provider"]
      : undefined;
  return isOurs(providerIdFrom(selected));
}
