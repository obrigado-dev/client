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
      console.error(`Claude desktop app: ${CLAUDE_SETTINGS_PATH}: ${outcome.reason}.`);
      console.error("Obrigado left it untouched.");
      return { changed: false, failed: true };
    }
    integrations["claude-desktop"] = {
      installed: true,
      installed_at: current?.installed_at ?? new Date().toISOString(),
      renderer_command: renderer,
    };
    if (outcome.status === "already-installed") {
      console.log("Claude desktop app already installed.");
    } else {
      console.log(
        `Claude desktop app installed — enabled ${CLAUDE_DESKTOP_PLUGIN_ID} in ${CLAUDE_SETTINGS_PATH}`,
      );
      console.log(`  Renderer: ${renderer}`);
      if (outcome.backup !== null) console.log(`  Backup: ${outcome.backup}`);
    }
    console.log("  Start a new session in the app's Code tab; the line appears above the prompt.");
    return { changed: true, failed: false };
  } catch (error) {
    console.error(
      `Claude desktop app install failed: ${error instanceof Error ? error.message : error}`,
    );
    return { changed: false, failed: true };
  }
}

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
