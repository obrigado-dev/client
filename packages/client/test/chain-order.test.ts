/**
 * Which row the sponsored line takes, and the promise that survives choosing.
 *
 * Driven through the real CLI in a subprocess rather than by calling `statusline()` directly,
 * because the thing under test is the ORDER OF BYTES on stdout, and because the config lives at
 * `~/.obrigado` — so a scratch `HOME` is what keeps a render test from reading the developer's
 * own install.
 *
 * The guarantee being pinned is the one that made "below" safe for free: a developer must never
 * lose their own status line because our server was down. Below got that from being printed
 * first. Above cannot, so it gets it from a `finally`, and these tests are what say so.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const THEIRS = "THEIR OWN LINE";

let home: string;
let server: ReturnType<typeof Bun.serve> | null = null;

/** One creative, in the shape the contract actually clears. */
function batchResponse(): unknown {
  return {
    fp: "0".repeat(32),
    ttl_seconds: 600,
    serving: true,
    batch: [
      {
        impression_id: "11111111-2222-4333-8444-555555555555",
        nonce: btoa("nonce-value"),
        body: "A sponsored line",
        click_url: "https://example.com/click",
        style: "default",
        effect: "none",
        spans: [],
        brand: null,
        rev_micros: 1000,
      },
    ],
  };
}

async function writeConfig(position: "above" | "below", origin: string): Promise<void> {
  await mkdir(join(home, ".obrigado"), { recursive: true });
  await writeFile(
    join(home, ".obrigado", "config.json"),
    JSON.stringify({
      install_key: "k".repeat(32),
      api_origin: origin,
      session_summary: false,
      integrations: {
        "claude-code": {
          installed: true,
          chained_command: `printf '%s\\n' '${THEIRS}'`,
          sponsored_position: position,
        },
      },
    }),
  );
}

/** Runs the CLI the way Claude Code does: payload on stdin, one line per row on stdout. */
async function render(): Promise<string[]> {
  const proc = Bun.spawn([process.execPath, CLI, "statusline", "--agent", "claude-code"], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-1", cwd: home })),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, HOME: home, NO_COLOR: "1", OBRIGADO_HYPERLINKS: "0" },
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.split("\n").filter((line) => line.trim().length > 0);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "obrigado-order-"));
});

afterEach(async () => {
  server?.stop(true);
  server = null;
  await rm(home, { recursive: true, force: true });
});

describe("when there is a line to show", () => {
  beforeEach(() => {
    server = Bun.serve({ port: 0, fetch: () => Response.json(batchResponse()) });
  });

  test("below puts the developer's line on top", async () => {
    await writeConfig("below", `http://localhost:${server?.port}`);

    const lines = await render();

    expect(lines[0]).toBe(THEIRS);
    expect(lines[1]).toContain("sponsored ·");
  });

  test("above puts ours on top", async () => {
    await writeConfig("above", `http://localhost:${server?.port}`);

    const lines = await render();

    expect(lines[0]).toContain("sponsored ·");
    expect(lines[1]).toBe(THEIRS);
  });

  test("either way the developer's line appears exactly once", async () => {
    await writeConfig("above", `http://localhost:${server?.port}`);

    const lines = await render();

    expect(lines.filter((line) => line === THEIRS).length).toBe(1);
  });
});

/*
 * The reason the ordering option needed care at all. With no reachable server there is no batch,
 * so the render gives up early — and in "above" the developer's line has not been printed yet.
 */
describe("when our half fails", () => {
  test("above still prints the developer's line", async () => {
    await writeConfig("above", "http://127.0.0.1:1");

    const lines = await render();

    expect(lines).toEqual([THEIRS]);
  });

  test("below still prints the developer's line", async () => {
    await writeConfig("below", "http://127.0.0.1:1");

    const lines = await render();

    expect(lines).toEqual([THEIRS]);
  });
});
