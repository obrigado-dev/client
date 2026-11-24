import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  ChainedProvider,
  providerIdFrom,
  statuslineUri,
  stdioServerFrom,
  treeFrom,
} from "../src/codex-chain.ts";
import type { StdioServer } from "../src/codex-chain.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "codex-chained-provider.ts");

function server(mode: string): StdioServer {
  return { command: process.execPath, args: [FIXTURE], env: { MODE: mode }, cwd: undefined };
}

const STATE = { thread: { id: "thread-1" } };

describe("the provider Codex had saved", () => {
  test("is a server and a tool, as Codex's picker writes it", () => {
    expect(providerIdFrom({ server: "ccusage", tool: "statusline" })).toEqual({
      server: "ccusage",
      tool: "statusline",
    });
  });

  test("is nothing for the built-in footer, or for anything else", () => {
    expect(providerIdFrom("default")).toBeNull();
    expect(providerIdFrom(null)).toBeNull();
    expect(providerIdFrom({ server: "x" })).toBeNull();
    expect(providerIdFrom({ server: "", tool: "y" })).toBeNull();
  });
});

describe("the server it names", () => {
  const config = {
    mcp_servers: {
      usage: {
        command: "ccusage",
        args: ["codex", "statusline", 7],
        env: { A: "1", B: 2 },
        cwd: "/w",
      },
      remote: { url: "https://example.com/mcp" },
      off: { command: "x", enabled: false },
      obrigado: { command: "obrigado", args: ["codex-provider"] },
    },
  };

  test("is started as config.toml says: command, args, env, cwd", () => {
    expect(stdioServerFrom(config, "usage")).toEqual({
      command: "ccusage",
      args: ["codex", "statusline"],
      env: { A: "1" },
      cwd: "/w",
    });
  });

  test("cannot be chained where there is no command to start, or it is switched off", () => {
    expect(stdioServerFrom(config, "remote")).toBeNull();
    expect(stdioServerFrom(config, "off")).toBeNull();
    expect(stdioServerFrom(config, "missing")).toBeNull();
    expect(stdioServerFrom(null, "usage")).toBeNull();
  });

  test("is never ours: a provider chained to itself would start itself for every read", () => {
    expect(stdioServerFrom(config, "obrigado")).toBeNull();
  });
});

/** A tool list in which `usage` lists these entrypoints. */
const tool = (entrypoints: unknown): unknown[] => [
  { name: "other" },
  { name: "usage", _meta: { "openai/ui": { entrypoints } } },
];

/** A `resources/read` result holding one resource. */
const contents = (overrides: Record<string, unknown> = {}): unknown => ({
  contents: [{ uri: "ui://a/b", mimeType: "application/json", text: '"theirs"', ...overrides }],
});

/** Their server takes a moment to start; a read made before it has is answered without it. */
async function readWhenStarted(provider: ChainedProvider, now = Date.now()): Promise<unknown> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one read after another, as Codex makes them
    const tree = await provider.read(STATE, now);
    if (tree !== undefined) return tree;
    // oxlint-disable-next-line eslint/no-await-in-loop -- waiting for the server to start
    await Bun.sleep(100);
  }
  return undefined;
}

describe("what their server lists and returns", () => {
  test("the footer is the tool's one statusline resource", () => {
    expect(statuslineUri(tool([{ type: "statusline", resourceUri: "ui://a/b" }]), "usage")).toBe(
      "ui://a/b",
    );
  });

  test("none, several, or one that is not a ui:// resource is no footer, as it is to Codex", () => {
    expect(statuslineUri(tool([]), "usage")).toBeNull();
    expect(statuslineUri(tool([{ type: "panel", resourceUri: "ui://a/b" }]), "usage")).toBeNull();
    expect(
      statuslineUri(tool([{ type: "statusline", resourceUri: "https://a/b" }]), "usage"),
    ).toBeNull();
    expect(
      statuslineUri(
        tool([
          { type: "statusline", resourceUri: "ui://a/b" },
          { type: "statusline", resourceUri: "ui://a/c" },
        ]),
        "usage",
      ),
    ).toBeNull();
    expect(
      statuslineUri(tool([{ type: "statusline", resourceUri: "ui://a/b" }]), "missing"),
    ).toBeNull();
    expect(statuslineUri(undefined, "usage")).toBeNull();
  });

  test("a tree Codex would draw is taken", () => {
    expect(treeFrom(contents(), "ui://a/b")).toBe("theirs");
    expect(treeFrom(contents({ text: "null" }), "ui://a/b")).toBeNull();
    expect(treeFrom(contents({ mimeType: "Application/JSON; charset=utf-8" }), "ui://a/b")).toBe(
      "theirs",
    );
  });

  test("anything Codex would refuse is not", () => {
    expect(treeFrom(contents({ uri: "ui://other" }), "ui://a/b")).toBeUndefined();
    expect(treeFrom(contents({ mimeType: "text/plain" }), "ui://a/b")).toBeUndefined();
    expect(treeFrom(contents({ text: "{nope" }), "ui://a/b")).toBeUndefined();
    expect(
      treeFrom(contents({ text: '{"type":"marquee","children":[]}' }), "ui://a/b"),
    ).toBeUndefined();
    expect(treeFrom({ contents: [] }, "ui://a/b")).toBeUndefined();
    expect(treeFrom({ contents: [{}, {}] }, "ui://a/b")).toBeUndefined();
    expect(treeFrom(null, "ui://a/b")).toBeUndefined();
  });
});

describe("chaining a real server", () => {
  const open: ChainedProvider[] = [];
  const chain = (mode: string): ChainedProvider => {
    const provider = new ChainedProvider(server(mode), "usage");
    open.push(provider);
    return provider;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((provider) => provider.close()));
  });

  test("their footer comes back, drawn from the state Codex sent", async () => {
    expect(await readWhenStarted(chain("good"))).toEqual({
      type: "row",
      props: { gap: 1 },
      children: ["theirs", "thread-1"],
    });
  });

  test("a tree Codex would refuse is not passed on", async () => {
    expect(await chain("invalid-tree").read(STATE)).toBeUndefined();
  });

  test("a server that lists no footer under the saved tool gives none", async () => {
    expect(await chain("no-footer").read(STATE)).toBeUndefined();
  });

  test("a read their server sits on is given up inside Codex's second", async () => {
    const provider = chain("hang");
    const started = Date.now();
    expect(await provider.read(STATE)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a server that failed is left alone for a while, then started again", async () => {
    const provider = chain("exit-after-read");
    const now = 1_800_000_000_000;
    expect(await readWhenStarted(provider, now)).toBeDefined();
    await Bun.sleep(200);
    // It has exited. The read that finds out fails, and the next ones do not start it again yet.
    expect(await provider.read(STATE, now + 1000)).toBeUndefined();
    expect(await provider.read(STATE, now + 2000)).toBeUndefined();
    // Half a minute on it is started afresh, and answers.
    expect(await readWhenStarted(provider, now + 60_000)).toBeDefined();
  });

  test("a command that does not exist is no footer, not a crash", async () => {
    const provider = new ChainedProvider(
      { command: "/nonexistent/provider", args: [], env: {}, cwd: undefined },
      "usage",
    );
    open.push(provider);
    expect(await provider.read(STATE)).toBeUndefined();
  });
});
