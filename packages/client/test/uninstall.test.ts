/**
 * `obrigado uninstall` across hosts that share a file. Claude Code's status line and the Claude
 * desktop app's plugin both live in `~/.claude/settings.json`; removed side by side, each read the
 * file, the second write landed on the first, and one host's removal was lost while it reported
 * success. Found on a real machine: the status line stayed ours after "restored the previous
 * statusLine". Run through the CLI, as a developer runs it, in a home of its own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const RENDERER = "/opt/obrigado/bin/obrigado statusline";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "obrigado-uninstall-"));
  await mkdir(join(home, ".claude"));
  await mkdir(join(home, ".obrigado"));
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      model: "the developer's own",
      statusLine: {
        type: "command",
        command: "obrigado statusline --agent claude-code",
        padding: 0,
      },
      env: { OBRIGADO_STATUSLINE_COMMAND: RENDERER, THEIRS: "kept" },
      enabledPlugins: { "obrigado@obrigado": true },
      extraKnownMarketplaces: {
        obrigado: { source: { source: "github", repo: "obrigado-dev/client" }, autoUpdate: true },
      },
    }),
  );
  await writeFile(
    join(home, ".obrigado", "config.json"),
    JSON.stringify({
      install_key: "test-key",
      api_origin: "http://127.0.0.1:9",
      integrations: {
        "claude-code": {
          installed: true,
          previous_status_line: { type: "command", command: "runcommand statusline", padding: 0 },
        },
        "claude-desktop": { installed: true, renderer_command: RENDERER },
      },
    }),
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("uninstall", () => {
  test("takes Claude Code's status line and the desktop app's plugin out of one settings file", async () => {
    const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: home };
    const proc = Bun.spawn(["bun", CLI, "uninstall"], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = [
      await new Response(proc.stdout).text(),
      await new Response(proc.stderr).text(),
    ];

    expect({ status: await proc.exited, err }).toEqual({ status: 0, err: "" });
    expect(out).toContain("Claude Code: restored the previous statusLine.");
    expect(JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"))).toEqual({
      model: "the developer's own",
      statusLine: { type: "command", command: "runcommand statusline", padding: 0 },
      env: { THEIRS: "kept" },
      enabledPlugins: { "obrigado@obrigado": false },
    });
  });
});
