/**
 * Client-side paths and state.
 *
 * Everything Obrigado owns lives under `~/.obrigado`. Installation also writes one
 * documented entry into the host-owned Claude Code settings file; see
 * `statusline.ts` for its preservation rules, and `codex-statusline.ts` for why
 * Codex currently gets no write at all.
 */
import type { SharingSettings } from "@obrigado/shared";

import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { chmod, mkdir } from "node:fs/promises";

/**
 * The home directory, or somewhere absolute when there is none.
 *
 * `os.homedir()` returns an empty string in a container with no `HOME` and no passwd entry —
 * routine for distroless images — and `join("", ".obrigado")` is then `.obrigado`, relative
 * to the working directory. On the statusline path the working directory is the developer's
 * repository, so every queue and state file would have landed inside it: a write outside the
 * declared file set, made silently. State goes to `XDG_STATE_HOME` if set, else the temp
 * directory, and every path below is asserted absolute.
 */
function stateRoot(): string {
  const home = homedir();
  if (home.length > 0 && isAbsolute(home)) return home;
  const xdg = process.env["XDG_STATE_HOME"];
  return xdg !== undefined && isAbsolute(xdg) ? xdg : tmpdir();
}

function absolute(path: string): string {
  if (!isAbsolute(path)) throw new Error(`obrigado: refusing a relative state path: ${path}`);
  return path;
}

const HOME = stateRoot();

export const OBRIGADO_DIR = absolute(join(HOME, ".obrigado"));
const CONFIG_PATH = join(OBRIGADO_DIR, "config.json");
export const BATCH_PATH = join(OBRIGADO_DIR, "batch.json");
export const QUEUE_PATH = join(OBRIGADO_DIR, "queue.jsonl");
export const BACKUP_DIR = join(OBRIGADO_DIR, "backups");
export const SESSION_STATE_DIR = join(OBRIGADO_DIR, "sessions");
/** When Obrigado's own notice last took the slot, across every host (A30). */
export const NOTICE_PATH = join(OBRIGADO_DIR, "notice.json");

export const CLAUDE_SETTINGS_PATH = absolute(join(HOME, ".claude", "settings.json"));
export const CODEX_HOME = absolute(process.env["CODEX_HOME"] ?? join(HOME, ".codex"));

export interface ClaudeIntegrationConfig {
  readonly installed: boolean;
  readonly installed_at?: string;
  /** What `statusLine` held before install, so uninstall restores exactly. */
  readonly previous_status_line?: unknown;
  /** A statusline command to run alongside ours. */
  readonly chained_command?: string | undefined;
  /**
   * Which row the sponsored line takes when a command is chained.
   *
   * Absent means "below", which is both the old behaviour and the humbler default: an ad
   * belongs under the developer's own tooling, not on top of it. Stored rather than passed,
   * because the renderer is spawned fresh by the host on every repaint and has no other way
   * to know what was asked for at install.
   */
  readonly sponsored_position?: SponsoredPosition;
}

/** Where the sponsored line sits relative to the developer's own chained line. */
export type SponsoredPosition = "above" | "below";

export interface CodexIntegrationConfig {
  readonly installed: boolean;
  readonly installed_at?: string;
}

export interface OpenCodeIntegrationConfig {
  readonly installed: boolean;
  readonly installed_at?: string;
}

export interface PiIntegrationConfig {
  readonly installed: boolean;
  readonly installed_at?: string;
}

export interface ClientIntegrations {
  "claude-code"?: ClaudeIntegrationConfig;
  codex?: CodexIntegrationConfig;
  opencode?: OpenCodeIntegrationConfig;
  /* One extension, two hosts, two directories — so two independent install records. */
  pi?: PiIntegrationConfig;
  "oh-my-pi"?: PiIntegrationConfig;
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
  /**
   * Whether the sponsored line carries its disclosure (A34). On unless set otherwise.
   *
   * The same principle as `color`, taken to its end: the line is drawn in the developer's own
   * status bar, and they may decide what it says there. Only they can — an advertiser cannot
   * buy an unlabeled line, and nothing in the API or the console can set this. What it costs
   * is written down in the amendment and on `/ads`, because an advertiser whose copy may run
   * without the prefix is owed that fact before they pay.
   */
  readonly label?: "on" | "off";
  /**
   * The email a verification code was last requested for, so `obrigado link
   * --code 123456` does not make the developer retype the address. Cleared on
   * confirm. Local convenience only — never sent anywhere by itself.
   */
  readonly pending_link_email?: string;
  /**
   * The session `obrigado link github` signed this install in with (A33): who the developer is
   * to Obrigado, for a later feature to present as `Authorization: Bearer`.
   *
   * Nothing sends it today. It is kept because the client never updates itself, so the release
   * that first uses it should find the person already signed in rather than ask again. The
   * server stores only its sha256; `obrigado unlink github` ends it there and removes it here.
   */
  readonly developer_session?: {
    readonly token: string;
    /** The GitHub login it was issued for, as GitHub reported it then. */
    readonly login: string;
    readonly expires_at: string;
  };
  /**
   * What this developer agreed to be targeted on. Absent means none of it.
   *
   * Independent flags rather than a level: somebody may be happy to share a country and not
   * what their agent is reading, or the reverse, and a scale would present that as a
   * hierarchy of trust it is not.
   *
   * `packages` covers the lockfile. The deps are sent regardless because they are what makes
   * an impression worth buying; the flag decides whether an advertiser may target them.
   *
   * Sent on every session, so turning one off takes effect on the next render rather than at
   * some later sync — and the server nulls what it had stored rather than merely stopping.
   * `obrigado privacy` is the command; `obrigado install` asks once.
   *
   * The developer earns nothing for any of this and that is deliberate (§3): paying for
   * consent would recreate the incentive to farm impressions that the whole design removes.
   * The reason to say yes is that better-targeted inventory clears higher CPMs, and 70% of
   * that lands in the packages already in their own lockfile.
   */
  readonly sharing?: {
    readonly packages?: boolean;
    readonly region?: boolean;
    readonly network?: boolean;
    readonly activity?: boolean;
  };
}

/** What the wire carries, with absent meaning "consented to nothing". */
export function sharingSettings(config: ClientConfig | null): SharingSettings {
  return {
    packages: config?.sharing?.packages ?? false,
    region: config?.sharing?.region ?? false,
    network: config?.sharing?.network ?? false,
    activity: config?.sharing?.activity ?? false,
  };
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

/**
 * Defaulted here rather than at each call site.
 *
 * An unreadable or absent value is "below" — the same row an install that predates the option
 * renders in, so upgrading the client cannot silently move somebody's line.
 */
/** Whether the disclosure is drawn. Absent means yes; only "off" turns it off. */
export function labelShown(config: ClientConfig | null): boolean {
  return config?.label !== "off";
}

export function sponsoredPosition(config: ClientConfig | null): SponsoredPosition {
  return claudeIntegration(config)?.sponsored_position === "above" ? "above" : "below";
}

export function opencodeIntegration(config: ClientConfig | null): OpenCodeIntegrationConfig | null {
  return config?.integrations?.opencode ?? null;
}

export function piIntegration(
  config: ClientConfig | null,
  host: "pi" | "oh-my-pi",
): PiIntegrationConfig | null {
  return config?.integrations?.[host] ?? null;
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
