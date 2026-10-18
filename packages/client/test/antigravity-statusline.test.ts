/**
 * Antigravity CLI's status line (A47): the same write as Claude Code's, into a second file.
 *
 * The rules are the ones `statusline.test.ts` holds Claude Code's file to — one key, nothing of
 * anybody else's overwritten or removed — asserted here against a real file because this file is
 * Antigravity's and the claim is the same claim. What is particular to this host is asserted too:
 * the line stacks under the built-in one, and there is no takeover to ask for.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  antigravityStatusLine,
  installAntigravityStatusLine,
  uninstallAntigravityStatusLine,
} from "../src/antigravity-statusline.ts";
import { requestedAgent } from "../src/commands/install.ts";
import { isOurStatusLine, readSettings, statusLineOwner } from "../src/statusline.ts";

let dir: string;
let settingsPath: string;
let backups: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "obrigado-antigravity-"));
  settingsPath = join(dir, "antigravity-cli", "settings.json");
  backups = join(dir, "backups");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (value: unknown): Promise<void> => {
  await mkdir(join(dir, "antigravity-cli"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(value, null, 2));
};

describe("the entry", () => {
  test("stacks under the built-in line rather than replacing it", () => {
    const entry = antigravityStatusLine();
    expect(entry["type"]).toBe("command");
    expect(entry["stack_with_default"]).toBe(true);
  });

  test("names this host, so its impressions are not billed as Claude Code's", () => {
    expect(String(antigravityStatusLine()["command"])).toEndWith(
      "statusline --agent antigravity-cli",
    );
  });

  test("is recognised as ours alone, so uninstall can take it back", () => {
    expect(isOurStatusLine(antigravityStatusLine())).toBe(true);
    expect(statusLineOwner(antigravityStatusLine())).toBe("ours");
  });
});

describe("installing", () => {
  test("creates the file, and its directory, when the CLI has no settings yet", async () => {
    expect((await installAntigravityStatusLine(settingsPath, backups)).status).toBe("installed");
    expect((await readSettings(settingsPath))?.["statusLine"]).toEqual(antigravityStatusLine());
  });

  test("adds only the statusLine key and preserves everything else exactly", async () => {
    const original = { model: "gemini-4", theme: "dark", hooks: { Stop: [] } };
    await write(original);

    expect((await installAntigravityStatusLine(settingsPath, backups)).status).toBe("installed");
    const after = await readSettings(settingsPath);
    for (const [key, value] of Object.entries(original)) expect(after?.[key]).toEqual(value);
    expect(Object.keys(after ?? {}).toSorted()).toEqual(
      [...Object.keys(original), "statusLine"].toSorted(),
    );
  });

  test("REFUSES to displace the developer's own status line, and writes nothing", async () => {
    const theirs = { type: "command", command: "~/.gemini/antigravity-cli/statusline.sh" };
    await write({ statusLine: theirs });

    const outcome = await installAntigravityStatusLine(settingsPath, backups);
    expect(outcome).toEqual({ status: "refused", existing: theirs });
    expect((await readSettings(settingsPath))?.["statusLine"]).toEqual(theirs);
  });

  test("is idempotent — installing twice changes nothing", async () => {
    await installAntigravityStatusLine(settingsPath, backups);
    const first = await readSettings(settingsPath);
    expect((await installAntigravityStatusLine(settingsPath, backups)).status).toBe(
      "already-installed",
    );
    expect(await readSettings(settingsPath)).toEqual(first);
  });

  test("backs an existing file up under its own name", async () => {
    await write({ model: "gemini-4" });
    await installAntigravityStatusLine(settingsPath, backups);
    const files = await readdir(backups);
    expect(files).toHaveLength(1);
    expect(files[0]).toStartWith("antigravity-cli-settings-");
  });
});

describe("uninstalling", () => {
  test("removes the key and leaves the rest of the file intact", async () => {
    await write({ model: "gemini-4" });
    await installAntigravityStatusLine(settingsPath, backups);

    expect(await uninstallAntigravityStatusLine(settingsPath, backups)).toBe("removed");
    expect(await readSettings(settingsPath)).toEqual({ model: "gemini-4" });
  });

  test("leaves the developer's own status line alone", async () => {
    const theirs = { type: "command", command: "~/bin/agy-line" };
    await write({ statusLine: theirs });

    expect(await uninstallAntigravityStatusLine(settingsPath, backups)).toBe("foreign");
    expect((await readSettings(settingsPath))?.["statusLine"]).toEqual(theirs);
  });

  test("leaves a command of the developer's that runs ours inside it alone", async () => {
    const nested = { type: "command", command: "~/bin/agy-line; obrigado statusline" };
    await write({ statusLine: nested });

    expect(await uninstallAntigravityStatusLine(settingsPath, backups)).toBe("nested");
    expect((await readSettings(settingsPath))?.["statusLine"]).toEqual(nested);
  });

  test("is a no-op when nothing is installed", async () => {
    expect(await uninstallAntigravityStatusLine(settingsPath, backups)).toBe("not-installed");
  });
});

describe("targeting", () => {
  test("`--agent antigravity-cli` is accepted, and so are the two new editors", () => {
    expect(requestedAgent(["--agent", "antigravity-cli"])).toBe("antigravity-cli");
    expect(requestedAgent(["--agent=antigravity-ide"])).toBe("antigravity-ide");
    expect(requestedAgent(["--agent", "kiro"])).toBe("kiro");
  });

  test("Kiro CLI is known but not installable, because its status line is closed", () => {
    expect(() => requestedAgent(["--agent", "kiro-cli"])).toThrow(/Unsupported agent/u);
  });
});
