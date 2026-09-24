/**
 * A notice through the real renderer (A30): it takes the slot, bills nothing, and gives the slot
 * back.
 *
 * Driven through the CLI in a subprocess, like `chain-order.test.ts`, because what is under test
 * is bytes on stdout and requests on the wire — and because the state lives under `~/.obrigado`,
 * so a scratch `HOME` is what keeps a render from touching the developer's own install.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CI_VARIABLES } from "../src/api.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const NOTICE = { id: "update-0.2", body: "Obrigado 0.2 is out.", url: "https://obrigado.dev/u" };

let home: string;
let server: ReturnType<typeof Bun.serve> | null = null;
const requests: Array<{ path: string; body: unknown }> = [];

function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(CI_VARIABLES as readonly string[]).includes(key)) env[key] = value;
  }
  return { ...env, HOME: home, NO_COLOR: "1", OBRIGADO_HYPERLINKS: "0" };
}

function sessionResponse(): unknown {
  return {
    fp: "0".repeat(32),
    ttl_seconds: 600,
    serving: true,
    notice: NOTICE,
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

async function render(agent: string, extra: string[] = []): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI, "statusline", "--agent", agent, ...extra], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ session_id: "s-1", cwd: home, surface_version: "0.2.0" }),
    ),
    stdout: "pipe",
    stderr: "ignore",
    env: childEnvironment(),
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim();
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "obrigado-notice-render-"));
  requests.length = 0;
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      requests.push({ path, body: await request.json().catch(() => null) });
      return path.endsWith("/session")
        ? Response.json(sessionResponse())
        : Response.json({ accepted: 0, duplicates: 0 });
    },
  });
  await mkdir(join(home, ".obrigado"), { recursive: true });
  await writeFile(
    join(home, ".obrigado", "config.json"),
    JSON.stringify({
      install_key: "k".repeat(32),
      api_origin: `http://localhost:${server.port}`,
      session_summary: false,
    }),
  );
});

afterEach(async () => {
  server?.stop(true);
  server = null;
  await rm(home, { recursive: true, force: true });
});

describe("a notice in the slot", () => {
  test("is labelled as Obrigado's, and reports no impression", async () => {
    const line = await render("pi");

    expect(line).toBe(`obrigado · ${NOTICE.body}`);
    expect(requests.some((request) => request.path.endsWith("/beacon"))).toBe(false);
    const queue = await readFile(join(home, ".obrigado", "queue.jsonl"), "utf8").catch(() => "");
    expect(queue).not.toContain("impression");
  });

  test("the session request carries the shim's version", async () => {
    await render("pi");

    const session = requests.find((request) => request.path.endsWith("/session"));
    expect(session?.body).toMatchObject({ signals: { agent: "pi", surface_version: "0.2.0" } });
  });

  test("holds the slot for its window, then gives it back to the rotation", async () => {
    expect(await render("pi")).toContain("obrigado ·");
    expect(await render("pi")).toContain("obrigado ·");

    // The window opened a minute ago: past its hold, inside the day.
    await writeFile(
      join(home, ".obrigado", "notice.json"),
      JSON.stringify({ id: NOTICE.id, started_at: Date.now() - 60_000 }),
    );
    expect(await render("pi")).toContain("oss-sponsor ·");
  });

  test("a host that draws its own UI gets parts it already knows how to draw", async () => {
    const parts = JSON.parse(await render("opencode", ["--json"])) as Record<string, unknown>;

    expect(parts).toMatchObject({ kind: "notice", label: "obrigado", copy: NOTICE.body });
    expect(parts["url"]).toBe(NOTICE.url);
  });
});
