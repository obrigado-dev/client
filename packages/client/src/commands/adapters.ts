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
}

export type Remover = (
  config: ClientConfig | null,
  integrations: ClientIntegrations,
) => Promise<void>;
