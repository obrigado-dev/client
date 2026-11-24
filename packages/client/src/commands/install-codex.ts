/**
 * Codex's install and uninstall reporting.
 *
 * In its own file for the reason the Pi, desktop app and Antigravity adapters are: `install.ts` is
 * at its line budget. What is written lives one layer down, in `codex-statusline.ts`; these decide
 * what the developer is told and what the install records.
 *
 * A refusal here is told two ways, as it always was for this host. Asked for by name, Codex
 * deserves the whole reason and a non-zero exit: the developer wanted a specific thing and did not
 * get it, and a script should be able to tell. A bare `install` merely noticed Codex, so a Codex
 * too old for a provider is one line and no failure: it would punish a machine that has an old
 * Codex beside a Claude Code this configured perfectly well. A refusal about the developer's own
 * footer fails either way, like Claude Code's, because there is something for them to decide.
 */
import { codexConfigBlock } from "../codex-plan.ts";
import type { CodexRefusal } from "../codex-plan.ts";
import {
  CODEX_CONFIG_PATH,
  CODEX_PROVIDER_ISSUE,
  codexProviderArgv,
  installCodexStatusLine,
  MINIMUM_CODEX,
  uninstallCodexStatusLine,
} from "../codex-statusline.ts";
import type { CodexInstallOutcome } from "../codex-statusline.ts";
import { codexIntegration } from "../config.ts";
import type { ClientConfig, ClientIntegrations } from "../config.ts";
import type { AdapterResult, InstallRow, Remover } from "./adapters.ts";
import { failedRow, tilde } from "./install-report.ts";

const LABEL = "Codex";

/** The settings to add by hand, indented to sit under a row. */
function byHand(): string[] {
  return [
    `to add it yourself, put this in ${tilde(CODEX_CONFIG_PATH)}:`,
    ...codexConfigBlock(codexProviderArgv())
      .split("\n")
      .map((line) => (line.length === 0 ? "" : `  ${line}`)),
  ];
}

/** A Codex with no provider, or none to ask: a line for a bare install, a failure by name. */
function versionRow(
  refusal: Extract<CodexRefusal, { kind: "no-binary" | "too-old" }>,
  explicit: boolean,
): Refused {
  const found =
    refusal.kind === "too-old" ? `Codex ${refusal.version}` : "no `codex` on PATH to ask";
  const detail = `needs Codex ${MINIMUM_CODEX} or later for a status line (${found})`;
  if (!explicit) return { failed: false, row: { mark: "skipped", host: LABEL, detail } };
  const notes = [
    "update Codex (`codex update`), then run `obrigado install` again",
    CODEX_PROVIDER_ISSUE.replace("https://", ""),
  ];
  return { failed: true, row: { mark: "failed", host: LABEL, detail, notes } };
}

/** Something of the developer's has the footer: what it is, and the two ways through. */
function footerRow(refusal: Extract<CodexRefusal, { kind: "provider" | "items" }>): Refused {
  const file = tilde(CODEX_CONFIG_PATH);
  if (refusal.kind === "items") {
    return refused(
      `your footer shows ${refusal.items.join(", ")}, which ours could not keep; left as it was`,
      [
        "a Codex status line provider draws the whole footer, and Codex does not tell it these",
        "take them out with /statusline and install again, or --replace installs without them",
      ],
    );
  }
  const { server, tool } = refusal.provider;
  return refused(`you already have a status line provider in ${file}, left as it was`, [
    `${server} · ${tool}`,
    refusal.chainable
      ? "--chain keeps its footer and adds ours beside it; --replace takes the slot (uninstall puts yours back)"
      : "it is not a command in that file, so --chain cannot run it; --replace takes the slot (uninstall puts yours back)",
  ]);
}

interface Refused {
  readonly row: InstallRow;
  readonly failed: boolean;
}

function refused(detail: string, notes: readonly string[]): Refused {
  return { failed: true, row: { mark: "failed", host: LABEL, detail, notes } };
}

/** What a refusal says, and whether a bare install counts it a failure. */
export function refusalRow(refusal: CodexRefusal, explicit: boolean): Refused {
  const file = tilde(CODEX_CONFIG_PATH);
  switch (refusal.kind) {
    case "no-binary":
    case "too-old":
      return versionRow(refusal, explicit);
    case "provider":
    case "items":
      return footerRow(refusal);
    case "unreadable":
      return refused(`could not read ${file} as TOML, left as it was`, byHand());
    case "uneditable":
      return refused(`${file} left as it was: ${refusal.why}`, byHand());
    default:
      return refusal satisfies never;
  }
}

/** What a finished install says. */
function installedRow(outcome: Exclude<CodexInstallOutcome, { status: "refused" }>): InstallRow {
  const already = outcome.status === "already-installed";
  const chained = outcome.record.chained_provider;
  const notes = [
    ...(chained === undefined
      ? ["your footer is drawn as before, with ours after it"]
      : [`your provider still draws the footer, with ours after it: ${chained.server}`]),
    ...(outcome.dropped.length === 0
      ? []
      : [`no longer shown, since a provider is not told them: ${outcome.dropped.join(", ")}`]),
    ...(outcome.record.previous_feature === undefined || already
      ? []
      : ["turned on Codex's experimental custom status line; uninstall turns it back off"]),
  ];
  return {
    mark: "done",
    host: LABEL,
    detail: `status line provider · ${tilde(CODEX_CONFIG_PATH)} · ${already ? "already there" : "restart Codex"}`,
    notes,
    backedUp: outcome.status === "installed" && outcome.backup !== null,
  };
}

export interface CodexAdapterOptions {
  /** Whether Codex was asked for by name, as against noticed by a bare install. */
  readonly explicit: boolean;
  readonly chain: boolean;
  readonly replace: boolean;
}

export async function installCodexAdapter(
  existing: ClientConfig | null,
  integrations: ClientIntegrations,
  options: CodexAdapterOptions,
): Promise<AdapterResult> {
  try {
    const current = codexIntegration(existing);
    const outcome = await installCodexStatusLine({
      chain: options.chain,
      replace: options.replace,
      record: current,
    });
    if (outcome.status === "refused") {
      const { row, failed } = refusalRow(outcome.refusal, options.explicit);
      return { changed: false, failed, row };
    }
    integrations.codex = {
      installed: true,
      installed_at: current?.installed_at ?? new Date().toISOString(),
      ...outcome.record,
    };
    return { changed: true, failed: false, row: installedRow(outcome) };
  } catch (error) {
    return { changed: false, failed: true, row: failedRow(LABEL, error) };
  }
}

/**
 * Takes ours out and records the host uninstalled, except where the file could not be edited
 * safely: then nothing was removed, and saying it was would leave the developer with a provider
 * this client no longer admits to.
 */
export const removeCodex: Remover = async (config, integrations) => {
  const current = codexIntegration(config);
  const result = await uninstallCodexStatusLine(current);
  const file = tilde(CODEX_CONFIG_PATH);
  if (result === "unreadable") {
    throw new Error(
      `could not edit ${file} safely; remove [mcp_servers.obrigado] and tui.status_line_provider there yourself`,
    );
  }
  console.log(
    result === "removed"
      ? `${LABEL}: removed Obrigado's status line provider and put back what was there.`
      : result === "foreign"
        ? `${LABEL}: another provider has the footer now and was left alone; removed Obrigado's server.`
        : `${LABEL}: no Obrigado status line provider found.`,
  );
  // What install recorded is spent: the slot has been handed back.
  integrations.codex = {
    installed: false,
    ...(current?.installed_at === undefined ? {} : { installed_at: current.installed_at }),
  };
};
