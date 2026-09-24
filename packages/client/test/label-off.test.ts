/**
 * The disclosure is on unless the developer turns it off (A34).
 *
 * Driven through the real CLI in a subprocess, like `chain-order.test.ts` and for the same
 * reason: the subject is the BYTES on stdout, and the setting lives at `~/.obrigado`, so a
 * scratch `HOME` is what keeps this from reading the developer's own install.
 *
 * Both renderings are pinned. The plain one drops the prefix; the `--json` one sends `label:
 * null`, which is what tells a host that draws its own UI to draw the copy alone rather than
 * invent a prefix. A default install gets the label, which is the case that must not rot:
 * this is a switch one person can reach for themselves, not a default anybody ships.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CI_VARIABLES } from "../src/api.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const COPY = "A sponsored line";

let home: string;
let server: ReturnType<typeof Bun.serve> | null = null;

function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(CI_VARIABLES as readonly string[]).includes(key)) env[key] = value;
  }
  return { ...env, HOME: home, NO_COLOR: "1", OBRIGADO_HYPERLINKS: "0" };
}

function batchResponse(): unknown {
  return {
    fp: "0".repeat(32),
    ttl_seconds: 600,
    serving: true,
    batch: [
      {
        impression_id: "11111111-2222-4333-8444-555555555555",
        nonce: btoa("nonce-value"),
        body: COPY,
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

async function writeConfig(label?: "on" | "off"): Promise<void> {
  await mkdir(join(home, ".obrigado"), { recursive: true });
  await writeFile(
    join(home, ".obrigado", "config.json"),
    JSON.stringify({
      install_key: "k".repeat(32),
      api_origin: `http://localhost:${String(server?.port)}`,
      session_summary: false,
      ...(label === undefined ? {} : { label }),
      integrations: { "claude-code": { installed: true } },
    }),
  );
}

async function render(...flags: readonly string[]): Promise<string> {
  const proc = Bun.spawn(
    [process.execPath, CLI, "statusline", "--agent", "claude-code", ...flags],
    {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-1", cwd: home })),
      stdout: "pipe",
      stderr: "ignore",
      env: childEnvironment(),
    },
  );
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim();
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "obrigado-label-"));
  server = Bun.serve({ port: 0, fetch: () => Response.json(batchResponse()) });
});

afterEach(async () => {
  server?.stop(true);
  server = null;
  await rm(home, { recursive: true, force: true });
});

describe("the disclosure", () => {
  test("is there by default", async () => {
    await writeConfig();
    expect(await render()).toStartWith("oss-sponsor · ");
  });

  test("is gone when the developer turns it off, and the copy is not", async () => {
    await writeConfig("off");

    const line = await render();

    expect(line).not.toContain("oss-sponsor");
    expect(line).toContain(COPY);
  });

  test("travels as null to a host that draws its own UI", async () => {
    await writeConfig("off");

    const parts = JSON.parse(await render("--json")) as { label: unknown; copy: string };

    expect(parts.label).toBeNull();
    expect(parts.copy).toBe(COPY);
  });

  test("travels as the label itself when it is on", async () => {
    await writeConfig("on");

    const parts = JSON.parse(await render("--json")) as { label: unknown };

    expect(parts.label).toBe("oss-sponsor");
  });
});
