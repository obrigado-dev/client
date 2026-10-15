/**
 * JetBrains IDEs: what the question names, the install into each IDE, and the removal (A43).
 *
 * One host to `obrigado install`, because the IDEs are one platform running one plugin, and one
 * line per IDE in the summary, because each is installed, or refused, on its own. What is found
 * and where it lives is `jetbrains-ides.ts`; what is run and written is `jetbrains-plugin.ts`.
 */
import { BACKUP_DIR, editorIntegration } from "../config.ts";
import type { ClientConfig, ClientIntegrations } from "../config.ts";
import {
  jetbrainsIdes,
  pluginsDirectory,
  readiness,
  SINCE_RELEASE,
  thisMachine,
} from "../jetbrains-ides.ts";
import type { JetBrainsIde } from "../jetbrains-ides.ts";
import {
  installedPluginVersion,
  installJetBrainsPlugin,
  removeJetBrainsRepository,
  repositoryUrl,
  runLauncher,
} from "../jetbrains-plugin.ts";
import type { PluginDeps, PluginOutcome } from "../jetbrains-plugin.ts";
import type { AdapterResult, InstallRow, Remover } from "./adapters.ts";
import { failedRow } from "./install-report.ts";
import { apiOrigin } from "./shared.ts";

export interface JetBrainsDeps extends PluginDeps {
  /** The IDEs to install into: every one on this machine, unless a test says otherwise. */
  readonly ides: readonly JetBrainsIde[];
  readonly say: (line: string) => void;
}

export function jetbrainsDeps(config: ClientConfig | null): JetBrainsDeps {
  const machine = thisMachine();
  return {
    run: runLauncher,
    origin: apiOrigin(config),
    machine,
    backupDir: BACKUP_DIR,
    ides: jetbrainsIdes(machine),
    say: (line) => console.log(line),
  };
}

/** Each IDE's name, with its version where two of them share one. */
export function ideLabels(ides: readonly JetBrainsIde[]): string[] {
  return ides.map((ide) => {
    if (!ides.some((other) => other !== ide && other.name === ide.name)) return ide.name;
    return `${ide.name} ${/\d{4}\.\d+(?:\.\d+)?$/u.exec(ide.dataDirectory)?.[0] ?? ide.build}`;
  });
}

/** "IntelliJ IDEA, PyCharm and WebStorm". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** What a bare install's question calls the IDEs it could install into now, or null for none. */
export function readyIdesLabel(deps: Pick<JetBrainsDeps, "ides" | "machine">): string | null {
  const ready = deps.ides.filter((ide) => readiness(ide, deps.machine) === "ready");
  return ready.length === 0 ? null : namesList(ideLabels(ready));
}

/** What a developer does by hand where this could not: the step A40 asked of everyone. */
function byHand(origin: string): string {
  return `add ${repositoryUrl(origin)} under Settings → Plugins → ⚙ → Manage Plugin Repositories`;
}

function rowFor(host: string, outcome: PluginOutcome, origin: string): InstallRow {
  if (outcome.status === "open" || outcome.status === "failed") {
    return outcome.status === "open"
      ? {
          mark: "failed",
          host,
          detail: "open, so not installed",
          notes: ["quit it, then run `obrigado install --agent jetbrains` again"],
        }
      : { mark: "failed", host, detail: `failed: ${outcome.reason}` };
  }
  const plugin = outcome.version === null ? "plugin" : `plugin ${outcome.version}`;
  const after = outcome.status === "installed" ? `approve it when ${host} starts` : "already there";
  return {
    mark: "done",
    host,
    detail: `${plugin} · ${after}`,
    ...(outcome.updates ? {} : { notes: [`for updates, ${byHand(origin)}`] }),
    backedUp: outcome.backup !== null,
  };
}

async function installInto(
  ide: JetBrainsIde,
  host: string,
  deps: JetBrainsDeps,
): Promise<InstallRow> {
  const state = readiness(ide, deps.machine);
  if (state === "too-old")
    return { mark: "skipped", host, detail: `needs ${SINCE_RELEASE} or newer` };
  if (state === "never-opened") {
    return { mark: "skipped", host, detail: "never opened: open it once, then run this again" };
  }
  if (installedPluginVersion(pluginsDirectory(ide, deps.machine)) === null) {
    deps.say(`Installing the plugin into ${host}, which starts without a window to do it…`);
  }
  try {
    return rowFor(host, await installJetBrainsPlugin(ide, deps), deps.origin);
  } catch (error) {
    return failedRow(host, error);
  }
}

/** The plugin in every JetBrains IDE here, one summary line each. */
export async function installJetBrainsHost(
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
  deps: JetBrainsDeps = jetbrainsDeps(existing),
): Promise<AdapterResult[]> {
  if (deps.ides.length === 0) {
    const row: InstallRow = {
      mark: "failed",
      host: "JetBrains IDEs",
      detail: "none found",
      notes: [`to install it by hand, ${byHand(deps.origin)}`],
    };
    return [{ changed: false, failed: true, row }];
  }
  const labels = ideLabels(deps.ides);
  const results: AdapterResult[] = [];
  for (const [index, ide] of deps.ides.entries()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each IDE starts on its own, one at a time
    const row = await installInto(ide, labels[index] ?? ide.name, deps);
    results.push({ changed: row.mark === "done", failed: row.mark === "failed", row });
  }
  if (results.some((result) => result.changed)) {
    integrations.jetbrains = {
      installed: true,
      installed_at:
        editorIntegration(existing, "jetbrains")?.installed_at ?? new Date().toISOString(),
    };
  }
  return results;
}

/**
 * The repository out of every IDE, and the line off.
 *
 * No IDE takes a plugin out from its command line, and its plugins directory is the IDE's to
 * manage, so the plugin itself stays until the developer removes it in the IDE. It draws nothing
 * meanwhile: the renderer answers `--agent jetbrains` with nothing once this is recorded.
 */
export function removeJetBrains(
  make: (config: ClientConfig | null) => JetBrainsDeps = jetbrainsDeps,
): Remover {
  return async (config, integrations) => {
    const deps = make(config);
    const labels = ideLabels(deps.ides);
    const holding: string[] = [];
    for (const [index, ide] of deps.ides.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of small files
      await removeJetBrainsRepository(ide, deps);
      if (installedPluginVersion(pluginsDirectory(ide, deps.machine)) !== null) {
        holding.push(labels[index] ?? ide.name);
      }
    }
    deps.say(
      holding.length === 0
        ? "JetBrains IDEs: no Obrigado plugin found."
        : `JetBrains IDEs: the plugin draws nothing now. Remove it in Settings → Plugins in ${namesList(holding)}.`,
    );
    integrations.jetbrains = {
      ...(editorIntegration(config, "jetbrains") ?? { installed: false }),
      installed: false,
    };
  };
}
