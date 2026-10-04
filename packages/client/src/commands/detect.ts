/**
 * Which of the hosts this client installs into are actually on this machine.
 *
 * Split from `install.ts` so the command reads as orchestration; the question "is this host
 * here?" is a fact about the machine and answers the same way for install, uninstall and status.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { claudeDesktopDetected } from "../claude-desktop.ts";
import { codexDetected } from "../codex-statusline.ts";
import { CLAUDE_SETTINGS_PATH } from "../config.ts";
import { opencodeDetected } from "../opencode-plugin.ts";
import { ohMyPiDetected, piDetected } from "../pi-extension.ts";
import { INSTALLABLE_AGENTS, type InstallableAgentId } from "@obrigado/shared/agents";

/**
 * Hosts detected on PATH or by their documented user configuration home.
 *
 * Keyed so the compiler checks the set: an agent the shared table says this client installs,
 * with no detector here, would otherwise simply never be found by a bare `obrigado install`.
 * Order follows SUPPORTED_INSTALL_AGENTS, which is the table's own order.
 */
const DETECTORS: Record<InstallableAgentId, () => boolean> = {
  "claude-code": () => Bun.which("claude") !== null || existsSync(dirname(CLAUDE_SETTINGS_PATH)),
  codex: codexDetected,
  opencode: opencodeDetected,
  pi: piDetected,
  "oh-my-pi": ohMyPiDetected,
  "claude-desktop": claudeDesktopDetected,
  // Asked about, never detected into (A40). An editor on this machine says nothing about whether
  // an agent runs in it, so a bare install asks (`install-editors.ts`), and
  // `--agent vscode|cursor` installs into one without asking.
  vscode: () => false,
  cursor: () => false,
};

function detectInstalledAgents(): InstallableAgentId[] {
  return INSTALLABLE_AGENTS.map((agent) => agent.id).filter((agent) => DETECTORS[agent]());
}

/**
 * Derived, not listed: an agent is installable here exactly when the shared table says this
 * client is what puts it there. JetBrains IDEs are absent because they install from their own
 * plugin manager (A40), which is a fact about them rather than a decision taken in this file.
 */
export const SUPPORTED_INSTALL_AGENTS: readonly InstallableAgentId[] = INSTALLABLE_AGENTS.map(
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

export function targetsForInstall(argv: readonly string[]): InstallAgent[] {
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
