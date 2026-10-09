/**
 * The prompt's age, end to end through a real render: Claude Code's payload names a prompt, and
 * the impression the render reports carries how long ago it was (`input_age_s`), which is what
 * the server's attention rule reads. A payload that names none reports no age.
 *
 * A subprocess with a scratch `HOME`, as in `chain-order.test.ts`, so the render reads no
 * developer's install, and a stand-in server that records the beacon it is sent.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CI_VARIABLES } from "../src/api.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

let home: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let beacons: unknown[] = [];

/** A developer's environment: the renderer withholds the line under any CI system. */
function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(CI_VARIABLES as readonly string[]).includes(key)) env[key] = value;
  }
  return { ...env, HOME: home, NO_COLOR: "1", OBRIGADO_HYPERLINKS: "0" };
}

function serve(): string {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith("/beacon")) {
        beacons.push(await request.json());
        return Response.json({ accepted: 1 });
      }
      return Response.json({
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
      });
    },
  });
  return `http://localhost:${server.port}`;
}

async function render(payload: Record<string, unknown>): Promise<void> {
  const origin = serve();
  await mkdir(join(home, ".obrigado"), { recursive: true });
  await writeFile(
    join(home, ".obrigado", "config.json"),
    JSON.stringify({
      install_key: "k".repeat(32),
      api_origin: origin,
      session_summary: false,
      integrations: { "claude-code": { installed: true } },
    }),
  );
  const proc = Bun.spawn([process.execPath, CLI, "statusline", "--agent", "claude-code"], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-1", cwd: home, ...payload })),
    stdout: "ignore",
    stderr: "ignore",
    env: childEnvironment(),
  });
  await proc.exited;
}

/** The signals of every impression the stand-in server was sent. */
function impressionSignals(): unknown[] {
  return beacons.flatMap((body) =>
    ((body as { events?: Array<{ type: string; signals?: unknown }> }).events ?? [])
      .filter((event) => event.type === "impression")
      .map((event) => event.signals),
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "obrigado-prompt-"));
  beacons = [];
});

afterEach(async () => {
  server?.stop(true);
  server = null;
  await rm(home, { recursive: true, force: true });
});

describe("a render's impression", () => {
  test("carries the age of the prompt the payload names, and never the prompt's id", async () => {
    await render({ prompt_id: "2b4f9c1e-3a7d-4e8b-9f10-6c5d4e3b2a19" });
    const [signals] = impressionSignals();
    expect(signals).toMatchObject({ input_age_s: 0 });
    expect(JSON.stringify(beacons)).not.toContain("2b4f9c1e");
  });

  test("from an editor, carries its window's focus and how long since it was used", async () => {
    await render({ focused: true, input_at: Date.now() - 42_000 });
    const [signals] = impressionSignals() as Array<{ focused?: boolean; input_age_s?: number }>;
    expect(signals?.focused).toBe(true);
    expect(signals?.input_age_s).toBeGreaterThanOrEqual(42);
    expect(signals?.input_age_s).toBeLessThan(60);
  });

  test("carries no age when the payload names no prompt", async () => {
    await render({});
    expect(impressionSignals()).toHaveLength(1);
    expect(impressionSignals()[0]).not.toHaveProperty("input_age_s");
  });
});
