/**
 * Shared helpers for the `obrigado` commands.
 */
import { DEFAULT_API_ORIGIN } from "../config.ts";
import type { ClientConfig } from "../config.ts";
import { isOurStatusLine } from "../statusline.ts";

export function apiOrigin(config: ClientConfig | null): string {
  return process.env["OBRIGADO_API_ORIGIN"] ?? config?.api_origin ?? DEFAULT_API_ORIGIN;
}

/** Pull the shell command out of an existing statusLine entry, if it has one. */
function commandOf(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const command = (entry as { command?: unknown }).command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

/**
 * A command we are willing to chain — never our own.
 *
 * Chaining our own command makes `obrigado statusline` invoke `obrigado
 * statusline`, once per render, forever. Re-running install is enough to trigger
 * it, since by then the entry we "displace" is the one we wrote last time.
 */
export function chainableCommand(entry: unknown): string | undefined {
  const command = commandOf(entry);
  if (command === undefined) return undefined;
  return isOurStatusLine({ command }) ? undefined : command;
}
