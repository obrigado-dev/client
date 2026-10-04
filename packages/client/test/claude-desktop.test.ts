/**
 * The Claude desktop app's settings writer (A37).
 *
 * The same file as the status line, so the same claims: only our entries are written, a
 * stranger's is never overwritten, and uninstall takes back exactly what install wrote. Each is
 * asserted against a real file on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_DESKTOP_PLUGIN_ID,
  desktopRendererCommand,
  installClaudeDesktopPlugin,
  uninstallClaudeDesktopPlugin,
} from "../src/claude-desktop.ts";
import { readSettings } from "../src/statusline.ts";

const RENDERER = "/Users/someone/.local/bin/obrigado statusline";
const MARKETPLACE = {
  source: { source: "github", repo: "obrigado-dev/client" },
  autoUpdate: true,
};

let dir: string;
let settingsPath: string;
let backups: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "obrigado-desktop-"));
  settingsPath = join(dir, "settings.json");
  backups = join(dir, "backups");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (value: unknown): Promise<void> =>
  writeFile(settingsPath, JSON.stringify(value, null, 2));

describe("installing", () => {
  test("declares the marketplace, enables the plugin and names the renderer, and nothing else", async () => {
    const original = {
      model: "opus",
      statusLine: { type: "command", command: "obrigado statusline --agent claude-code" },
      env: { FOO: "bar" },
      enabledPlugins: { "theirs@elsewhere": true },
      extraKnownMarketplaces: { elsewhere: { source: { source: "github", repo: "a/b" } } },
    };
    await write(original);

    const outcome = await installClaudeDesktopPlugin(RENDERER, undefined, settingsPath, backups);
    expect(outcome.status).toBe("installed");

    expect(await readSettings(settingsPath)).toEqual({
      model: "opus",
      statusLine: original.statusLine,
      env: { FOO: "bar", OBRIGADO_STATUSLINE_COMMAND: RENDERER },
      enabledPlugins: { "theirs@elsewhere": true, [CLAUDE_DESKTOP_PLUGIN_ID]: true },
      extraKnownMarketplaces: { ...original.extraKnownMarketplaces, obrigado: MARKETPLACE },
    });
  });

  test("turns on Claude Code's own updates for our marketplace, and only ours (A38)", async () => {
    // Off by default for every marketplace but Anthropic's: without this, nobody who installed
    // the mod would get a release after the first.
    await write({
      extraKnownMarketplaces: { elsewhere: { source: { source: "github", repo: "a/b" } } },
    });
    await installClaudeDesktopPlugin(RENDERER, undefined, settingsPath, backups);
    const marketplaces = (await readSettings(settingsPath))?.["extraKnownMarketplaces"] as Record<
      string,
      { autoUpdate?: boolean }
    >;

    expect(marketplaces["obrigado"]?.autoUpdate).toBe(true);
    expect(marketplaces["elsewhere"]?.autoUpdate).toBeUndefined();
  });

  test("an install from before updates were on is brought up to date", async () => {
    await write({
      extraKnownMarketplaces: { obrigado: { source: MARKETPLACE.source } },
      enabledPlugins: { [CLAUDE_DESKTOP_PLUGIN_ID]: true },
      env: { OBRIGADO_STATUSLINE_COMMAND: RENDERER },
    });

    expect(
      (await installClaudeDesktopPlugin(RENDERER, RENDERER, settingsPath, backups)).status,
    ).toBe("installed");
  });

  test("works on a machine with no settings file yet", async () => {
    expect(
      (await installClaudeDesktopPlugin(RENDERER, undefined, settingsPath, backups)).status,
    ).toBe("installed");
    expect((await readSettings(settingsPath))?.["enabledPlugins"]).toEqual({
      [CLAUDE_DESKTOP_PLUGIN_ID]: true,
    });
  });

  test("a second run changes nothing", async () => {
    await installClaudeDesktopPlugin(RENDERER, undefined, settingsPath, backups);
    expect(
      (await installClaudeDesktopPlugin(RENDERER, RENDERER, settingsPath, backups)).status,
    ).toBe("already-installed");
  });

  test("a binary that moved replaces the renderer we wrote", async () => {
    await installClaudeDesktopPlugin(RENDERER, undefined, settingsPath, backups);
    const moved = "/opt/obrigado/bin/obrigado statusline";

    expect((await installClaudeDesktopPlugin(moved, RENDERER, settingsPath, backups)).status).toBe(
      "installed",
    );
    const env = (await readSettings(settingsPath))?.["env"] as Record<string, string>;
    expect(env["OBRIGADO_STATUSLINE_COMMAND"]).toBe(moved);
  });

  test("refuses another marketplace that already holds our name", async () => {
    const original = {
      extraKnownMarketplaces: { obrigado: { source: { source: "github", repo: "x/y" } } },
    };
    await write(original);

    const outcome = await installClaudeDesktopPlugin(RENDERER, undefined, settingsPath, backups);
    expect(outcome.status).toBe("refused");
    expect(await readSettings(settingsPath)).toEqual(original);
  });

  test("refuses a renderer the developer set themselves", async () => {
    const original = { env: { OBRIGADO_STATUSLINE_COMMAND: "my-wrapper statusline" } };
    await write(original);

    const outcome = await installClaudeDesktopPlugin(RENDERER, undefined, settingsPath, backups);
    expect(outcome.status).toBe("refused");
    expect(await readSettings(settingsPath)).toEqual(original);
  });
});

describe("uninstalling", () => {
  test("turns the plugin off and takes back only our entries", async () => {
    await write({
      env: { FOO: "bar" },
      enabledPlugins: { "theirs@elsewhere": true },
      extraKnownMarketplaces: { elsewhere: { source: { source: "github", repo: "a/b" } } },
    });
    await installClaudeDesktopPlugin(RENDERER, undefined, settingsPath, backups);

    expect(await uninstallClaudeDesktopPlugin(RENDERER, settingsPath, backups)).toBe("removed");
    expect(await readSettings(settingsPath)).toEqual({
      env: { FOO: "bar" },
      // Off, not absent: a plugin Claude Code installed starts enabled when settings name it
      // nowhere, so only an explicit false keeps it off.
      enabledPlugins: { "theirs@elsewhere": true, [CLAUDE_DESKTOP_PLUGIN_ID]: false },
      extraKnownMarketplaces: { elsewhere: { source: { source: "github", repo: "a/b" } } },
    });
  });

  test("leaves no empty objects behind where ours were the only entries", async () => {
    await installClaudeDesktopPlugin(RENDERER, undefined, settingsPath, backups);
    await uninstallClaudeDesktopPlugin(RENDERER, settingsPath, backups);

    expect(await readSettings(settingsPath)).toEqual({
      enabledPlugins: { [CLAUDE_DESKTOP_PLUGIN_ID]: false },
    });
  });

  test("keeps a renderer that was changed since, which is no longer ours", async () => {
    await installClaudeDesktopPlugin(RENDERER, undefined, settingsPath, backups);
    const settings = (await readSettings(settingsPath)) ?? {};
    await write({ ...settings, env: { OBRIGADO_STATUSLINE_COMMAND: "my-wrapper statusline" } });

    await uninstallClaudeDesktopPlugin(RENDERER, settingsPath, backups);
    expect((await readSettings(settingsPath))?.["env"]).toEqual({
      OBRIGADO_STATUSLINE_COMMAND: "my-wrapper statusline",
    });
  });

  test("reports nothing to do where nothing of ours is there", async () => {
    await write({ model: "opus" });
    expect(await uninstallClaudeDesktopPlugin(RENDERER, settingsPath, backups)).toBe(
      "not-installed",
    );
    expect(await readSettings(settingsPath)).toEqual({ model: "opus" });
  });
});

describe("the renderer command", () => {
  test("is the renderer's full path and its subcommand", () => {
    expect(desktopRendererCommand(["/Users/someone/.local/bin/obrigado", "statusline"])).toBe(
      RENDERER,
    );
  });

  test("quotes a path the mod would otherwise split at a space", () => {
    expect(
      desktopRendererCommand(["/Applications/My Tools/bun", "/src/it's/cli.ts", "statusline"]),
    ).toBe(`'/Applications/My Tools/bun' '/src/it'\\''s/cli.ts' statusline`);
  });
});
