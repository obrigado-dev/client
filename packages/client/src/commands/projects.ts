/**
 * `obrigado read`, the retrieval hook, and `obrigado summary` (§14 Phase 1).
 *
 * `obrigado projects` and `obrigado share` were here too: a ranked list of which packages an
 * install had funded and how much each got, and a public page for showing it off. A36 ended
 * per-package allocation and there was no list left to rank.
 *
 * Every command here degrades to something useful offline. §14 makes this the retention
 * mechanic; a retention mechanic that prints a stack trace on a train is not one.
 */
import { fetchStats } from "../api.ts";
import { readStdinPayload } from "../chain.ts";
import { readConfig } from "../config.ts";
import { rendererCommand } from "../renderer-command.ts";
import { pathOfHookInput, recordRead } from "../retrieval.ts";
import { apiOrigin } from "./shared.ts";
import { formatUsd, microsFromWire } from "@obrigado/shared/money";

/**
 * `obrigado read` — the retrieval hook target (§14 Phase 6).
 *
 * Invoked by a `PostToolUse` hook on the read tools, which sends the tool's input as JSON on
 * stdin. A path argument is for running it by hand. Resolves the path to a package LOCALLY
 * and queues only the package id; a path that does not resolve to a package is dropped
 * entirely, because "somewhere in the project" is exactly the private part.
 *
 * Always exits 0 and prints nothing. This runs inside the agent's tool loop, and a retrieval
 * hook that fails loudly has broken something far more important than an ad.
 */
export async function read(path: string | undefined): Promise<number> {
  const config = await readConfig();
  // Opt-out honoured here too: a developer who turned the summary off has said they do not
  // want this client doing extra work on their machine.
  if (config === null) return 0;
  // An empty argument falls through to stdin as well. The config this command used to print
  // passed `"$CLAUDE_TOOL_INPUT_FILE_PATH"`, which Claude Code never sets, so a developer who
  // pasted it arrives here with an empty argument and starts recording without pasting again.
  const target =
    path !== undefined && path.length > 0 ? path : pathOfHookInput(await readStdinPayload());
  if (target !== null) await recordRead(target);
  return 0;
}

/**
 * The CLI invoked the way the status line invokes it, running `subcommand` instead.
 *
 * A printed hook has the same three cases as an installed status line — PATH, a compiled
 * binary, a checkout — so it takes the same answer, and a bare `obrigado` is wrong for two of
 * them. The subcommand REPLACES `statusline`: appending it as well once printed `… read read`,
 * which recorded the literal string "read".
 */
function hookCommand(subcommand: string): string {
  const override = process.env["OBRIGADO_STATUSLINE_COMMAND"];
  const base = override !== undefined && override.length > 0 ? override : rendererCommand();
  return base.replace(/statusline$/u, subcommand);
}

/**
 * The retrieval hook config, printed for the same reason as the summary hook.
 *
 * `statusline.ts` rule 1 — exactly one key in one file — is worth more than the convenience,
 * and A7 records the full argument.
 */
export function printRetrievalHook(): void {
  console.log("Add this to the `hooks` key in ~/.claude/settings.json:\n");
  console.log(
    JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            {
              matcher: "Read|Edit|Grep",
              hooks: [
                {
                  type: "command",
                  command: hookCommand("read"),
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );

  console.log("\n  What this does: when your agent reads a file inside a package, that");
  console.log("  package counts DOUBLE in the month's allocation. Nothing else changes.");
  console.log("\n  What leaves your machine: the package name. Never the path. A path like");
  console.log("  ~/Code/acme-internal/billing/rates.ts names a person, a company and a");
  console.log("  feature, so it is resolved to a package locally and then discarded — and a");
  console.log("  path that is not inside a package is dropped entirely.");
  console.log("\n  Entirely optional. Without it your dependencies are still funded by");
  console.log("  dependency weight alone, and no package is penalised for its absence.");
}

/**
 * The hook config, PRINTED rather than written.
 *
 * `statusline.ts` rule 1 is that exactly one key in one file is ever written:
 * `statusLine`. INVARIANT 11 permits documented hooks, so writing a `hooks` entry
 * would not violate the spec — but it would cost the property that makes rule 1
 * worth having, which is that a reviewer can verify the claim in seconds rather
 * than by reading an argument.
 *
 * And the trade is bad in this specific case, because delivery is unverified.
 * `systemMessage` is documented as universal and user-visible, but `SessionEnd`
 * fires while the session is tearing down and there is no way to confirm from here
 * that the host still renders it. Silently mutating a developer's settings for a
 * line that may never appear is worse than one copy-paste. See A7.
 */
function printHook(): void {
  console.log("Add this to the `hooks` key in ~/.claude/settings.json:\n");
  console.log(
    JSON.stringify(
      {
        hooks: {
          SessionEnd: [
            { hooks: [{ type: "command", command: `${hookCommand("summary")} --json` }] },
          ],
        },
      },
      null,
      2,
    )
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );

  console.log("\n  Obrigado does not write this for you, deliberately: `obrigado install` touches");
  console.log("  exactly one key (`statusLine`) so that claim stays trivially checkable.");
  console.log("  Turn the line off any time with `obrigado config session_summary false`.");
  console.log("\n  Delivery depends on your agent surfacing a hook's `systemMessage`. If nothing");
  console.log("  appears, `obrigado status` shows the same figures on demand.");
}

export async function summary(asJson: boolean, printHookOnly = false): Promise<number> {
  if (printHookOnly) {
    printHook();
    return 0;
  }
  return await renderSummary(asJson);
}

async function renderSummary(asJson: boolean): Promise<number> {
  const config = await readConfig();
  // Opt-out, per §14. A disabled summary prints nothing at all rather than a
  // message saying it is disabled — the whole point is not adding noise.
  if (config === null || config.session_summary === false) return 0;

  const stats = await fetchStats({
    apiOrigin: apiOrigin(config),
    installKey: config.install_key,
  });
  if (stats === null || stats.impressions === 0) return 0;

  const line =
    `This session put ${formatUsd(microsFromWire(stats.period_micros))} toward ` +
    "open source maintenance this month";

  if (asJson) {
    // `systemMessage` is the one hook field the host shows the user. Anything on
    // stdout goes to the debug log for every event except the three that feed
    // Claude context — see A7.
    console.log(JSON.stringify({ systemMessage: line }));
  } else {
    console.log(line);
  }
  return 0;
}
