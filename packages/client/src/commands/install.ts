import {
  claudeDesktopIntegration,
  claudeIntegration,
  piIntegration,
  CLAUDE_SETTINGS_PATH,
  codexIntegration,
  opencodeIntegration,
  generateInstallKey,
  OBRIGADO_DIR,
  readConfig,
  writeConfig,
} from "../config.ts";
import type { ClientConfig, ClientIntegrations, SponsoredPosition } from "../config.ts";
import {
  CODEX_TRACKING_ISSUE,
  CodexUnsupportedError,
  uninstallCodexStatusLine,
} from "../codex-statusline.ts";
import {
  installOpenCodePlugin,
  OPENCODE_TUI_CONFIG_PATH,
  uninstallOpenCodePlugin,
} from "../opencode-plugin.ts";
import { INSTALLABLE_AGENTS, type InstallableAgentId } from "@obrigado/shared/agents";

import { installStatusLine, uninstallStatusLine } from "../statusline.ts";
import { decideSharing, reportStored } from "./privacy-prompt.ts";
import type { AdapterResult, Remover } from "./adapters.ts";
import { installClaudeDesktopAdapter, removeClaudeDesktop } from "./install-desktop.ts";
import { claudeRow, failedRow, printInstallRows, tilde } from "./install-report.ts";
import { installPiHosts, removePiHost } from "./install-pi.ts";
import { positionFromArgv, resolveClaudeState } from "./claude-state.ts";
import { reportUpdates } from "../self-update.ts";
import { detectInstalledAgents } from "./detect.ts";
import { apiOrigin } from "./shared.ts";

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

async function installClaudeAdapter(
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
  chain: boolean,
  replace: boolean,
  position: SponsoredPosition,
): Promise<AdapterResult> {
  try {
    const { outcome, previous } = await installStatusLine(CLAUDE_SETTINGS_PATH, { replace });
    if (outcome.status === "refused") {
      return { changed: false, failed: true, row: claudeRow(outcome, undefined, previous) };
    }

    const current = claudeIntegration(existing);
    const { previousToRecord, chainedCommand } = resolveClaudeState(current, previous, chain);
    integrations["claude-code"] = {
      installed: true,
      installed_at: current?.installed_at ?? new Date().toISOString(),
      previous_status_line: previousToRecord,
      chained_command: chainedCommand,
      sponsored_position: position,
    };
    return {
      changed: true,
      failed: false,
      row: claudeRow(
        outcome,
        outcome.status === "already-installed" && !chain ? undefined : chainedCommand,
        previous,
      ),
    };
  } catch (error) {
    return { changed: false, failed: true, row: failedRow("Claude Code", error) };
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
    const reason = new CodexUnsupportedError().message.split("\n").filter((line) => line !== "");
    return {
      changed: false,
      failed: true,
      row: { mark: "failed", host: "Codex", detail: "nothing installed", notes: reason },
    };
  }
  return {
    changed: false,
    failed: false,
    row: {
      mark: "skipped",
      host: "Codex",
      detail: `no status line to use yet · ${CODEX_TRACKING_ISSUE.replace("https://", "")}`,
    },
  };
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
    const already = outcome.status === "already-installed";
    return {
      changed: true,
      failed: false,
      row: {
        mark: "done",
        host: "OpenCode",
        detail: `plugin · ${tilde(OPENCODE_TUI_CONFIG_PATH)} · ${already ? "already there" : "restart OpenCode"}`,
        backedUp: !already && outcome.backup !== null,
      },
    };
  } catch (error) {
    return { changed: false, failed: true, row: failedRow("OpenCode", error) };
  }
}

export async function install(argv: readonly string[] = []): Promise<number> {
  const targets = targetsForInstall(argv);
  const chain = argv.includes("--chain");
  const replace = argv.includes("--replace") || chain;
  if ((chain || replace) && !targets.includes("claude-code")) {
    throw new Error("--chain and --replace apply only to Claude Code's status line");
  }
  if ((argv.includes("--above") || argv.includes("--below")) && !targets.includes("claude-code")) {
    throw new Error("--above and --below apply only to Claude Code's status line");
  }

  const existing = await readConfig();
  const integrations: ClientIntegrations = { ...existing?.integrations };
  const results: AdapterResult[] = [];

  if (targets.includes("claude-code")) {
    results.push(
      await installClaudeAdapter(
        existing,
        integrations,
        chain,
        replace,
        positionFromArgv(argv, claudeIntegration(existing)),
      ),
    );
  }

  if (targets.includes("codex")) {
    results.push(installCodexAdapter(requestedAgent(argv) === "codex"));
  }

  if (targets.includes("opencode")) {
    results.push(await installOpenCodeAdapter(existing, integrations));
  }

  results.push(...(await installPiHosts(targets, requestedAgent(argv), existing, integrations)));

  if (targets.includes("claude-desktop")) {
    results.push(await installClaudeDesktopAdapter(existing, integrations));
  }

  console.log("");
  printInstallRows(results.flatMap((result) => (result.row === undefined ? [] : [result.row])));

  if (results.some((result) => result.changed)) {
    const decision = await decideSharing(existing, argv);
    const next: ClientConfig = {
      ...existing,
      install_key: existing?.install_key ?? generateInstallKey(),
      api_origin: apiOrigin(existing),
      integrations,
      installed_at: existing?.installed_at ?? new Date().toISOString(),
      session_summary: existing?.session_summary ?? true,
      // Never defaulted on, and never silently carried forward as anything but what the
      // developer last chose. An install that has said nothing has consented to nothing.
      ...(decision.sharing === undefined ? {} : { sharing: decision.sharing }),
    };
    await writeConfig(next);
    reportStored(decision);
    reportUpdates(next);
    console.log("70% of gross revenue funds open source maintainers.");
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
  pi: (config) => piIntegration(config, "pi")?.installed === true,
  "oh-my-pi": (config) => piIntegration(config, "oh-my-pi")?.installed === true,
  "claude-desktop": (config) => claudeDesktopIntegration(config)?.installed === true,
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
  pi: removePiHost("pi"),
  "oh-my-pi": removePiHost("oh-my-pi"),
  "claude-desktop": removeClaudeDesktop,
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
