/**
 * An uninstall turns the JetBrains plugin's line off (A43).
 *
 * No IDE takes a plugin out from its command line, so `obrigado uninstall --agent jetbrains`
 * records `installed: false` and the renderer answers the plugin with nothing from then on.
 * Driven through the real CLI with a scratch `HOME`, like `label-off.test.ts`, because the claim
 * is about the bytes the plugin reads. An install that never recorded JetBrains, because the
 * developer added the repository by hand, still gets its line.
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

async function writeConfig(jetbrains: { installed: boolean } | null): Promise<void> {
  await mkdir(join(home, ".obrigado"), { recursive: true });
  await writeFile(
    join(home, ".obrigado", "config.json"),
    JSON.stringify({
      install_key: "k".repeat(32),
      api_origin: `http://localhost:${String(server?.port)}`,
      session_summary: false,
      integrations: {
        "claude-code": { installed: true },
        ...(jetbrains === null ? {} : { jetbrains }),
      },
    }),
  );
}

async function render(agent: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI, "statusline", "--agent", agent, "--json"], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-1", cwd: home })),
    stdout: "pipe",
    stderr: "ignore",
    env: childEnvironment(),
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim();
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "obrigado-jetbrains-off-"));
  server = Bun.serve({ port: 0, fetch: () => Response.json(batchResponse()) });
});

afterEach(async () => {
  server?.stop(true);
  server = null;
  await rm(home, { recursive: true, force: true });
});

describe("the JetBrains plugin's line", () => {
  test("is drawn beside a live agent while the plugin is installed", async () => {
    await writeConfig({ installed: true });
    // An editor's line is a companion to an agent's (A21): one has to have rendered just now.
    await render("claude-code");

    expect(await render("jetbrains")).toContain(COPY);
  });

  test("is drawn for a plugin installed by hand, which the install never recorded", async () => {
    await writeConfig(null);
    await render("claude-code");

    expect(await render("jetbrains")).toContain(COPY);
  });

  test("is off once an uninstall has recorded it, agent or no agent", async () => {
    await writeConfig({ installed: false });
    await render("claude-code");

    expect(await render("jetbrains")).toBe("");
  });
});
