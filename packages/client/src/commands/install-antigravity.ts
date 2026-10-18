/**
 * Antigravity CLI's install and uninstall reporting.
 *
 * In its own file because `install.ts` is at its line budget and its limit of modules to import,
 * as the Pi and desktop app adapters were. What is written lives one layer down, in
 * `antigravity-statusline.ts`; these decide what the developer is told and what the install
 * records.
 */
import {
  installAntigravityStatusLine,
  uninstallAntigravityStatusLine,
} from "../antigravity-statusline.ts";
import { antigravityCliIntegration, ANTIGRAVITY_CLI_SETTINGS_PATH } from "../config.ts";
import type { ClientConfig, ClientIntegrations } from "../config.ts";
import type { AdapterResult, Remover } from "./adapters.ts";
import { failedRow, tilde } from "./install-report.ts";

const LABEL = "Antigravity CLI";

async function installAntigravityAdapter(
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<AdapterResult> {
  try {
    const outcome = await installAntigravityStatusLine();
    const file = tilde(ANTIGRAVITY_CLI_SETTINGS_PATH);
    if (outcome.status === "refused") {
      // The developer's own script has replaced the built-in line, and the host runs one
      // command. Theirs stays; nothing is recorded, so uninstall will not touch it either.
      return {
        changed: false,
        failed: true,
        row: {
          mark: "failed",
          host: LABEL,
          detail: `you already have a status line in ${file}, left as it was`,
          notes: [
            "Antigravity CLI runs one status line command, and yours has it",
            `to show ours under the built-in line instead, remove "statusLine" there and install again`,
          ],
        },
      };
    }
    integrations["antigravity-cli"] = {
      installed: true,
      installed_at: antigravityCliIntegration(existing)?.installed_at ?? new Date().toISOString(),
    };
    const already = outcome.status === "already-installed";
    return {
      changed: true,
      failed: false,
      row: {
        mark: "done",
        host: LABEL,
        detail: `status line · ${file} · ${already ? "already there" : "under the built-in line"}`,
        backedUp: outcome.status === "installed" && outcome.backup !== null,
      },
    };
  } catch (error) {
    return { changed: false, failed: true, row: failedRow(LABEL, error) };
  }
}

/** Antigravity CLI when the targets include it. */
export async function installAntigravityHost(
  targets: readonly string[],
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<AdapterResult[]> {
  return targets.includes("antigravity-cli")
    ? [await installAntigravityAdapter(existing, integrations)]
    : [];
}

/**
 * Removes only an entry that is wholly ours, and records the host uninstalled unless what it
 * found was somebody else's, as Claude Code's remover does.
 */
export const removeAntigravityCli: Remover = async (config, integrations) => {
  const result = await uninstallAntigravityStatusLine();
  const file = tilde(ANTIGRAVITY_CLI_SETTINGS_PATH);
  if (result === "foreign") {
    console.log(`${LABEL}: the statusLine there belongs to another tool; left alone.`);
    return;
  }
  if (result === "nested") {
    console.log(
      `${LABEL}: your statusLine runs Obrigado inside another command; left alone. Take Obrigado out of it in ${file}.`,
    );
    return;
  }
  console.log(
    result === "removed"
      ? `${LABEL}: removed Obrigado's statusLine.`
      : `${LABEL}: no Obrigado statusLine found.`,
  );
  integrations["antigravity-cli"] = {
    ...(antigravityCliIntegration(config) ?? { installed: false }),
    installed: false,
  };
};
