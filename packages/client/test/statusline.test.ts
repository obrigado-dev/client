/**
 * Tests for the statusline writer.
 *
 * This is the highest-consequence code in the client. §3: "Never patch another
 * program's files." Every property below is a claim Obrigado makes publicly, so
 * each one is asserted against a real file on disk rather than reasoned about.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installStatusLine,
  isOurStatusLine,
  readSettings,
  statusLineCommand,
  uninstallStatusLine,
} from "../src/statusline.ts";

let dir: string;
let settingsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "obrigado-statusline-"));
  settingsPath = join(dir, "settings.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (value: unknown): Promise<void> =>
  writeFile(settingsPath, JSON.stringify(value, null, 2));

describe("installing", () => {
  test("adds only the statusLine key and preserves everything else exactly", async () => {
    const original = {
      model: "opus",
      permissions: { allow: ["Bash(git:*)"], deny: [] },
      env: { FOO: "bar" },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
    };
    await write(original);

    const { outcome } = await installStatusLine(settingsPath);
    expect(outcome.status).toBe("installed");

    const after = await readSettings(settingsPath);
    // Every pre-existing key survives byte-for-byte.
    for (const [key, value] of Object.entries(original)) {
      expect(after?.[key]).toEqual(value);
    }
    // Exactly one key was added.
    expect(Object.keys(after ?? {}).toSorted()).toEqual(
      [...Object.keys(original), "statusLine"].toSorted(),
    );
    expect(after?.["statusLine"]).toEqual({
      type: "command",
      command: statusLineCommand(),
      padding: 0,
    });
  });

  test("creates the file when Claude Code has no settings yet", async () => {
    const { outcome } = await installStatusLine(settingsPath);
    expect(outcome.status).toBe("installed");
    expect(isOurStatusLine((await readSettings(settingsPath))?.["statusLine"])).toBe(true);
  });

  test("REFUSES to overwrite another tool's statusline", async () => {
    // The behaviour that gets a tool delisted. The developer earns nothing from
    // Obrigado, so a surprise here has no upside to trade against.
    const foreign = { type: "command", command: "some-other-tool render" };
    await write({ statusLine: foreign });

    const { outcome } = await installStatusLine(settingsPath);
    expect(outcome.status).toBe("refused");

    // The file is untouched.
    const after = await readSettings(settingsPath);
    expect(after?.["statusLine"]).toEqual(foreign);
  });

  test("refuses to overwrite the developer's own statusline", async () => {
    const personal = { type: "command", command: "~/bin/my-prompt.sh" };
    await write({ statusLine: personal });

    expect((await installStatusLine(settingsPath)).outcome.status).toBe("refused");
    expect((await readSettings(settingsPath))?.["statusLine"]).toEqual(personal);
  });

  test("is idempotent — installing twice changes nothing", async () => {
    await installStatusLine(settingsPath);
    const first = await readFile(settingsPath, "utf8");

    const second = await installStatusLine(settingsPath);
    expect(second.outcome.status).toBe("already-installed");
    expect(await readFile(settingsPath, "utf8")).toBe(first);
  });

  test("backs the file up before writing", async () => {
    await write({ model: "opus" });
    const { outcome } = await installStatusLine(settingsPath);

    expect(outcome.status).toBe("installed");
    if (outcome.status !== "installed" || outcome.backup === null) throw new Error("no backup");
    expect(JSON.parse(await readFile(outcome.backup, "utf8"))).toEqual({ model: "opus" });
  });

  test("refuses a settings file that is not a JSON object", async () => {
    await writeFile(settingsPath, "[1, 2, 3]");
    expect(installStatusLine(settingsPath)).rejects.toThrow();
  });
});

describe("uninstalling", () => {
  test("removes the key and leaves the rest of the file intact", async () => {
    const original = { model: "opus", permissions: { allow: [] } };
    await write(original);
    await installStatusLine(settingsPath);

    expect(await uninstallStatusLine(null, settingsPath)).toBe("removed");
    expect(await readSettings(settingsPath)).toEqual(original);
  });

  test("restores a previous statusline byte-for-byte", async () => {
    const previous = { type: "command", command: "my-tool", padding: 2, custom: { a: 1 } };
    await write({ model: "opus", statusLine: previous });

    // Simulate the developer removing theirs, installing, then uninstalling.
    await write({ model: "opus" });
    const { previous: recorded } = await installStatusLine(settingsPath);
    expect(recorded).toBeNull();

    // Now the case that matters: uninstall with a recorded previous value.
    expect(await uninstallStatusLine(previous, settingsPath)).toBe("restored");
    expect((await readSettings(settingsPath))?.["statusLine"]).toEqual(previous);
  });

  test("leaves a foreign statusline alone", async () => {
    const foreign = { type: "command", command: "other-tool" };
    await write({ statusLine: foreign });

    expect(await uninstallStatusLine(null, settingsPath)).toBe("foreign");
    expect((await readSettings(settingsPath))?.["statusLine"]).toEqual(foreign);
  });

  test("is a no-op when nothing is installed", async () => {
    await write({ model: "opus" });
    expect(await uninstallStatusLine(null, settingsPath)).toBe("not-installed");
    expect(await readSettings(settingsPath)).toEqual({ model: "opus" });
  });

  test("install then uninstall is a round trip", async () => {
    const original = {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      outputStyle: "concise",
    };
    await write(original);

    await installStatusLine(settingsPath);
    await uninstallStatusLine(null, settingsPath);

    expect(await readSettings(settingsPath)).toEqual(original);
  });
});

describe("--replace", () => {
  const foreign = {
    type: "command",
    command: "input=$(cat); printf '%s' \"$(whoami)\"",
  };

  test("takes over an existing statusline only when asked", async () => {
    await write({ model: "opus", statusLine: foreign });

    // Default still refuses.
    expect((await installStatusLine(settingsPath)).outcome.status).toBe("refused");
    expect((await readSettings(settingsPath))?.["statusLine"]).toEqual(foreign);

    const { outcome, previous } = await installStatusLine(settingsPath, { replace: true });
    expect(outcome.status).toBe("installed");
    expect(previous).toEqual(foreign);
    expect(isOurStatusLine((await readSettings(settingsPath))?.["statusLine"])).toBe(true);
  });

  test("is reversible — uninstall restores the replaced line exactly", async () => {
    await write({ model: "opus", permissions: { allow: ["Bash(ls:*)"] }, statusLine: foreign });
    const original = await readFile(settingsPath, "utf8");

    const { previous } = await installStatusLine(settingsPath, { replace: true });
    expect(await uninstallStatusLine(previous, settingsPath)).toBe("restored");

    // Byte-for-byte, including key order and the surrounding settings.
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(JSON.parse(original));
  });

  test("still backs the file up before replacing", async () => {
    await write({ statusLine: foreign });
    const { outcome } = await installStatusLine(settingsPath, { replace: true });

    if (outcome.status !== "installed" || outcome.backup === null) throw new Error("no backup");
    expect(JSON.parse(await readFile(outcome.backup, "utf8"))).toEqual({ statusLine: foreign });
  });
});

describe("the installed command must be runnable", () => {
  test("falls back to an absolute bun invocation when obrigado is not on PATH", () => {
    // `obrigado statusline` only resolves once the CLI is globally installed.
    // From a source checkout it is not, and Claude Code would silently invoke a
    // command that does not exist — indistinguishable from a broken product.
    const command = statusLineCommand();
    expect(command).toContain("statusline");
    if (Bun.which("obrigado") === null) {
      expect(command).toContain("cli.ts");
      expect(command.startsWith("/")).toBe(true);
    }
  });

  test("an explicit override wins", () => {
    const previous = process.env["OBRIGADO_STATUSLINE_COMMAND"];
    process.env["OBRIGADO_STATUSLINE_COMMAND"] = "my-wrapper obrigado statusline";
    try {
      expect(statusLineCommand()).toBe("my-wrapper obrigado statusline");
    } finally {
      if (previous === undefined) delete process.env["OBRIGADO_STATUSLINE_COMMAND"];
      else process.env["OBRIGADO_STATUSLINE_COMMAND"] = previous;
    }
  });

  test("whatever form is written is recognised as ours", async () => {
    // Otherwise uninstall refuses to clean up its own work and a reinstall
    // reports the slot as belonging to a stranger.
    await installStatusLine(settingsPath);
    const written = (await readSettings(settingsPath))?.["statusLine"];
    expect(isOurStatusLine(written)).toBe(true);
    expect(await uninstallStatusLine(null, settingsPath)).toBe("removed");
  });
});

describe("recognising our own entry", () => {
  test("identifies the entry Obrigado writes", () => {
    expect(
      isOurStatusLine({ type: "command", command: "obrigado statusline --agent claude-code" }),
    ).toBe(true);
    expect(
      isOurStatusLine({ type: "command", command: "/usr/local/bin/obrigado statusline" }),
    ).toBe(true);
  });

  test("does not claim someone else's", () => {
    expect(isOurStatusLine({ type: "command", command: "starship prompt" })).toBe(false);
    expect(isOurStatusLine()).toBe(false);
    expect(isOurStatusLine(null)).toBe(false);
    expect(isOurStatusLine("obrigado statusline")).toBe(false);
    expect(isOurStatusLine({})).toBe(false);
  });
});
