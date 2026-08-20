/** Per-agent, per-session delivery state.
 *
 * Claude and Codex can run concurrently on one install key. A global batch
 * lets one host consume another host's nonces and attribution, so state is
 * namespaced by host and a one-way hash of the host's local session id.
 */
import { readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { BATCH_TTL_SECONDS } from "@obrigado/shared";
import type { BatchItem } from "@obrigado/shared";
import type { CachedBatch } from "@obrigado/shared/rotation";

import { ensureDir, SESSION_STATE_DIR } from "./config.ts";
import { EDITOR_AGENT_IDS } from "@obrigado/shared/agents";

import { AGENTS } from "./version.ts";
import type { Agent } from "./version.ts";

interface PendingCodexImpression {
  readonly item: BatchItem;
  readonly shown_at: number;
  readonly turn_id: string;
}

export interface AgentSessionState {
  batch: CachedBatch | null;
  pending?: PendingCodexImpression;
  /** The last Stop turn emitted, including one later continued by another hook. */
  last_stop_turn?: string;
  updated_at: number;
}

export interface StateLocation {
  readonly stateDir?: string;
}

function rootOf(location: StateLocation): string {
  return location.stateDir ?? SESSION_STATE_DIR;
}

function sessionKey(sessionId: string): string {
  return new Bun.CryptoHasher("sha256").update(sessionId).digest("hex").slice(0, 32);
}

export function sessionIdFromPayload(payload: string): string {
  if (payload.length === 0) return "default";
  try {
    const value = (JSON.parse(payload) as { session_id?: unknown }).session_id;
    return typeof value === "string" && value.length > 0 ? value : "default";
  } catch {
    return "default";
  }
}

export function sessionStatePath(
  agent: Agent,
  sessionId: string,
  location: StateLocation = {},
): string {
  return join(rootOf(location), agent, `${sessionKey(sessionId)}.json`);
}

export async function readSessionState(
  agent: Agent,
  sessionId: string,
  location: StateLocation = {},
): Promise<AgentSessionState> {
  const file = Bun.file(sessionStatePath(agent, sessionId, location));
  if (!(await file.exists())) return { batch: null, updated_at: Date.now() };
  try {
    const parsed = (await file.json()) as AgentSessionState;
    return typeof parsed === "object" && parsed !== null && "batch" in parsed
      ? parsed
      : { batch: null, updated_at: Date.now() };
  } catch {
    return { batch: null, updated_at: Date.now() };
  }
}

export async function writeSessionState(
  agent: Agent,
  sessionId: string,
  state: AgentSessionState,
  location: StateLocation = {},
): Promise<void> {
  const path = sessionStatePath(agent, sessionId, location);
  await writeStatePath(path, state);
}

async function writeStatePath(path: string, state: AgentSessionState): Promise<void> {
  await ensureDir(dirname(path));
  const temporary = `${path}.obrigado-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...state, updated_at: Date.now() })}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function stateFiles(root: string): Promise<string[]> {
  // Every known host, not a hardcoded pair. This listed only Claude and Codex, so once
  // OpenCode started writing state nothing swept or cleared it — a directory that grows
  // forever with no symptom anyone would notice.
  const byAgent = await Promise.all(
    AGENTS.map(async (agent) => {
      try {
        return (await readdir(join(root, agent)))
          .filter((name) => name.endsWith(".json"))
          .map((name) => join(root, agent, name));
      } catch {
        return [];
      }
    }),
  );
  return byAgent.flat();
}

/** Remove old state only when no still-valid pending impression depends on it. */
export async function pruneSessionState(
  now = Date.now(),
  location: StateLocation = {},
): Promise<number> {
  const results = await Promise.all(
    (await stateFiles(rootOf(location))).map(async (path): Promise<number> => {
      let shouldRemove: boolean;
      try {
        const state = (await Bun.file(path).json()) as AgentSessionState;
        const pendingAt = state.pending?.shown_at;
        const pendingExpired =
          pendingAt === undefined || now - pendingAt > BATCH_TTL_SECONDS * 1000;
        shouldRemove = pendingExpired && now - state.updated_at > BATCH_TTL_SECONDS * 1000;
      } catch {
        shouldRemove = true;
      }
      if (!shouldRemove) return 0;
      await unlink(path).catch(() => null);
      return 1;
    }),
  );
  return results.reduce((sum, value) => sum + value, 0);
}

/** Invalidate batches while preserving displayed-but-unconfirmed Codex inventory. */
export async function clearSessionBatches(location: StateLocation = {}): Promise<number> {
  const results = await Promise.all(
    (await stateFiles(rootOf(location))).map(async (path): Promise<number> => {
      try {
        const state = (await Bun.file(path).json()) as AgentSessionState;
        if (state.batch === null) return 0;
        await writeStatePath(path, { ...state, batch: null });
        return 1;
      } catch {
        // A corrupt cache is already equivalent to an invalidated cache.
        return 0;
      }
    }),
  );
  return results.reduce((sum, value) => sum + value, 0);
}

export async function sessionStateSummary(
  location: StateLocation = {},
): Promise<{ sessions: number; batches: number; pending: number }> {
  const states = await Promise.all(
    (await stateFiles(rootOf(location))).map(async (path): Promise<AgentSessionState | null> => {
      try {
        return (await Bun.file(path).json()) as AgentSessionState;
      } catch {
        return null;
      }
    }),
  );
  return states.reduce(
    (summary, state) => {
      if (state === null) return summary;
      return {
        sessions: summary.sessions + 1,
        batches: summary.batches + (state.batch === null ? 0 : 1),
        pending: summary.pending + (state.pending === undefined ? 0 : 1),
      };
    },
    { sessions: 0, batches: 0, pending: 0 },
  );
}

/**
 * Hosts that draw in an EDITOR's chrome rather than inside an agent's own UI.
 *
 * The distinction is billing, not rendering. Everywhere else an impression implies an agent
 * was running, because the line lives in the agent's own window. A status bar item is
 * visible whenever the editor is — including while somebody reads code with no agent
 * involved — so these hosts must show evidence before an impression counts (A21).
 */
/* Derived: an editor is an editor because the shared table says so, not because two ids
   were typed here. */
const EDITOR_AGENTS = new Set<Agent>(EDITOR_AGENT_IDS);

export function isEditorAgent(agent: Agent): boolean {
  return EDITOR_AGENTS.has(agent);
}

/**
 * How long an agent's last render keeps its session "live".
 *
 * Generous on purpose. Hosts re-render on their own cadence — Claude Code per repaint,
 * OpenCode every 30s — so anything tight would flicker an editor surface off between two
 * renders of a session that never stopped. Erring long costs a few impressions attributed
 * to a session that has just ended; erring short would make the surface unusable.
 */
export const AGENT_LIVE_MS = 5 * 60 * 1000;

/**
 * Whether an agent session is live right now, judged only by agent hosts.
 *
 * Editor hosts are excluded from the evidence deliberately: an editor surface must not
 * count itself as proof that an agent is running, or the gate answers its own question and
 * every editor impression qualifies forever.
 */
export async function agentSessionLive(
  now = Date.now(),
  location: StateLocation = {},
): Promise<boolean> {
  const files = await stateFiles(rootOf(location));
  const results = await Promise.all(
    files.map(async (path): Promise<boolean> => {
      const agent = path.split("/").at(-2);
      if (agent === undefined || EDITOR_AGENTS.has(agent as Agent)) return false;
      try {
        const state = (await Bun.file(path).json()) as AgentSessionState;
        return now - state.updated_at <= AGENT_LIVE_MS;
      } catch {
        return false;
      }
    }),
  );
  return results.includes(true);
}
