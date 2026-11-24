import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROVIDER_URI, STATE_META } from "../src/codex-provider.ts";
import { validTree } from "../src/codex-tree.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const RENDERER = join(import.meta.dir, "fixtures", "codex-renderer.ts");

/** A thread as Codex 0.171.0 describes one to a provider, in the run state given. */
function stateIn(run: string, thread = "thread-1"): unknown {
  return {
    account: { rate_limits: [] },
    app: { cli_version: "0.171.0", display_mode: "standard" },
    config: { statusline_items: ["model-with-reasoning", "run-state"] },
    thread: {
      id: thread,
      name: null,
      agent: { state: run },
      model: { display_name: "gpt-6.1", id: "gpt-6.1", provider: "openai" },
      workspace: { cwd: "/tmp/project" },
      usage: { context: {} },
    },
  };
}

/** The provider as Codex runs it: a process, lines in, lines out. */
class Provider {
  readonly #child: Bun.Subprocess<"pipe", "pipe", "ignore">;
  readonly #lines: string[] = [];
  readonly #reader: Promise<void>;
  #nextId = 1;

  constructor(home: string, mode: string) {
    this.#child = Bun.spawn([process.execPath, CLI, "codex-provider", "--codex-home", home], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      // What Codex passes a server it starts, and the two the fixture reads.
      env: {
        HOME: home,
        PATH: process.env["PATH"] ?? "",
        OBRIGADO_STATUSLINE_COMMAND: `${process.execPath} ${RENDERER}`,
        RENDER_LOG: join(home, "render.log"),
        RENDER_MODE: mode,
      },
    });
    this.#reader = this.#collect();
  }

  async #collect(): Promise<void> {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of this.#child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        this.#lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
  }

  send(text: string): void {
    this.#child.stdin.write(`${text}\n`);
  }

  /** One request and its reply, matched by id. */
  async request(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    const id = this.#nextId;
    this.#nextId += 1;
    this.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    for (let attempt = 0; attempt < 200; attempt += 1) {
      for (const line of this.#lines) {
        const reply = JSON.parse(line) as Record<string, unknown>;
        if (reply["id"] === id) return reply;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- waiting for the reply to arrive
      await Bun.sleep(25);
    }
    throw new Error(`no reply to ${method}`);
  }

  /** One read of the footer, as the tree Codex would parse. */
  async read(state: unknown): Promise<unknown> {
    const reply = await this.request("resources/read", {
      uri: PROVIDER_URI,
      _meta: { [STATE_META]: state },
    });
    const result = reply["result"] as {
      contents: { text: string; uri: string; mimeType: string }[];
    };
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.uri).toBe(PROVIDER_URI);
    expect(result.contents[0]?.mimeType).toBe("application/json");
    const tree: unknown = JSON.parse(result.contents[0]?.text ?? "");
    // Whatever it is, Codex must be able to draw it: a refused tree ends the footer.
    expect(validTree(tree)).toBe(true);
    return tree;
  }

  get everyLine(): readonly string[] {
    return this.#lines;
  }

  /** Close the pipe, as Codex does when it exits, and give the exit code. */
  async end(): Promise<number> {
    await this.#child.stdin.end();
    const code = await this.#child.exited;
    await this.#reader;
    return code;
  }
}

/** What the renderer was run with, each time it ran. */
async function renders(
  home: string,
): Promise<{ argv: string[]; payload: Record<string, unknown> }[]> {
  const file = Bun.file(join(home, "render.log"));
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((line) => {
      const entry = JSON.parse(line) as { argv: string[]; payload: string };
      return { argv: entry.argv, payload: JSON.parse(entry.payload) as Record<string, unknown> };
    });
}

/** Wait until the renderer has run `count` times and had a moment to hand its line back. */
async function rendered(home: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling a file another process writes
    if ((await renders(home)).length >= count) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- as above
    await Bun.sleep(25);
  }
  await Bun.sleep(300);
}

describe("the provider as a process", () => {
  let home = "";
  let provider: Provider | null = null;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "obrigado-provider-test-"));
  });
  afterEach(async () => {
    await provider?.end();
    provider = null;
    await rm(home, { recursive: true, force: true });
  });

  const start = (mode = "line"): Provider => {
    provider = new Provider(home, mode);
    return provider;
  };

  test("a first read is answered at once with the developer's footer, and ours follows", async () => {
    const codex = start();
    await codex.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    codex.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

    const first = JSON.stringify(await codex.read(stateIn("ready")));
    expect(first).toContain("gpt-6.1");
    expect(first).toContain("Ready");
    expect(first).not.toContain("oss-sponsor");

    await rendered(home, 1);
    const second = JSON.stringify(await codex.read(stateIn("ready")));
    expect(second).toContain("gpt-6.1");
    expect(second).toContain("oss-sponsor · ");
    expect(second).toContain('"href":"https://obrigado.dev/c/token1"');
    expect(second).toContain("render 1");
  });

  test("the renderer is run as Codex's, for the thread, with Codex's version", async () => {
    const codex = start();
    await codex.read(stateIn("ready"));
    await rendered(home, 1);
    const [first] = await renders(home);
    expect(first?.argv).toEqual(["--agent", "codex", "--json"]);
    expect(first?.payload).toEqual({
      session_id: "thread-1",
      cwd: "/tmp/project",
      version: "0.171.0",
    });
  });

  test("a thousand idle reads are one render, and a turn is two more", async () => {
    const codex = start();
    await codex.read(stateIn("ready"));
    await rendered(home, 1);
    for (let read = 0; read < 25; read += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one read after another, as Codex makes them
      await codex.read(stateIn("ready"));
    }
    expect(await renders(home)).toHaveLength(1);

    await codex.read(stateIn("thinking"));
    await rendered(home, 2);
    await codex.read(stateIn("working"));
    await codex.read(stateIn("thinking"));
    await codex.read(stateIn("ready"));
    await rendered(home, 3);
    await codex.read(stateIn("ready"));

    const all = await renders(home);
    expect(all).toHaveLength(3);
    // The turn's start is the prompt the attention rule counts from, and its end carries it too.
    expect(all[1]?.payload["prompt_id"]).toBeString();
    expect(all[1]?.payload["prompt_at"]).toBeNumber();
    expect(all[2]?.payload["prompt_id"]).toBe(all[1]?.payload["prompt_id"]);
    expect(JSON.stringify(await codex.read(stateIn("ready")))).toContain("render 3");
  });

  test("each thread has its own line and its own renders", async () => {
    const codex = start();
    await codex.read(stateIn("ready", "thread-a"));
    await rendered(home, 1);
    const other = JSON.stringify(await codex.read(stateIn("ready", "thread-b")));
    expect(other).not.toContain("oss-sponsor");
    await rendered(home, 2);
    expect((await renders(home)).map((entry) => entry.payload["session_id"])).toEqual([
      "thread-a",
      "thread-b",
    ]);
  });

  test("a renderer with nothing to show leaves the developer's footer alone", async () => {
    const codex = start("none");
    await codex.read(stateIn("ready"));
    await rendered(home, 1);
    const tree = JSON.stringify(await codex.read(stateIn("ready")));
    expect(tree).toContain("gpt-6.1");
    expect(tree).not.toContain("oss-sponsor");
  });

  test("no line is asked for while Codex is still starting", async () => {
    const codex = start();
    await codex.read(stateIn("starting"));
    await codex.read(stateIn("starting"));
    await Bun.sleep(300);
    expect(await renders(home)).toHaveLength(0);
  });

  test("a read with no state, or one that is nonsense, is still a tree Codex can draw", async () => {
    const codex = start();
    expect(await codex.read(null)).toBeNull();
    await codex.read({ thread: { id: 7 }, config: "x" });
    await codex.read("garbage");
    expect(await renders(home)).toHaveLength(0);
  });

  test("nothing but replies is ever written, and a bad line does not end the process", async () => {
    const codex = start();
    codex.send("{not json");
    codex.send("");
    const pinged = await codex.request("ping");
    expect(pinged["result"]).toEqual({});
    await codex.read(stateIn("ready"));
    await rendered(home, 1);
    await codex.read(stateIn("ready"));
    for (const line of codex.everyLine) {
      expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe("2.0");
    }
  });

  test("it ends when Codex closes the pipe", async () => {
    const codex = start();
    await codex.request("ping");
    provider = null;
    expect(await codex.end()).toBe(0);
  });
});
