/**
 * Client-side paths and state.
 *
 * Everything Obrigado owns lives under `~/.obrigado`. Installation also writes one
 * documented entry into the host-owned Claude Code settings file; see
 * `statusline.ts` for its preservation rules, and `codex-statusline.ts` for why
 * Codex currently gets no write at all.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir } from "node:fs/promises";

export const OBRIGADO_DIR = join(homedir(), ".obrigado");
const CONFIG_PATH = join(OBRIGADO_DIR, "config.json");
export const BATCH_PATH = join(OBRIGADO_DIR, "batch.json");
export const QUEUE_PATH = join(OBRIGADO_DIR, "queue.jsonl");
export const BACKUP_DIR = join(OBRIGADO_DIR, "backups");
export const SESSION_STATE_DIR = join(OBRIGADO_DIR, "sessions");

export const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
export const CODEX_HOME = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");

export interface ClaudeIntegrationConfig {
  readonly installed: boolean;
  readonly installed_at?: string;
  /** What `statusLine` held before install, so uninstall restores exactly. */
  readonly previous_status_line?: unknown;
  /** A statusline command to run before ours. */
  readonly chained_command?: string | undefined;
}

export interface CodexIntegrationConfig {
  readonly installed: boolean;
  readonly installed_at?: string;
}

export interface OpenCodeIntegrationConfig {
  readonly installed: boolean;
  readonly installed_at?: string;
}

export interface ClientIntegrations {
  "claude-code"?: ClaudeIntegrationConfig;
  codex?: CodexIntegrationConfig;
  opencode?: OpenCodeIntegrationConfig;
}

export interface ClientConfig {
  /** Opaque install key. The server stores only its sha256 (INVARIANT 7). */
  readonly install_key: string;
  readonly api_origin: string;
  /** Per-host installation state. The install key above is deliberately shared. */
  readonly integrations?: ClientIntegrations;
  readonly installed_at?: string;
  /** §14 Phase 1: the end-of-session summary is opt-out. */
  readonly session_summary?: boolean;
  /**
   * Colour for the sponsored copy. "off" wins over any advertiser choice, as
   * does NO_COLOR — the developer's terminal is theirs.
   */
  readonly color?: "auto" | "off";
}

export const DEFAULT_API_ORIGIN = "http://localhost:3000";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function readConfig(): Promise<ClientConfig | null> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as ClientConfig;
  } catch {
    return null;
  }
}

export function claudeIntegration(config: ClientConfig | null): ClaudeIntegrationConfig | null {
  return config?.integrations?.["claude-code"] ?? null;
}

export function codexIntegration(config: ClientConfig | null): CodexIntegrationConfig | null {
  return config?.integrations?.codex ?? null;
}

export function opencodeIntegration(config: ClientConfig | null): OpenCodeIntegrationConfig | null {
  return config?.integrations?.opencode ?? null;
}

export async function writeConfig(config: ClientConfig): Promise<void> {
  await ensureDir(OBRIGADO_DIR);
  await Bun.write(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  // The install key is a bearer credential for this install's impressions.
  await chmod(CONFIG_PATH, 0o600);
}

/** 256 bits, base64url. Generated locally and never derived from anything
 *  identifying — it is a random label, not a user id. */
export function generateInstallKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
