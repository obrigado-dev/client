/**
 * What installing into Codex's `config.toml` changes, and what uninstalling puts back, worked out
 * on the file's text with nothing written.
 *
 * Kept apart from the write (`codex-statusline.ts`) so that every refusal and every edit can be
 * tested on a string. That file says what the three settings are and why install looks at the
 * developer's footer before it takes the slot; this one is the looking.
 */
import { providerIdFrom, stdioServerFrom } from "./codex-chain.ts";
import type { ProviderId } from "./codex-chain.ts";
import { DEFAULT_ITEMS, UNREDRAWABLE_ITEMS } from "./codex-footer.ts";
import { PROVIDER_SERVER, PROVIDER_TOOL } from "./codex-provider.ts";
import type { CodexIntegrationConfig } from "./config.ts";
import {
  parseToml,
  removeTomlKey,
  removeTomlTable,
  sameExcept,
  setTomlKey,
  setTomlTable,
  TomlEditError,
  tomlString,
  withoutPath,
  withPath,
} from "./toml-edit.ts";

/** The experimental switch the provider sits behind. "Custom status line" in `/experimental`. */
const FEATURE = "tui_extensions_statusline";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a saved provider is ours. */
export function isOurs(provider: ProviderId | null): boolean {
  return provider?.server === PROVIDER_SERVER && provider.tool === PROVIDER_TOOL;
}

/** A provider as Codex's own picker writes one, an inline table. */
function providerLiteral(provider: ProviderId): string {
  return `{ server = ${tomlString(provider.server)}, tool = ${tomlString(provider.tool)} }`;
}

/** Our MCP server's table: the command, then everything after it. */
function serverEntry(argv: readonly string[]): { command: string; args: string[] } {
  const [command = "obrigado", ...args] = argv;
  return { command, args };
}

function serverBody(argv: readonly string[]): string[] {
  const { command, args } = serverEntry(argv);
  return [
    `command = ${tomlString(command)}`,
    `args = [${args.map((arg) => tomlString(arg)).join(", ")}]`,
  ];
}

/**
 * The three settings as TOML, for the developer to add where this client will not edit the file.
 */
export function codexConfigBlock(argv: readonly string[]): string {
  return [
    "[features]",
    `${FEATURE} = true`,
    "",
    "[tui]",
    `status_line_provider = ${providerLiteral({ server: PROVIDER_SERVER, tool: PROVIDER_TOOL })}`,
    "",
    `[mcp_servers.${PROVIDER_SERVER}]`,
    ...serverBody(argv),
  ].join("\n");
}

/** Why install left Codex's config as it was. */
export type CodexRefusal =
  /** No `codex` on PATH to ask its version of. */
  | { readonly kind: "no-binary" }
  | { readonly kind: "too-old"; readonly version: string }
  /** `config.toml` is not TOML this client can read. */
  | { readonly kind: "unreadable" }
  /** Another provider has the slot. `chainable` is whether `--chain` could keep it. */
  | { readonly kind: "provider"; readonly provider: ProviderId; readonly chainable: boolean }
  /** The developer's footer shows items a provider is not told the value of. */
  | { readonly kind: "items"; readonly items: readonly string[] }
  /** The edit could not be made safely, or Codex would not read the result. */
  | { readonly kind: "uneditable"; readonly why: string };

/** What install records, so uninstall can put it back. */
export type CodexRecord = Pick<
  CodexIntegrationConfig,
  "previous_provider" | "chained_provider" | "previous_feature"
>;

/** What an install changes, worked out from the file's text with nothing written yet. */
export type CodexPlan =
  | { readonly status: "refused"; readonly refusal: CodexRefusal }
  | {
      readonly status: "planned";
      /** The file as it should be. Equal to what it is when there is nothing to do. */
      readonly next: string;
      readonly record: CodexRecord;
      /** Items of the developer's footer that `--replace` gave up. */
      readonly dropped: readonly string[];
    };

export interface CodexPlanOptions {
  readonly chain?: boolean;
  readonly replace?: boolean;
  /** How Codex starts the provider. */
  readonly argv: readonly string[];
  /** What an earlier install recorded, kept where ours is already in the slot. */
  readonly record?: CodexIntegrationConfig | null;
}

/** The items Codex's own footer shows for this config that a provider cannot draw back. */
function lostItems(config: Record<string, unknown>): string[] {
  const tui = isRecord(config["tui"]) ? config["tui"] : {};
  const configured = tui["status_line"];
  const items: readonly unknown[] = Array.isArray(configured) ? configured : DEFAULT_ITEMS;
  return items.filter(
    (item): item is string => typeof item === "string" && UNREDRAWABLE_ITEMS.includes(item),
  );
}

/**
 * Whose footer is drawn beside ours, or the refusal where another provider keeps the slot.
 *
 * Another provider's is chained only where `--chain` asks and its server can be started from this
 * file. `--replace` alone takes the slot from it. Where ours is already there, the provider an
 * earlier install chained is kept for as long as it can still be started.
 */
function chainedFor(
  config: Record<string, unknown>,
  provider: ProviderId | null,
  options: CodexPlanOptions,
): { readonly chained: ProviderId | undefined } | CodexRefusal {
  if (provider === null) return { chained: undefined };
  if (isOurs(provider)) {
    const earlier = options.record?.chained_provider;
    const kept = earlier !== undefined && stdioServerFrom(config, earlier.server) !== null;
    return { chained: kept ? earlier : undefined };
  }
  const chainable = stdioServerFrom(config, provider.server) !== null;
  if (options.chain === true && chainable) return { chained: provider };
  if (options.replace === true && options.chain !== true) return { chained: undefined };
  return { kind: "provider", provider, chainable };
}

/**
 * The file with our three settings in it, or the refusal where it cannot be edited safely.
 *
 * Each is written only where it is not already as it should be, so a second install changes
 * nothing. The result is then held to exactly those three settings (`sameExcept`).
 */
function withOurs(
  text: string,
  before: Record<string, unknown>,
  argv: readonly string[],
): string | CodexRefusal {
  const tui = isRecord(before["tui"]) ? before["tui"] : {};
  const features = isRecord(before["features"]) ? before["features"] : {};
  const servers = isRecord(before["mcp_servers"]) ? before["mcp_servers"] : {};
  const identity = { server: PROVIDER_SERVER, tool: PROVIDER_TOOL };
  const entry = serverEntry(argv);

  let next = text;
  try {
    if (features[FEATURE] !== true) next = setTomlKey(next, ["features"], FEATURE, "true");
    if (!isOurs(providerIdFrom(tui["status_line_provider"]))) {
      next = setTomlKey(next, ["tui"], "status_line_provider", providerLiteral(identity));
    }
    if (!Bun.deepEquals(servers[PROVIDER_SERVER], entry, true)) {
      next = setTomlTable(next, ["mcp_servers", PROVIDER_SERVER], serverBody(argv));
    }
  } catch (error) {
    if (!(error instanceof TomlEditError)) throw error;
    return { kind: "uneditable", why: error.message };
  }

  const expected = (tree: Record<string, unknown>): Record<string, unknown> =>
    withPath(
      withPath(
        withPath(tree, ["features", FEATURE], true),
        ["tui", "status_line_provider"],
        identity,
      ),
      ["mcp_servers", PROVIDER_SERVER],
      entry,
    );
  return sameExcept(text, next, expected)
    ? next
    : { kind: "uneditable", why: "the file is laid out in a way this cannot edit safely" };
}

/**
 * What installing into this `config.toml` would write, or why it will not.
 *
 * Pure, so every refusal and every edit can be tested on text. `installCodexStatusLine` is this
 * and then the write.
 */
export function planCodexInstall(text: string, options: CodexPlanOptions): CodexPlan {
  const before = parseToml(text);
  if (before === null) return { status: "refused", refusal: { kind: "unreadable" } };

  const tui = isRecord(before["tui"]) ? before["tui"] : {};
  const features = isRecord(before["features"]) ? before["features"] : {};
  const current = tui["status_line_provider"];
  const provider = providerIdFrom(current);
  const ours = isOurs(provider);

  const chain = chainedFor(before, provider, options);
  if ("kind" in chain) return { status: "refused", refusal: chain };
  const { chained } = chain;

  // Codex's own footer is only at stake where it is what we will be drawing.
  const lost = chained === undefined ? lostItems(before) : [];
  if (lost.length > 0 && !ours && options.replace !== true) {
    return { status: "refused", refusal: { kind: "items", items: lost } };
  }

  const featureOn = features[FEATURE] === true;
  const next = withOurs(text, before, options.argv);
  if (typeof next !== "string") return { status: "refused", refusal: next };

  const earlier = options.record ?? null;
  // Recorded only where an install is what turned the switch on. A reinstall keeps the first
  // answer, and one that found it on already records nothing, so uninstall leaves it on.
  const previousFeature = featureOn
    ? earlier?.previous_feature
    : features[FEATURE] === false
      ? false
      : null;
  return {
    status: "planned",
    next,
    record: {
      // What the slot held before ours ever took it.
      previous_provider: ours ? (earlier?.previous_provider ?? null) : (current ?? null),
      chained_provider: chained,
      ...(previousFeature === undefined ? {} : { previous_feature: previousFeature }),
    },
    dropped: lost,
  };
}

/** The file with ours taken out, and whether anything of ours was in it. */
export interface CodexRemoval {
  readonly next: string;
  /**
   * `foreign` where another provider has the slot now: it is left exactly as it is, and only our
   * server's table went. `unreadable` where the file could not be edited safely, and was not.
   */
  readonly outcome: "removed" | "not-installed" | "foreign" | "unreadable";
}

type Step = (tree: Record<string, unknown>) => Record<string, unknown>;

/**
 * What uninstalling from this `config.toml` would write.
 *
 * The slot goes back to what it held before install, the switch to what it was where install is
 * what turned it on, and our server's table goes. Where the developer has since picked another
 * provider, that choice and the switch it needs are theirs and stay; only our server is removed.
 */
export function planCodexUninstall(
  text: string,
  record: CodexIntegrationConfig | null,
): CodexRemoval {
  const before = parseToml(text);
  if (before === null) return { next: text, outcome: "unreadable" };

  const tui = isRecord(before["tui"]) ? before["tui"] : {};
  const servers = isRecord(before["mcp_servers"]) ? before["mcp_servers"] : {};
  const provider = providerIdFrom(tui["status_line_provider"]);
  const ours = isOurs(provider);

  let next = text;
  const steps: Step[] = [];
  try {
    if (ours) {
      const previous = record?.previous_provider;
      const theirs = providerIdFrom(previous);
      const handedBack = theirs !== null && !isOurs(theirs);
      if (handedBack) {
        next = setTomlKey(next, ["tui"], "status_line_provider", providerLiteral(theirs));
        steps.push((tree) => withPath(tree, ["tui", "status_line_provider"], theirs));
      } else if (previous === "default") {
        next = setTomlKey(next, ["tui"], "status_line_provider", '"default"');
        steps.push((tree) => withPath(tree, ["tui", "status_line_provider"], "default"));
      } else {
        next = removeTomlKey(next, ["tui"], "status_line_provider");
        steps.push((tree) => withoutPath(tree, ["tui", "status_line_provider"]));
      }
      // The switch goes back only where the slot does not go to a provider that needs it on.
      if (!handedBack && record?.previous_feature === false) {
        next = setTomlKey(next, ["features"], FEATURE, "false");
        steps.push((tree) => withPath(tree, ["features", FEATURE], false));
      } else if (!handedBack && record?.previous_feature === null) {
        next = removeTomlKey(next, ["features"], FEATURE);
        steps.push((tree) => withoutPath(tree, ["features", FEATURE]));
      }
    }
    if (PROVIDER_SERVER in servers) {
      next = removeTomlTable(next, ["mcp_servers", PROVIDER_SERVER]);
      steps.push((tree) => withoutPath(tree, ["mcp_servers", PROVIDER_SERVER]));
    }
  } catch (error) {
    if (!(error instanceof TomlEditError)) throw error;
    return { next: text, outcome: "unreadable" };
  }

  const expected: Step = (tree) => steps.reduce((value, step) => step(value), tree);
  if (!sameExcept(text, next, expected)) return { next: text, outcome: "unreadable" };
  if (next === text) return { next, outcome: "not-installed" };
  return { next, outcome: !ours && provider !== null ? "foreign" : "removed" };
}
