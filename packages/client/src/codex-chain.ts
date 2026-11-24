/**
 * A chained provider: the developer's own Codex status line, drawn with ours beside it.
 *
 * Codex has one provider slot. A developer who already filled it, with a usage meter or a script
 * of their own, would otherwise have to pick between that and funding their dependencies, and
 * since they earn nothing from Obrigado they would rightly keep theirs. `install --chain` makes it
 * not a choice, as it does for Claude Code's `statusLine` (`chain.ts`): ours takes the slot,
 * starts their provider itself, hands it every read exactly as Codex sent it, and draws the tree
 * it returns first, with our line after.
 *
 * It is still not patching. Their server is started with the command their own `config.toml`
 * names, and asked what Codex would have asked. Nothing of theirs is rewritten, and their entry
 * stays in `[mcp_servers]`, where Codex goes on starting it for whatever else it offers.
 *
 * Only a stdio server from the developer's own `config.toml` can be chained. One reached over
 * HTTP, or one a Codex plugin supplies, has no command here to start, and install refuses those
 * rather than guess at one.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { PROVIDER_SERVER, STATE_META } from "./codex-provider.ts";
import { validTree } from "./codex-tree.ts";
import type { UiNode } from "./codex-tree.ts";
import { McpConnection } from "./mcp-connection.ts";
import { CLIENT_VERSION } from "./version.ts";

/** A provider as Codex saves one: the MCP server's name and the tool that lists the footer. */
export interface ProviderId {
  readonly server: string;
  readonly tool: string;
}

/** How a stdio MCP server is started, from its `[mcp_servers.<name>]` table. */
export interface StdioServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `tui.status_line_provider` as a provider, or null for `"default"`, nothing, or anything else. */
export function providerIdFrom(value: unknown): ProviderId | null {
  if (!isRecord(value)) return null;
  const { server, tool } = value;
  if (typeof server !== "string" || typeof tool !== "string") return null;
  return server.length > 0 && tool.length > 0 ? { server, tool } : null;
}

/**
 * The stdio server a parsed `config.toml` names, or null where it names none that can be started.
 *
 * Null for a server with no `command` (one reached by `url`), for one switched off, and for ours:
 * a provider chained to itself would start itself for every read.
 */
export function stdioServerFrom(config: unknown, name: string): StdioServer | null {
  if (name === PROVIDER_SERVER || !isRecord(config)) return null;
  const servers = config["mcp_servers"];
  const table = isRecord(servers) ? servers[name] : undefined;
  if (!isRecord(table) || table["enabled"] === false) return null;
  const { command, args, env, cwd } = table;
  if (typeof command !== "string" || command.length === 0) return null;
  const strings: Record<string, string> = {};
  if (isRecord(env)) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") strings[key] = value;
    }
  }
  return {
    command,
    args: Array.isArray(args) ? args.filter((arg) => typeof arg === "string") : [],
    env: strings,
    cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : undefined,
  };
}

/** The `statusline` resource a server's tool lists, or null where it lists none, or several. */
export function statuslineUri(tools: unknown, tool: string): string | null {
  if (!Array.isArray(tools)) return null;
  const listed = tools.find((entry) => isRecord(entry) && entry["name"] === tool) as unknown;
  if (!isRecord(listed)) return null;
  const meta = isRecord(listed["_meta"]) ? listed["_meta"]["openai/ui"] : undefined;
  const entrypoints = isRecord(meta) ? meta["entrypoints"] : undefined;
  if (!Array.isArray(entrypoints)) return null;
  const uris = entrypoints
    .filter((entry) => isRecord(entry) && entry["type"] === "statusline")
    .map((entry) => (entry as Record<string, unknown>)["resourceUri"])
    .filter((uri) => typeof uri === "string" && uri.startsWith("ui://"));
  // Codex ignores a tool that lists more than one, so it never drew this one either.
  return uris.length === 1 ? (uris[0] as string) : null;
}

/**
 * The tree in a `resources/read` result, or undefined where the result is not one Codex would
 * draw: not exactly one JSON text resource at the URI asked for, or a tree it would refuse.
 */
export function treeFrom(result: unknown, uri: string): UiNode | null | undefined {
  if (!isRecord(result) || !Array.isArray(result["contents"])) return undefined;
  const [content, ...rest] = result["contents"] as unknown[];
  if (rest.length > 0 || !isRecord(content)) return undefined;
  const { text, mimeType } = content;
  if (content["uri"] !== uri || typeof text !== "string") return undefined;
  const media = typeof mimeType === "string" ? (mimeType.split(";")[0] ?? "") : "";
  if (media.trim().toLowerCase() !== "application/json") return undefined;
  try {
    const tree: unknown = JSON.parse(text);
    return validTree(tree) ? tree : undefined;
  } catch {
    return undefined;
  }
}

/** How long their server has to answer one request, inside the second Codex gives the two of us. */
const REQUEST_TIMEOUT_MS = 600;
/** How long it has to start and say what it lists. Codex gives a server ten seconds itself. */
const STARTUP_TIMEOUT_MS = 10_000;
/** How long a server that failed is left alone before it is started again. */
const RESTART_AFTER_MS = 30_000;

type Spawn = (server: StdioServer) => ChildProcessWithoutNullStreams;

/** A server that started, and the footer it lists. */
interface Started {
  readonly connection: McpConnection;
  readonly uri: string;
}

async function spawnServer(server: StdioServer): Promise<ChildProcessWithoutNullStreams> {
  const { spawn } = await import("node:child_process");
  return spawn(server.command, [...server.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...server.env },
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    // No console window for their server on Windows, as there is none for the renderer (A46).
    windowsHide: true,
  });
}

/**
 * The developer's provider, started and asked on their behalf.
 *
 * `read` gives their tree for one read, or undefined for every way that can go wrong: the server
 * would not start, lists no footer under the tool Codex had saved, ran over its time, or returned
 * a tree Codex would refuse. Undefined is not an error to show. The caller draws Codex's own
 * footer in its place, so a provider of theirs that breaks leaves them a footer, where under
 * Codex alone it would have left "Status line failed".
 */
export class ChainedProvider {
  readonly #server: StdioServer;
  readonly #tool: string;
  readonly #spawn: Spawn | undefined;
  #started: Promise<Started | null> | null = null;
  #failedAt = 0;

  constructor(server: StdioServer, tool: string, spawn?: Spawn) {
    this.#server = server;
    this.#tool = tool;
    this.#spawn = spawn;
  }

  /** Their server, started and asked what it lists; null where any of that went wrong. */
  async #start(): Promise<Started | null> {
    let connection: McpConnection | null = null;
    try {
      const child =
        this.#spawn === undefined ? await spawnServer(this.#server) : this.#spawn(this.#server);
      connection = new McpConnection(child);
      await connection.request(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: PROVIDER_SERVER, version: CLIENT_VERSION },
        },
        STARTUP_TIMEOUT_MS,
      );
      connection.notify("notifications/initialized");
      const listed = await connection.request("tools/list", {}, STARTUP_TIMEOUT_MS);
      const uri = statuslineUri(isRecord(listed) ? listed["tools"] : undefined, this.#tool);
      if (uri === null) throw new Error("the chained provider lists no status line");
      return { connection, uri };
    } catch {
      connection?.close();
      return null;
    }
  }

  /** Stop their server and leave it alone for a while: one that hangs is not asked every second. */
  async #giveUp(now: number): Promise<void> {
    const starting = this.#started;
    this.#started = null;
    this.#failedAt = now;
    (await starting)?.connection.close();
  }

  async read(state: unknown, now = Date.now()): Promise<UiNode | null | undefined> {
    if (this.#started === null) {
      if (now - this.#failedAt < RESTART_AFTER_MS) return undefined;
      this.#started = this.#start();
    }
    // Raced, so a read made while their server is still starting is answered in time with
    // Codex's own footer. The start goes on, and a later read finds it finished.
    const started = await Promise.race([this.#started, Bun.sleep(REQUEST_TIMEOUT_MS)]);
    if (started === undefined) return undefined;
    if (started === null || started.connection.closed) {
      await this.#giveUp(now);
      return undefined;
    }
    try {
      const result = await started.connection.request(
        "resources/read",
        { uri: started.uri, _meta: { [STATE_META]: state } },
        REQUEST_TIMEOUT_MS,
      );
      return treeFrom(result, started.uri);
    } catch {
      await this.#giveUp(now);
      return undefined;
    }
  }

  /** Stop their server. Ours started it, so ours ends it. */
  async close(): Promise<void> {
    const starting = this.#started;
    this.#started = null;
    (await starting)?.connection.close();
  }
}
