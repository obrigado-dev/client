/**
 * Which of the hosts this client installs into are actually on this machine.
 *
 * Split from `install.ts` so the command reads as orchestration; the question "is this host
 * here?" is a fact about the machine and answers the same way for install, uninstall and status.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";

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
};

export function detectInstalledAgents(): InstallableAgentId[] {
  return INSTALLABLE_AGENTS.map((agent) => agent.id).filter((agent) => DETECTORS[agent]());
}
