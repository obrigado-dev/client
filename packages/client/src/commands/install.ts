import { existsSync } from "node:fs";
import { dirname } from "node:path";

import {
  claudeIntegration,
  CLAUDE_SETTINGS_PATH,
  codexIntegration,
  opencodeIntegration,
  generateInstallKey,
  OBRIGADO_DIR,
  readConfig,
  writeConfig,
} from "../config.ts";
import type { ClaudeIntegrationConfig, ClientConfig, ClientIntegrations } from "../config.ts";
import {
  CODEX_TRACKING_ISSUE,
  CodexUnsupportedError,
  codexDetected,
  uninstallCodexStatusLine,
} from "../codex-statusline.ts";
import {
  installOpenCodePlugin,
  OPENCODE_PLUGIN_SPEC,
  OPENCODE_TUI_CONFIG_PATH,
  opencodeDetected,
  uninstallOpenCodePlugin,
} from "../opencode-plugin.ts";
import { INSTALLABLE_AGENTS, type InstallableAgentId } from "@obrigado/shared/agents";

import { installStatusLine, statusLineCommand, uninstallStatusLine } from "../statusline.ts";
import type { InstallOutcome } from "../statusline.ts";
import { apiOrigin, chainableCommand } from "./shared.ts";

/**
 * Derived, not listed: an agent is installable here exactly when the shared table says this
 * client is what puts it there. `vscode` and `cursor` are absent because they arrive from a
 * marketplace, which is a fact about them rather than a decision taken in this file.
 */
const SUPPORTED_INSTALL_AGENTS: readonly InstallableAgentId[] = INSTALLABLE_AGENTS.map(
  (agent) => agent.id,
);
export type InstallAgent = InstallableAgentId;

function isInstallAgent(value: string): value is InstallAgent {
  return (SUPPORTED_INSTALL_AGENTS as readonly string[]).includes(value);
}

export function requestedAgent(argv: readonly string[]): InstallAgent | null {
  const equals = argv.find((value) => value.startsWith("--agent="));
  const index = argv.indexOf("--agent");
  const value = equals?.slice("--agent=".length) ?? (index >= 0 ? argv[index + 1] : undefined);
  if (value === undefined) return null;
  if (!isInstallAgent(value)) {
    throw new Error(
      `Unsupported agent "${value}". Supported: ${SUPPORTED_INSTALL_AGENTS.join(", ")}`,
    );
  }
  return value;
}

/**
 * Hosts detected on PATH or by their documented user configuration home.
 *
 * Keyed so the compiler checks the set: an agent the shared table says this client installs,
 * with no detector here, would otherwise simply never be found by a bare `obrigado install`.
 * Order follows SUPPORTED_INSTALL_AGENTS, which is the table's own order.
 */
const DETECTORS: Record<InstallAgent, () => boolean> = {
  "claude-code": () => Bun.which("claude") !== null || existsSync(dirname(CLAUDE_SETTINGS_PATH)),
  codex: codexDetected,
  opencode: opencodeDetected,
};

function detectInstalledAgents(): InstallAgent[] {
  return SUPPORTED_INSTALL_AGENTS.filter((agent) => DETECTORS[agent]());
}

function reportRefusal(existing: unknown): void {
  console.error(`Claude Code: ${CLAUDE_SETTINGS_PATH} already defines a statusLine:`);
  console.error(`  ${JSON.stringify(existing)}\n`);
  console.error("Obrigado left it untouched. Use --chain to keep it above ours, or --replace.");
}

function reportChained(command: string): void {
  console.log("  Chained — your statusline still renders above ours:");
  console.log(`    ${command.slice(0, 76)}${command.length > 76 ? "…" : ""}`);
}

function reportClaudeInstalled(
  outcome: Extract<InstallOutcome, { status: "installed" }>,
  chained: string | undefined,
  previous: unknown,
): void {
  console.log(`Claude Code installed — wrote only "statusLine" in ${CLAUDE_SETTINGS_PATH}`);
  console.log(`  Command: ${statusLineCommand()}`);
  if (chained !== undefined) reportChained(chained);
  else if (previous !== null && previous !== undefined) {
    console.log(`  Previous statusline saved for restore: ${JSON.stringify(previous)}`);
  }
  if (outcome.backup !== null) console.log(`  Backup: ${outcome.backup}`);
}

function resolveClaudeState(
  existing: ClaudeIntegrationConfig | null,
  previous: unknown,
  chain: boolean,
): { previousToRecord: unknown; chainedCommand: string | undefined } {
  const displaced = chainableCommand(previous);
  const recorded = chainableCommand(existing?.previous_status_line);
  return {
    previousToRecord: displaced === undefined ? (existing?.previous_status_line ?? null) : previous,
    chainedCommand: chain
      ? (displaced ?? recorded ?? existing?.chained_command)
      : existing?.chained_command,
  };
}

function targetsForInstall(argv: readonly string[]): InstallAgent[] {
  const explicit = requestedAgent(argv);
  if (explicit !== null) return [explicit];
  const detected = detectInstalledAgents();
  if (detected.length === 0) {
    throw new Error(
      "No supported agent detected. Use `obrigado install --agent claude-code` or `--agent codex`.",
    );
  }
  return detected;
}

interface AdapterResult {
  readonly changed: boolean;
  readonly failed: boolean;
}

async function installClaudeAdapter(
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
  chain: boolean,
  replace: boolean,
): Promise<AdapterResult> {
  try {
    const { outcome, previous } = await installStatusLine(CLAUDE_SETTINGS_PATH, { replace });
    if (outcome.status === "refused") {
      reportRefusal(outcome.existing);
      return { changed: false, failed: true };
    }

    const current = claudeIntegration(existing);
    const { previousToRecord, chainedCommand } = resolveClaudeState(current, previous, chain);
    integrations["claude-code"] = {
      installed: true,
      installed_at: current?.installed_at ?? new Date().toISOString(),
      previous_status_line: previousToRecord,
      chained_command: chainedCommand,
    };
    if (outcome.status === "already-installed") {
      console.log("Claude Code already installed.");
      if (chain && chainedCommand !== undefined) reportChained(chainedCommand);
    } else {
      reportClaudeInstalled(outcome, chainedCommand, previous);
    }
    return { changed: true, failed: false };
  } catch (error) {
    console.error(`Claude Code install failed: ${error instanceof Error ? error.message : error}`);
    return { changed: false, failed: true };
  }
}

/**
 * Codex, for as long as it has nowhere to put a sponsored line.
 *
 * Two different answers for two different questions. Asking for Codex by name
 * deserves the whole reason and a non-zero exit — the developer wanted a
 * specific thing and did not get it, and a script should be able to tell. Plain
 * `install` merely NOTICED Codex; saying so once and moving on is right, and
 * failing the run would punish a machine that has Codex sitting next to a Claude
 * install we configured perfectly well.
 */
function installCodexAdapter(explicit: boolean): AdapterResult {
  if (explicit) {
    console.error(new CodexUnsupportedError().message);
    return { changed: false, failed: true };
  }
  console.log("Codex detected — it has no status-line extension point yet, so nothing was");
  console.log("installed for it. Obrigado will not fall back to a noisier surface.");
  console.log(`  Tracking upstream: ${CODEX_TRACKING_ISSUE}`);
  console.log("  `obrigado install --agent codex` explains in full.");
  return { changed: false, failed: false };
}

async function installOpenCodeAdapter(
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<AdapterResult> {
  try {
    const outcome = await installOpenCodePlugin();
    const current = opencodeIntegration(existing);
    integrations.opencode = {
      installed: true,
      installed_at: current?.installed_at ?? new Date().toISOString(),
    };
    if (outcome.status === "already-installed") {
      console.log("OpenCode already installed.");
    } else {
      console.log(`OpenCode installed — added one plugin entry to ${OPENCODE_TUI_CONFIG_PATH}`);
      console.log(`  Plugin: ${OPENCODE_PLUGIN_SPEC}`);
      if (outcome.backup !== null) console.log(`  Backup: ${outcome.backup}`);
    }
    console.log("  Restart OpenCode; the sponsored line appears in its bottom bar.");
    return { changed: true, failed: false };
  } catch (error) {
    console.error(`OpenCode install failed: ${error instanceof Error ? error.message : error}`);
    return { changed: false, failed: true };
  }
}

export async function install(argv: readonly string[] = []): Promise<number> {
  const targets = targetsForInstall(argv);
  const chain = argv.includes("--chain");
  const replace = argv.includes("--replace") || chain;
  if ((chain || replace) && !targets.includes("claude-code")) {
    throw new Error("--chain and --replace apply only to Claude Code's status line");
  }

  const existing = await readConfig();
  const integrations: ClientIntegrations = { ...existing?.integrations };
  const results: AdapterResult[] = [];

  if (targets.includes("claude-code")) {
    results.push(await installClaudeAdapter(existing, integrations, chain, replace));
  }

  if (targets.includes("codex")) {
    results.push(installCodexAdapter(requestedAgent(argv) === "codex"));
  }

  if (targets.includes("opencode")) {
    results.push(await installOpenCodeAdapter(existing, integrations));
  }

  if (results.some((result) => result.changed)) {
    const next: ClientConfig = {
      ...existing,
      install_key: existing?.install_key ?? generateInstallKey(),
      api_origin: apiOrigin(existing),
      integrations,
      installed_at: existing?.installed_at ?? new Date().toISOString(),
      session_summary: existing?.session_summary ?? true,
    };
    await writeConfig(next);
    console.log(`\nShared install key stored in ${OBRIGADO_DIR}/config.json (mode 0600).`);
    console.log("70% of gross revenue goes to the packages your project depends on.");
  }
  return results.some((result) => result.failed) ? 1 : 0;
}

/**
 * Keyed rather than chained, so the compiler checks the set.
 *
 * This was an if/else that fell through to codex, which meant a fourth installable agent would
 * have been reported as installed whenever codex was — silently, and only in the uninstall
 * path. `Record<InstallAgent, …>` fails to build instead, and `InstallAgent` comes from the
 * shared agents table.
 */
const INSTALLED_CHECK: Record<InstallAgent, (config: ClientConfig) => boolean> = {
  "claude-code": (config) => claudeIntegration(config)?.installed === true,
  codex: (config) => codexIntegration(config)?.installed === true,
  opencode: (config) => opencodeIntegration(config)?.installed === true,
};

function installedTargets(config: ClientConfig | null): InstallAgent[] {
  if (config === null) return [];
  return SUPPORTED_INSTALL_AGENTS.filter((agent) => INSTALLED_CHECK[agent](config));
}

/**
 * Each host's removal, reported and recorded.
 *
 * A remover says what it actually did and leaves the integration record cleared, except where
 * it found nothing of ours — Claude Code's "foreign" case deliberately does not touch the
 * record, because a statusline belonging to another tool is not ours to have removed.
 */
type Remover = (config: ClientConfig | null, integrations: ClientIntegrations) => Promise<void>;

async function removeClaudeCode(
  config: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<void> {
  const current = claudeIntegration(config);
  const result = await uninstallStatusLine(current?.previous_status_line ?? null);
  if (result === "foreign") {
    console.log("Claude Code: current statusline belongs to another tool; left alone.");
    return;
  }
  console.log(
    result === "restored"
      ? "Claude Code: restored the previous statusLine."
      : result === "removed"
        ? "Claude Code: removed Obrigado's statusLine."
        : "Claude Code: no Obrigado statusLine found.",
  );
  integrations["claude-code"] = { ...(current ?? { installed: false }), installed: false };
}

async function removeOpenCode(
  config: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<void> {
  const result = await uninstallOpenCodePlugin();
  console.log(
    result === "removed"
      ? "OpenCode: removed only Obrigado's plugin entry."
      : "OpenCode: no Obrigado plugin entry found.",
  );
  integrations.opencode = {
    ...(opencodeIntegration(config) ?? { installed: false }),
    installed: false,
  };
}

async function removeCodex(
  config: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<void> {
  await uninstallCodexStatusLine();
  console.log("Codex: nothing of ours was installed, so nothing was removed.");
  integrations.codex = { ...(codexIntegration(config) ?? { installed: false }), installed: false };
}

/** Keyed, so a new installable agent cannot ship without a way to remove it. */
const REMOVERS: Record<InstallAgent, Remover> = {
  "claude-code": removeClaudeCode,
  codex: removeCodex,
  opencode: removeOpenCode,
};

/**
 * Failures are caught per host rather than at the top: uninstalling three integrations should
 * not stop at the first one that cannot be reached, or a developer is left half-uninstalled
 * with no way to finish. Returns whether this host failed.
 */
async function removeOne(
  agent: InstallAgent,
  config: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<boolean> {
  try {
    await REMOVERS[agent](config, integrations);
    return false;
  } catch (error) {
    console.error(`${agent} uninstall failed: ${error instanceof Error ? error.message : error}`);
    return true;
  }
}

export async function uninstall(argv: readonly string[] = []): Promise<number> {
  const config = await readConfig();
  const explicit = requestedAgent(argv);
  const targets = explicit === null ? installedTargets(config) : [explicit];
  if (targets.length === 0) {
    console.log("No Obrigado integrations are recorded as installed.");
    return 0;
  }

  const integrations: ClientIntegrations = { ...config?.integrations };
  // Concurrently: the hosts write to different files, and one that cannot be reached
  // must not stop the others from being removed.
  const failures = await Promise.all(
    targets.map((agent) => removeOne(agent, config, integrations)),
  );
  const failed = failures.includes(true);

  if (config !== null) await writeConfig({ ...config, integrations });
  console.log(`State remains in ${OBRIGADO_DIR} — delete that directory to remove it completely.`);
  return failed ? 1 : 0;
}
