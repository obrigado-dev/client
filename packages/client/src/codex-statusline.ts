/**
 * Codex's status line — the shape this takes the day upstream support lands.
 *
 * Codex renders its footer from a CLOSED set of built-in item identifiers
 * (`model-with-reasoning`, `context-remaining`, `current-dir`, `thread-title`,
 * …). There is no item that runs a command, reads a file, or renders literal
 * text, and unknown identifiers are rejected by config validation rather than
 * passed through. So there is currently nowhere for a sponsor to go.
 *
 * Everything reachable today was measured and rejected:
 *
 *   - `Stop` / `UserPromptSubmit` hooks. Delivered, then withdrawn. Codex frames
 *     hook output as `• Stop (completed) says: …` — host-owned chrome we cannot
 *     remove — renders Markdown literally, and strips OSC 8. The result was an
 *     unlabeled-looking warning cell with no clickable copy. Shipping it would
 *     have traded the product's whole presentation for coverage.
 *   - `workspace-headline`. The one built-in fed by an external push, and the
 *     proof this renderer CAN carry async remote text — but it is Enterprise-only
 *     and sourced from OpenAI's backend.
 *   - `task-progress`. Fed by the model's `update_plan` tool, so filling it means
 *     putting sponsored copy in generated output. §3 forbids exactly that.
 *   - `thread-title`. The only externally writable slot, via the app-server's
 *     `thread/name/set`. Rotating a sponsor through it would overwrite the
 *     developer's own thread title in persisted state, where it shows up in
 *     `/rename`, the resume picker, and the desktop app. Their session metadata
 *     is not ours to spend.
 *
 * What lands instead is a command-backed item, tracked in
 * https://github.com/openai/codex/issues/17827. Its contract is deliberately
 * Claude Code's `statusLine` contract — JSON session context on stdin, one line
 * of text on stdout — so `obrigado statusline` is already the whole adapter and
 * this module only has to write config. That is why nothing here re-implements
 * delivery: there is no second renderer to keep in sync, by design.
 *
 * Until it lands, `install` REFUSES rather than degrading. A refusal that names
 * the blocker costs a developer one command; a worse surface installed quietly
 * costs them trust in the disclosure, which is the only thing making sponsored
 * copy acceptable in their terminal at all.
 */
import { existsSync } from "node:fs";

import { dirname, join } from "node:path";

import { CODEX_HOME } from "./config.ts";

/** Codex's user-level config. The `[tui]` table lives here. */
const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");

/** Where the sponsored item sits among Codex's built-in footer items. */
const CODEX_STATUS_LINE_ITEM = "custom";

/** The upstream capability this integration waits on. */
export const CODEX_TRACKING_ISSUE = "https://github.com/openai/codex/issues/17827";

/**
 * The command Codex will invoke.
 *
 * Mirrors `statusLineCommand()` — including the source-checkout fallback, since
 * a command that is not on PATH renders nothing and looks exactly like a broken
 * product — and adds the host so impressions attribute to `codex` rather than
 * inheriting the Claude default. Attribution is decided at install time because
 * that is when it is a fact; sniffing it per render would be a guess.
 */
export function codexStatusLineCommand(): string {
  const override = process.env["OBRIGADO_CODEX_STATUSLINE_COMMAND"];
  if (override !== undefined && override.length > 0) return override;

  const cli = join(dirname(import.meta.path), "cli.ts");
  return Bun.which("obrigado") === null
    ? `${process.execPath} ${cli} statusline --agent codex`
    : "obrigado statusline --agent codex";
}

/**
 * The exact TOML we will write, rendered so it can be reviewed — and pasted by
 * hand today by anyone running a build with the patch.
 *
 * Keys follow the contract on the reference branch: a `command` string, a
 * refresh interval whose floor upstream sets at 1s, and a timeout. `custom` is
 * additive — it takes a position among the built-ins rather than replacing the
 * footer, because Codex's operational fields (model, permissions, context) are
 * the developer's, not inventory.
 */
export function codexConfigBlock(command = codexStatusLineCommand()): string {
  return [
    "[tui]",
    `status_line = ["model-with-reasoning", "context-remaining", "current-dir", "${CODEX_STATUS_LINE_ITEM}"]`,
    "",
    "[tui.status_line_command]",
    `command = ${JSON.stringify(command)}`,
    "refresh_interval_ms = 30000",
    "timeout_ms = 1000",
  ].join("\n");
}

/**
 * Refusal carrying the reason, so the CLI never has to restate it and the two
 * cannot drift apart.
 */
export class CodexUnsupportedError extends Error {
  constructor() {
    super(
      [
        "Codex has no status-line extension point yet, so Obrigado has nothing safe to install.",
        "",
        "Its footer accepts only built-in item identifiers; no item runs a command or renders",
        "supplied text. The lifecycle-hook surface was tried and withdrawn — Codex frames hook",
        "output as its own warning cell, renders Markdown literally, and strips terminal",
        "hyperlinks, so the copy cannot be labeled or clicked the way §3 requires.",
        "",
        `Tracking upstream: ${CODEX_TRACKING_ISSUE}`,
        "",
        "That issue's contract is Claude Code's statusLine contract, so `obrigado statusline`",
        "already satisfies it. When it ships, this becomes a config write and nothing else.",
        "",
        `If you build Codex with the patch, add this to ${CODEX_CONFIG_PATH}:`,
        "",
        codexConfigBlock()
          .split("\n")
          .map((line) => (line.length === 0 ? "" : `  ${line}`))
          .join("\n"),
      ].join("\n"),
    );
    this.name = "CodexUnsupportedError";
  }
}

/** Whether Codex is present at all, independent of whether we can serve it. */
export function codexDetected(): boolean {
  return Bun.which("codex") !== null || existsSync(CODEX_HOME);
}

export interface CodexSupport {
  readonly supported: boolean;
  readonly reason: string;
  readonly issue: string;
}

/**
 * One place that answers "can we serve Codex yet". `status`, `doctor`, and
 * `install` all read it, so the day upstream ships there is a single flag to
 * flip rather than three call sites to find.
 */
export function codexSupport(): CodexSupport {
  return {
    supported: false,
    reason: "Codex exposes no command-backed status-line item yet",
    issue: CODEX_TRACKING_ISSUE,
  };
}

/**
 * Write the status-line config into Codex's user config.
 *
 * Unimplemented on purpose. The upstream contract is still being chosen between
 * two competing reference branches, and the risky half of this function is not
 * the shape of the block — that is settled — but editing a developer's live
 * `config.toml` in place while preserving their comments, table order, and
 * formatting. Writing that against a contract that can still move would mean
 * maintaining a TOML rewriter for a key that might be renamed.
 */
export function installCodexStatusLine(): Promise<never> {
  return Promise.reject(new CodexUnsupportedError());
}

/**
 * Nothing was ever written, so there is nothing to take back.
 *
 * Present only so `uninstall --agent codex` answers instead of crashing. An
 * earlier revision carried a remover for the withdrawn hook handlers; it was
 * deleted along with the feature, because Obrigado has no released version that
 * ever wrote them. Carrying a cleanup path for a population of zero is how a
 * codebase starts owing a compatibility debt it never actually incurred.
 */
export function uninstallCodexStatusLine(): Promise<"not-installed"> {
  return Promise.resolve("not-installed");
}
