/**
 * JetBrains IDEs: what the question names, the install into each IDE, the daily refresh, and the
 * removal (A43).
 *
 * One host to `obrigado install`, because the IDEs are one platform running one plugin, and one
 * line per IDE in the summary, because each is installed, or refused, on its own. What is found
 * and where it lives is `jetbrains-ides.ts`; the checked copy the IDEs install from is
 * `jetbrains-repository.ts`; what is run and written in each IDE is `jetbrains-plugin.ts`.
 */
import { BACKUP_DIR, editorIntegration } from "../config.ts";
import type { ClientConfig, ClientIntegrations } from "../config.ts";
import {
  inJetBrainsTerminal,
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
  pointAtRepository,
  removeJetBrainsRepository,
  repositoryUrl,
  runLauncher,
} from "../jetbrains-plugin.ts";
import type { PluginDeps, PluginOutcome } from "../jetbrains-plugin.ts";
import {
  JETBRAINS_REPOSITORY_DIR,
  localRepositoryUrl,
  prepareRepository,
  removeRepository,
} from "../jetbrains-repository.ts";
import type { RepositoryDeps } from "../jetbrains-repository.ts";
import { CLIENT_VERSION } from "../version.ts";
import type { AdapterResult, InstallRow, Remover } from "./adapters.ts";
import { failedRow } from "./install-report.ts";
import { apiOrigin } from "./shared.ts";

export interface JetBrainsDeps extends Omit<PluginDeps, "repository">, RepositoryDeps {
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
    fetch: (input, init) => fetch(input, init),
    current: CLIENT_VERSION,
    repositoryDir: JETBRAINS_REPOSITORY_DIR,
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

/** What a developer does by hand where this could not. */
function byHand(url: string): string {
  return `add ${url} under Settings → Plugins → ⚙ → Manage Plugin Repositories`;
}

const AGAIN = "`obrigado install --agent jetbrains`";

/**
 * What to do about an IDE that is open. Run from a JetBrains IDE's own terminal, "quit it and run
 * this again" is a loop: the terminal closes with the IDE, so the next run has to come from a
 * terminal app outside it.
 */
function whenOpen(host: string, deps: JetBrainsDeps): string {
  return inJetBrainsTerminal(deps.machine)
    ? `this terminal is in a JetBrains IDE and closes with it: quit ${host}, then run ${AGAIN} in a terminal app outside the IDE`
    : `quit it, then run ${AGAIN} again`;
}

function rowFor(
  host: string,
  outcome: PluginOutcome,
  deps: PluginDeps & JetBrainsDeps,
): InstallRow {
  if (outcome.status === "open" || outcome.status === "failed") {
    return outcome.status === "open"
      ? { mark: "failed", host, detail: "open, so not installed", notes: [whenOpen(host, deps)] }
      : { mark: "failed", host, detail: `failed: ${outcome.reason}` };
  }
  const plugin = outcome.version === null ? "plugin" : `plugin ${outcome.version}`;
  const after = outcome.status === "installed" ? `approve it when ${host} starts` : "already there";
  return {
    mark: "done",
    host,
    detail: `${plugin} · ${after}`,
    ...(outcome.updates ? {} : { notes: [`for updates, ${byHand(deps.repository)}`] }),
    backedUp: outcome.backup !== null,
  };
}

/** Why an IDE is skipped, or null when the plugin can go into it now. */
function skipped(ide: JetBrainsIde, host: string, deps: JetBrainsDeps): InstallRow | null {
  const state = readiness(ide, deps.machine);
  if (state === "too-old")
    return { mark: "skipped", host, detail: `needs ${SINCE_RELEASE} or newer` };
  if (state === "never-opened") {
    return { mark: "skipped", host, detail: "never opened: open it once, then run this again" };
  }
  return null;
}

async function installInto(
  ide: JetBrainsIde,
  host: string,
  deps: PluginDeps & JetBrainsDeps,
): Promise<InstallRow> {
  if (installedPluginVersion(pluginsDirectory(ide, deps.machine)) === null) {
    deps.say(`Installing the plugin into ${host}, which starts without a window to do it…`);
  }
  try {
    return rowFor(host, await installJetBrainsPlugin(ide, deps), deps);
  } catch (error) {
    return failedRow(host, error);
  }
}

/** The plugin in every JetBrains IDE here, from the checked copy, one summary line each. */
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
      notes: [`to install it by hand, ${byHand(repositoryUrl(deps.origin))}`],
    };
    return [{ changed: false, failed: true, row }];
  }
  const labels = ideLabels(deps.ides);
  const ready = deps.ides.some((ide) => readiness(ide, deps.machine) === "ready");
  // Fetched and checked once for every IDE, and only when one can take it.
  const repository = ready ? await prepareRepository(deps) : null;
  const results: AdapterResult[] = [];
  for (const [index, ide] of deps.ides.entries()) {
    const host = labels[index] ?? ide.name;
    const row =
      skipped(ide, host, deps) ??
      (repository?.ok === true
        ? // oxlint-disable-next-line eslint/no-await-in-loop -- each IDE starts on its own, one at a time
          await installInto(ide, host, { ...deps, repository: repository.url })
        : failedRow(host, new Error(repository?.ok === false ? repository.reason : "not checked")));
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
 * The next release's plugin into the repository here, for the IDEs to offer at their next update
 * check, and every IDE holding the plugin pointed at it. That last also moves an IDE that 0.3.9
 * pointed at obrigado.dev over to the checked copy.
 */
export async function refreshJetBrains(
  config: ClientConfig | null,
  say: (line: string) => void,
  deps: JetBrainsDeps = jetbrainsDeps(config),
): Promise<void> {
  if (editorIntegration(config, "jetbrains")?.installed !== true) return;
  const repository = await prepareRepository(deps);
  if (!repository.ok) {
    say(`JetBrains IDEs: not updated: ${repository.reason}.`);
    return;
  }
  const holding = deps.ides.filter(
    (ide) => installedPluginVersion(pluginsDirectory(ide, deps.machine)) !== null,
  );
  await Promise.all(
    holding.map((ide) => pointAtRepository(ide, { ...deps, repository: repository.url })),
  );
  if (repository.fresh) {
    say(`JetBrains IDEs: plugin ${repository.version}, offered at each IDE's next update check.`);
  }
}

/**
 * The repositories out of every IDE, the copy here deleted, and the line off.
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
    const local = { ...deps, repository: localRepositoryUrl(deps.repositoryDir) };
    const labels = ideLabels(deps.ides);
    const holding: string[] = [];
    for (const [index, ide] of deps.ides.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of small files
      await removeJetBrainsRepository(ide, local);
      if (installedPluginVersion(pluginsDirectory(ide, deps.machine)) !== null) {
        holding.push(labels[index] ?? ide.name);
      }
    }
    // No IDE is pointed at it any more.
    await removeRepository(deps.repositoryDir);
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
