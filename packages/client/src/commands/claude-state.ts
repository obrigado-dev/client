/**
 * What the Claude Code integration record should say after an install.
 *
 * Both decisions here are about STICKINESS — what survives a re-run of `obrigado install` that
 * the developer only meant as an upgrade. Getting either wrong loses something they chose: the
 * command they had before us, or the row they put our line on.
 */
import { chainableCommand } from "./shared.ts";
import type { ClaudeIntegrationConfig, SponsoredPosition } from "../config.ts";

/**
 * Which row the developer asked the sponsored line to take.
 *
 * Sticky, not defaulted-on-every-install: an install that names neither flag keeps whatever was
 * chosen last time, so re-running `obrigado install` to pick up a new version does not quietly
 * move a line somebody deliberately placed.
 */
export function positionFromArgv(
  argv: readonly string[],
  existing: ClaudeIntegrationConfig | null,
): SponsoredPosition {
  if (argv.includes("--above")) return "above";
  if (argv.includes("--below")) return "below";
  return existing?.sponsored_position === "above" ? "above" : "below";
}

export function resolveClaudeState(
  existing: ClaudeIntegrationConfig | null,
  previous: unknown,
  chain: boolean,
): { previousToRecord: unknown; chainedCommand: string | undefined } {
  const displaced = chainableCommand(previous);
  const recorded = chainableCommand(existing?.previous_status_line);
  /*
   * The already-recorded command is re-checked rather than carried over on trust.
   *
   * It was written by an older install, under an older idea of what counts as ours — and one
   * of those ideas was wrong: a command nesting us as a quoted inner argument read as the
   * developer's, so some installs recorded OUR command as the thing to chain. Re-filtering here
   * is what lets `obrigado install` repair such a config instead of preserving it forever.
   */
  const kept = chainableCommand({ command: existing?.chained_command });
  return {
    previousToRecord: displaced === undefined ? (existing?.previous_status_line ?? null) : previous,
    chainedCommand: chain ? (displaced ?? recorded ?? kept) : kept,
  };
}
