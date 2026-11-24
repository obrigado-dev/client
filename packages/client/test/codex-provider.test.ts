import { describe, expect, test } from "bun:test";

import {
  observe,
  PROVIDER_TOOL,
  PROVIDER_URI,
  rendererPayload,
  replyTo,
  STATE_META,
  threadFacts,
} from "../src/codex-provider.ts";
import type { ReadFooter, ThreadFacts, ThreadMemory } from "../src/codex-provider.ts";
import { CLIENT_VERSION } from "../src/version.ts";

const footer =
  (text = '"footer"'): ReadFooter =>
  () =>
    Promise.resolve(text);

/** The `result` of a reply, for a test that goes on to look inside it. */
function resultOf(reply: Record<string, unknown> | null): Record<string, unknown> {
  return (reply?.["result"] ?? {}) as Record<string, unknown>;
}

/** The error code of a reply, or 0 where it is not an error. */
function errorCode(reply: Record<string, unknown> | null): number {
  return ((reply?.["error"] ?? { code: 0 }) as { code: number }).code;
}

async function ask(
  message: unknown,
  read: ReadFooter = footer(),
): Promise<Record<string, unknown> | null> {
  const reply = await replyTo(JSON.stringify(message), read);
  return reply === null ? null : (JSON.parse(reply) as Record<string, unknown>);
}

/** What Codex 0.171.0 sent a provider in a fresh session (captured from the running program). */
const STATE = {
  account: { rate_limits: [] },
  app: { cli_version: "0.171.0", display_mode: "standard" },
  config: { statusline_items: ["model-with-reasoning", "context-remaining", "current-dir"] },
  thread: {
    id: "01a20ad1-184e-7ad1-a851-b7198997196e",
    name: null,
    agent: { state: "ready" },
    model: { display_name: "gpt-6.1", id: "gpt-6.1", provider: "openai", service_tier: "normal" },
    workspace: { cwd: "/Users/dev/project" },
    usage: { context: {} },
  },
};

describe("what Codex is told", () => {
  test("initialize names the server and offers tools and resources", async () => {
    const reply = await ask({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "obrigado", version: CLIENT_VERSION },
      },
    });
  });

  test("one tool, which lists exactly one statusline resource", async () => {
    const reply = await ask({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = resultOf(reply)["tools"] as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.["name"]).toBe(PROVIDER_TOOL);
    expect(tools[0]?.["title"]).toBe("Obrigado");
    expect(tools[0]?.["_meta"]).toEqual({
      "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: PROVIDER_URI }] },
    });
  });

  test("a read is one JSON text resource at the URI Codex asked for", async () => {
    const reply = await ask(
      { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: PROVIDER_URI } },
      footer('{"type":"text","children":["x"]}'),
    );
    expect(reply?.["result"]).toEqual({
      contents: [
        {
          uri: PROVIDER_URI,
          mimeType: "application/json",
          text: '{"type":"text","children":["x"]}',
        },
      ],
    });
  });

  test("a read hands the footer the state Codex sent, and nothing else", async () => {
    let seen: unknown = "unset";
    await ask(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: PROVIDER_URI, _meta: { [STATE_META]: STATE, progressToken: 17 } },
      },
      (state) => {
        seen = state;
        return Promise.resolve("null");
      },
    );
    expect(seen).toEqual(STATE);
  });

  test("the tool says where the footer is read from and nothing an advertiser wrote (§3)", async () => {
    const reply = await ask(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: PROVIDER_TOOL } },
      footer('"Acme: ship faster"'),
    );
    const content = resultOf(reply)["content"] as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.text).toContain(PROVIDER_URI);
    expect(content[0]?.text).not.toContain("Acme");
  });

  test("the rest of what an MCP client may ask is answered", async () => {
    expect((await ask({ jsonrpc: "2.0", id: 5, method: "ping" }))?.["result"]).toEqual({});
    expect((await ask({ jsonrpc: "2.0", id: 6, method: "resources/list" }))?.["result"]).toEqual({
      resources: [{ name: "footer", uri: PROVIDER_URI, mimeType: "application/json" }],
    });
    expect(
      (await ask({ jsonrpc: "2.0", id: 7, method: "resources/templates/list" }))?.["result"],
    ).toEqual({ resourceTemplates: [] });
  });
});

describe("what is never left unanswered", () => {
  test("a notification gets no reply", async () => {
    expect(await ask({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  test("an unknown method, resource or tool is an error with the request's id", async () => {
    expect(await ask({ jsonrpc: "2.0", id: 8, method: "prompts/list" })).toEqual({
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32_601, message: "Method not found" },
    });
    const wrongUri = await ask({
      jsonrpc: "2.0",
      id: "a",
      method: "resources/read",
      params: { uri: "ui://other/footer" },
    });
    expect(wrongUri?.["id"]).toBe("a");
    expect(errorCode(wrongUri)).toBe(-32_602);
    const wrongTool = await ask({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "x" },
    });
    expect(errorCode(wrongTool)).toBe(-32_602);
  });

  test("a line that is not JSON, or not a request, is an error and not a crash", async () => {
    expect(JSON.parse((await replyTo("{nope", footer())) ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_700, message: "Parse error" },
    });
    expect((await ask([1, 2]))?.["error"]).toEqual({ code: -32_600, message: "Invalid request" });
    // A reply to something we never asked is nothing to answer.
    expect(await ask({ jsonrpc: "2.0", id: 1, result: {} })).toBeNull();
  });

  test("a footer that throws is an error reply, so the read still ends", async () => {
    const reply = await ask(
      { jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: PROVIDER_URI } },
      () => Promise.reject(new Error("boom")),
    );
    expect(reply?.["id"]).toBe(10);
    expect(reply?.["error"]).toBeDefined();
  });
});

describe("the thread a read is about", () => {
  test("its id, directory, state and Codex's version", () => {
    expect(threadFacts(STATE)).toEqual({
      id: "01a20ad1-184e-7ad1-a851-b7198997196e",
      cwd: "/Users/dev/project",
      state: "ready",
      version: "0.171.0",
    });
  });

  test("nothing for a state that names no thread", () => {
    expect(threadFacts(null)).toBeNull();
    expect(threadFacts({})).toBeNull();
    expect(threadFacts({ thread: { id: "" } })).toBeNull();
    expect(threadFacts({ thread: { id: 7 } })).toBeNull();
  });

  test("missing parts are empty, never a throw", () => {
    expect(threadFacts({ thread: { id: "t" } })).toEqual({
      id: "t",
      cwd: "",
      state: "",
      version: undefined,
    });
  });
});

/** A read of one thread, in the state Codex says it is in. */
const factsIn = (state: string): ThreadFacts => ({ id: "t", cwd: "/p", state, version: "0.171.0" });

describe("when the renderer is asked", () => {
  const NOW = 1_800_000_000_000;

  /** Reads in order, as Codex makes them: what each one asked for, and the memory after the last. */
  function session(states: readonly string[]): {
    asks: boolean[];
    memory: ThreadMemory | undefined;
  } {
    let memory: ThreadMemory | undefined;
    const asks: boolean[] = [];
    for (const [index, state] of states.entries()) {
      const step = observe(memory, factsIn(state), NOW + index * 1000);
      ({ memory } = step);
      asks.push(step.ask);
    }
    return { asks, memory };
  }

  test("once when the session opens, and not again while nothing happens", () => {
    expect(session(["ready", "ready", "ready", "ready"]).asks).toEqual([true, false, false, false]);
  });

  test("not while Codex is still starting, and then once it is not", () => {
    expect(session(["starting", "starting", "ready", "ready"]).asks).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  test("when a turn starts and when it ends, and not for what happens inside it", () => {
    const { asks } = session([
      "ready",
      "thinking",
      "working",
      "thinking",
      "waiting",
      "working",
      "ready",
      "ready",
    ]);
    expect(asks).toEqual([true, true, false, false, false, false, true, false]);
  });

  test("a turn starting is the prompt, dated when it was seen to start", () => {
    const { memory } = session(["ready", "ready", "thinking", "working", "ready"]);
    expect(memory?.prompt).toEqual({ id: `prompt-${NOW + 2000}`, at: NOW + 2000 });
  });

  test("a turn already running when first seen is not dated now", () => {
    const { asks, memory } = session(["working", "working", "ready"]);
    expect(asks).toEqual([true, false, true]);
    expect(memory?.prompt).toBeNull();
  });

  test("each turn the person starts is a new prompt", () => {
    const { memory } = session(["ready", "working", "ready", "thinking"]);
    expect(memory?.prompt?.at).toBe(NOW + 3000);
  });
});

describe("what the renderer is handed", () => {
  const facts: ThreadFacts = { id: "thread-1", cwd: "/p", state: "ready", version: "0.171.0" };

  test("the session, the directory and Codex's version, in the shape Claude Code sends", () => {
    expect(JSON.parse(rendererPayload(facts, null))).toEqual({
      session_id: "thread-1",
      cwd: "/p",
      version: "0.171.0",
    });
  });

  test("the prompt where one has been seen, for the attention rule", () => {
    expect(JSON.parse(rendererPayload(facts, { id: "prompt-5", at: 5 }))).toEqual({
      session_id: "thread-1",
      cwd: "/p",
      version: "0.171.0",
      prompt_id: "prompt-5",
      prompt_at: 5,
    });
  });

  test("no surface version: the provider is the binary, not a shim of ours in the host", () => {
    expect(rendererPayload(facts, null)).not.toContain("surface_version");
  });
});
