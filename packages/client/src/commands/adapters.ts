/**
 * What every install and uninstall adapter returns.
 *
 * Extracted so the per-host adapters can live in their own files without importing back from
 * `install.ts`, which would make the command depend on the hosts and the hosts on the command.
 */
import type { ClientConfig, ClientIntegrations } from "../config.ts";

export interface AdapterResult {
  /** Whether anything was written. Drives whether the config file is rewritten at all. */
  readonly changed: boolean;
  readonly failed: boolean;
  /** What the install's summary says about this host, one line of it. */
  readonly row?: InstallRow;
}

/**
 * One host's line in the install's summary.
 *
 * The adapters used to print three or four lines each, so an install on a machine with five
 * agents was a screen of prose with the outcome somewhere in it. Now each says what happened in
 * one line, and `install-report.ts` lines them up.
 */
export interface InstallRow {
  readonly mark: "done" | "skipped" | "failed";
  /** The host, as a reader scans for it. */
  readonly host: string;
  /** What was written and where, or why not. */
  readonly detail: string;
  /** What has to be said beneath the line: a refusal's way out, a kept command. */
  readonly notes?: readonly string[];
  /** Set when the write made a backup; the summary names the folder once. */
  readonly backedUp?: boolean;
}

export type Remover = (
  config: ClientConfig | null,
  integrations: ClientIntegrations,
) => Promise<void>;
