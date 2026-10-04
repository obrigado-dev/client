/**
 * The Claude desktop app's install and uninstall reporting (A37).
 *
 * Split from `install.ts` because that file reached its line budget, as `install-pi.ts` was.
 * What is written lives one layer down, in `claude-desktop.ts`: these functions decide what the
 * developer is TOLD.
 */
import { claudeDesktopIntegration, CLAUDE_SETTINGS_PATH } from "../config.ts";
import type { ClientConfig, ClientIntegrations } from "../config.ts";
import {
  CLAUDE_DESKTOP_PLUGIN_ID,
  desktopRendererCommand,
  installClaudeDesktopPlugin,
  uninstallClaudeDesktopPlugin,
} from "../claude-desktop.ts";
import type { AdapterResult } from "./adapters.ts";
import { tilde } from "./install-report.ts";

/**
 * The Claude desktop app: its plugin enabled from our marketplace, and the renderer named by its
 * full path (A37). Claude Code fetches the plugin itself, in the background, once a session
 * starts, so the line arrives with the app's next session rather than with this command.
 */
export async function installClaudeDesktopAdapter(
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<AdapterResult> {
  try {
    const current = claudeDesktopIntegration(existing);
    const renderer = desktopRendererCommand();
    const outcome = await installClaudeDesktopPlugin(renderer, current?.renderer_command);
    if (outcome.status === "refused") {
      return {
        changed: false,
        failed: true,
        row: {
          mark: "failed",
          host: HOST,
          detail: `${outcome.reason} in ${tilde(CLAUDE_SETTINGS_PATH)}, left as it was`,
        },
      };
    }
    integrations["claude-desktop"] = {
      installed: true,
      installed_at: current?.installed_at ?? new Date().toISOString(),
      renderer_command: renderer,
    };
    const already = outcome.status === "already-installed";
    return {
      changed: true,
      failed: false,
      row: {
        mark: "done",
        host: HOST,
        detail: `plugin · ${tilde(CLAUDE_SETTINGS_PATH)} · ${already ? "already there" : "next new session in the app"}`,
        backedUp: !already && outcome.backup !== null,
      },
    };
  } catch (error) {
    return {
      changed: false,
      failed: true,
      row: {
        mark: "failed",
        host: HOST,
        detail: `failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/** What the summary and the landing page call it. */
const HOST = "Claude Desktop App";

export async function removeClaudeDesktop(
  config: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<void> {
  const current = claudeDesktopIntegration(config);
  const result = await uninstallClaudeDesktopPlugin(current?.renderer_command);
  console.log(
    result === "removed"
      ? `Claude desktop app: turned off ${CLAUDE_DESKTOP_PLUGIN_ID} and removed only our entries.`
      : "Claude desktop app: no Obrigado plugin entry found.",
  );
  integrations["claude-desktop"] = { ...(current ?? { installed: false }), installed: false };
}
