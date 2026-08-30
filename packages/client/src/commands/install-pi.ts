/**
 * The Pi hosts' install and uninstall reporting.
 *
 * Split from `install.ts` only because that file reached its line budget — the two adapters
 * here are the same shape as the ones beside Claude Code and OpenCode, and they belong to the
 * same command. What is genuinely particular to Pi lives one layer down, in `pi-extension.ts`:
 * these functions decide what the developer is TOLD, not what is written.
 */
import { piIntegration } from "../config.ts";
import type { ClientConfig, ClientIntegrations } from "../config.ts";
import {
  installPiExtension,
  piExtensionTargets,
  uninstallPiExtension,
  type PiHost,
} from "../pi-extension.ts";
import type { AdapterResult, Remover } from "./adapters.ts";

function hostLabel(host: PiHost): string {
  return host === "pi" ? "Pi" : "oh-my-pi";
}

/**
 * Pi and oh-my-pi, which are one extension in two directories.
 *
 * Unlike Claude Code's settings file or OpenCode's plugin list, nothing here merges into a
 * document the developer owns — the host discovers extensions by placement, so the install is
 * a file appearing in a directory it already watches.
 */
async function installPiAdapter(
  host: PiHost,
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<AdapterResult> {
  const label = hostLabel(host);
  try {
    const outcome = await installPiExtension(host);
    const current = piIntegration(existing, host);
    integrations[host] = {
      installed: true,
      installed_at: current?.installed_at ?? new Date().toISOString(),
    };
    if (outcome.status === "already-installed") {
      console.log(`${label} already installed.`);
    } else {
      console.log(`${label} installed — wrote ${outcome.path}`);
      if (outcome.backup !== null) console.log(`  Backup: ${outcome.backup}`);
    }
    console.log(`  Restart ${label}; the sponsored line joins its footer status.`);
    return { changed: true, failed: false };
  } catch (error) {
    console.error(`${label} install failed: ${error instanceof Error ? error.message : error}`);
    return { changed: false, failed: true };
  }
}

/**
 * Removes only a file we recognise as ours.
 *
 * `uninstallPiExtension` checks the header before deleting, so a developer who replaced our
 * copy with their own extension of the same name keeps it. "Not installed" is the honest report
 * in that case, not a failure.
 */
export function removePiHost(host: PiHost): Remover {
  const label = hostLabel(host);
  return async (config, integrations) => {
    const result = await uninstallPiExtension(host);
    console.log(
      result === "removed"
        ? `${label}: removed only Obrigado's extension file.`
        : `${label}: no Obrigado extension file found.`,
    );
    integrations[host] = {
      ...(piIntegration(config, host) ?? { installed: false }),
      installed: false,
    };
  };
}

/**
 * Both Pi hosts in one step, because they are one extension.
 *
 * `piExtensionTargets` is what stands between "install for both" and writing the same file
 * twice when `PI_CODING_AGENT_DIR` collapses their two directories into one — in which case the
 * second `--agent` would win silently, and both hosts would bill as whichever was installed last.
 */
export async function installPiHosts(
  targets: readonly string[],
  requested: string | null,
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
): Promise<AdapterResult[]> {
  const hosts = piExtensionTargets(
    (["pi", "oh-my-pi"] as const).filter((host) => targets.includes(host)),
    requested === "pi" || requested === "oh-my-pi" ? requested : null,
  );

  const results: AdapterResult[] = [];
  for (const host of hosts) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- at most two, and they may share a directory
    results.push(await installPiAdapter(host, existing, integrations));
  }
  return results;
}
