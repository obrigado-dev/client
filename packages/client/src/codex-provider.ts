/**
 * Obrigado as a Codex status line provider: what it says to Codex, and when it asks for a line.
 *
 * Codex 0.171.0 reads its footer from a provider, a stdio MCP server it starts itself. The server
 * lists one tool whose `_meta["openai/ui"].entrypoints` names a `statusline` resource. Codex then
 * reads that resource about once a second, passing what the displayed thread looks like right now
 * in `params._meta["com.openai/codex-statusline-state"]`, and draws the JSON tree that comes back
 * as its footer (`codex-rs/skills/src/assets/samples/create-statusline/SKILL.md` at
 * `rust-v0.171.0`, and `codex-rs/tui/src/chatwidget/statusline_reader.rs` for the loop).
 *
 * Three things about that loop shape everything here, each checked against the running program:
 *
 *   - The tree is the whole footer. Codex draws nothing of its own beside it, so the developer's
 *     model, context and directory are ours to draw back (`codex-footer.ts`) before our line goes
 *     anywhere.
 *   - A read has one second, and a read that fails or runs over ends the footer: Codex shows
 *     "Status line failed" and stops asking until the provider is picked again. So a read is
 *     answered from what is already in hand, and the renderer, which may wait on the network, is
 *     never run inside one.
 *   - The reads never stop, a thousand an hour in an idle terminal. A line asked for on each would
 *     turn the rotation into a clock. The renderer is asked when something happened in the session
 *     instead (`observe`), as the Pi extension asks at the end of a turn.
 *
 * This module is the protocol and those decisions, with no I/O. `commands/codex-provider.ts` is the
 * process around it.
 */
import { CLIENT_VERSION } from "./version.ts";

/** The MCP server's name in Codex's config, and with the tool's the identity Codex saves. */
export const PROVIDER_SERVER = "obrigado";
export const PROVIDER_TOOL = "statusline";
/** The resource Codex reads for the footer. */
export const PROVIDER_URI = "ui://obrigado/footer";
/** Where a read carries the displayed thread's state. */
export const STATE_META = "com.openai/codex-statusline-state";

/**
 * The one tool, which exists to be listed.
 *
 * Codex finds a provider by its tool, and shows the model every tool a server lists: hiding this
 * one with `disabled_tools` makes the footer "unavailable" (checked on 0.171.0). So the model can
 * see it and could call it. The description says there is no reason to, and `tools/call` answers
 * with a sentence about the footer and nothing else. No sponsored copy can reach the model through
 * it (§3), because none is ever put in a tool result.
 */
const TOOL = {
  name: PROVIDER_TOOL,
  // The provider's name in `/statusline`.
  title: "Obrigado",
  description:
    "Codex reads its status line from this. It takes no input and returns nothing useful to an agent, so there is no reason to call it.",
  inputSchema: { type: "object", properties: {} },
  _meta: {
    "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: PROVIDER_URI }] },
  },
} as const;

/** A JSON-RPC error with its code, for the one place that writes the reply. */
class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;
const PARSE_ERROR = -32_700;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The footer for one read, as the JSON text Codex parses. `"null"` is an empty footer. */
export type ReadFooter = (state: unknown) => Promise<string>;

/** The result of one request, or an `RpcError`. */
async function answer(method: string, params: unknown, read: ReadFooter): Promise<unknown> {
  const given = isRecord(params) ? params : {};
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: PROVIDER_SERVER, version: CLIENT_VERSION },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call":
      if (given["name"] !== PROVIDER_TOOL) throw new RpcError(INVALID_PARAMS, "Unknown tool name");
      return {
        content: [
          {
            type: "text",
            text: `Codex draws its status line from ${PROVIDER_URI}. This tool does nothing else.`,
          },
        ],
      };
    case "resources/list":
      return { resources: [{ name: "footer", uri: PROVIDER_URI, mimeType: "application/json" }] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read": {
      if (given["uri"] !== PROVIDER_URI) {
        throw new RpcError(INVALID_PARAMS, "Unknown resource URI");
      }
      const meta = isRecord(given["_meta"]) ? given["_meta"] : {};
      return {
        contents: [
          { uri: PROVIDER_URI, mimeType: "application/json", text: await read(meta[STATE_META]) },
        ],
      };
    }
    default:
      throw new RpcError(METHOD_NOT_FOUND, "Method not found");
  }
}

/**
 * The reply to one line from Codex, or null where none is owed.
 *
 * Newline-delimited JSON-RPC, as MCP's stdio transport is. A notification, a message with no
 * `id`, gets no reply. Everything else gets exactly one, an error included: a request left
 * unanswered is a read Codex waits a second on and then gives the footer up for.
 */
export async function replyTo(line: string, read: ReadFooter): Promise<string | null> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: PARSE_ERROR, message: "Parse error" },
    });
  }
  if (!isRecord(request) || typeof request["method"] !== "string") {
    // A reply to something we never asked is not a request. Nothing is owed for it.
    if (isRecord(request) && ("result" in request || "error" in request)) return null;
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: INVALID_REQUEST, message: "Invalid request" },
    });
  }
  if (!("id" in request)) return null;
  const id = request["id"];
  try {
    const result = await answer(request["method"], request["params"], read);
    return JSON.stringify({ jsonrpc: "2.0", id, result });
  } catch (error) {
    const code = error instanceof RpcError ? error.code : INVALID_PARAMS;
    const message = error instanceof RpcError ? error.message : "Invalid parameters";
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

/** What a read's state says about the thread, as far as asking for a line needs to know. */
export interface ThreadFacts {
  /** The thread's id, which is the session the renderer keeps its rotation for. */
  readonly id: string;
  readonly cwd: string;
  /** `starting`, `ready`, `working`, `waiting` or `thinking`, in Codex's words. */
  readonly state: string;
  /** Codex's own version, which travels with the session request as every host's does. */
  readonly version: string | undefined;
}

/** The thread a read is about, or null for a state that names none. */
export function threadFacts(state: unknown): ThreadFacts | null {
  if (!isRecord(state)) return null;
  const thread = state["thread"];
  if (!isRecord(thread)) return null;
  const id = thread["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  const workspace = isRecord(thread["workspace"]) ? thread["workspace"] : {};
  const agent = isRecord(thread["agent"]) ? thread["agent"] : {};
  const app = isRecord(state["app"]) ? state["app"] : {};
  const cwd = workspace["cwd"];
  const run = agent["state"];
  const version = app["cli_version"];
  return {
    id: id.slice(0, 128),
    cwd: typeof cwd === "string" ? cwd : "",
    state: typeof run === "string" ? run.slice(0, 32) : "",
    version: typeof version === "string" && version.length > 0 ? version.slice(0, 64) : undefined,
  };
}

/** The person's latest prompt, in the shape the renderer's prompt signal reads. */
export interface NotedPrompt {
  readonly id: string;
  readonly at: number;
}

/** What is remembered of a thread between reads. */
export interface ThreadMemory {
  /** The run state the last read reported. */
  readonly state: string;
  /** The latest turn the person started, or null where none has been seen to start. */
  readonly prompt: NotedPrompt | null;
  /** Whether the renderer has been asked for this thread at all. */
  readonly asked: boolean;
}

/** The states in which a turn is running. `ready` is the one in which none is. */
const BUSY = new Set(["working", "thinking", "waiting"]);

/**
 * What one read changes: the thread's memory, and whether to ask the renderer for a line now.
 *
 * The renderer is asked three times in a session's life, each tied to something that happened:
 *
 *   - once the thread is first seen out of `starting`, which is the session opening. While Codex
 *     is still starting its MCP servers there is no session to show a line to, as there is none on
 *     Antigravity CLI's sign-in screen (A47);
 *   - when a turn starts, `ready` to any busy state. That is almost always the person sending a
 *     message, so it is also the prompt the server's attention rule counts from, dated now. Like
 *     Claude Code's opaque prompt id it also counts a turn the agent starts itself;
 *   - when a turn ends, any busy state to `ready`, which is the person about to read the result.
 *
 * Nothing on a read where the state did not change, which is nearly all of them, and no prompt
 * from the first read: a turn already running when first seen started at a moment this process
 * does not know, and dating it now would make an old prompt look fresh.
 */
export function observe(
  previous: ThreadMemory | undefined,
  facts: ThreadFacts,
  now: number,
): { readonly memory: ThreadMemory; readonly ask: boolean } {
  const inSession = facts.state !== "starting" && facts.state !== "";
  if (previous === undefined || !previous.asked) {
    return {
      memory: { state: facts.state, prompt: previous?.prompt ?? null, asked: inSession },
      ask: inSession,
    };
  }
  const started = previous.state === "ready" && BUSY.has(facts.state);
  const ended = BUSY.has(previous.state) && facts.state === "ready";
  return {
    memory: {
      state: facts.state,
      prompt: started ? { id: `prompt-${now}`, at: now } : previous.prompt,
      asked: true,
    },
    ask: started || ended,
  };
}

/**
 * What the renderer is handed on stdin for one line.
 *
 * The shape Claude Code sends, because the renderer keys its per-session state off `session_id`:
 * each Codex thread keeps its own rotation, and two terminals cannot spend each other's batch.
 * `version` is Codex's, as it is every host's. No `surface_version`: this is the binary itself,
 * not a shim of ours inside the host, so there is no second version to report.
 */
export function rendererPayload(facts: ThreadFacts, prompt: NotedPrompt | null): string {
  return JSON.stringify({
    session_id: facts.id,
    cwd: facts.cwd,
    ...(facts.version === undefined ? {} : { version: facts.version }),
    ...(prompt === null ? {} : { prompt_id: prompt.id, prompt_at: prompt.at }),
  });
}
