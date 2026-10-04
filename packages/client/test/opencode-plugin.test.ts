import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  hasOurPlugin,
  installOpenCodePlugin,
  OPENCODE_PLUGIN_SPEC,
  readTuiConfig,
  repairOpenCodePlugin,
  uninstallOpenCodePlugin,
} from "../src/opencode-plugin.ts";

/** What every install wrote before 0.3.3, which OpenCode cannot load. */
const LEGACY = "@obrigado/opencode-plugin/tui";

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "obrigado-opencode-"));
}

async function withConfig(document?: unknown): Promise<{ dir: string; path: string }> {
  const dir = await scratch();
  const path = join(dir, "tui.json");
  if (document !== undefined) await Bun.write(path, JSON.stringify(document, null, 2));
  return { dir, path };
}

async function read(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("installing into tui.json", () => {
  test("writes the plugin unpinned, which is how OpenCode keeps it current (A38)", () => {
    // `@obrigado/opencode-plugin@1.2.3` would hold every install at 1.2.3 for good.
    expect(OPENCODE_PLUGIN_SPEC).not.toMatch(/^@obrigado\/opencode-plugin@/u);
  });

  test("creates the file when OpenCode has no TUI config yet", async () => {
    const { dir, path } = await withConfig();
    const outcome = await installOpenCodePlugin(path, join(dir, "backups"));
    expect(outcome.status).toBe("installed");

    const after = await read(path);
    expect(after["plugin"]).toEqual([OPENCODE_PLUGIN_SPEC]);
    // The schema line is what makes the file self-describing in an editor.
    expect(after["$schema"]).toBe("https://opencode.ai/tui.json");
  });

  test("appends beside another tool's plugin rather than replacing it", async () => {
    const { dir, path } = await withConfig({
      $schema: "https://opencode.ai/tui.json",
      theme: "tokyonight",
      plugin: ["opencode-subagent-statusline"],
    });
    await installOpenCodePlugin(path, join(dir, "backups"));

    const after = await read(path);
    expect(after["plugin"]).toEqual(["opencode-subagent-statusline", OPENCODE_PLUGIN_SPEC]);
    // Everything that was not the plugin array is carried through untouched.
    expect(after["theme"]).toBe("tokyonight");
  });

  test("keeps a developer's own $schema rather than overwriting it", async () => {
    const { dir, path } = await withConfig({ $schema: "./my-schema.json" });
    await installOpenCodePlugin(path, join(dir, "backups"));
    expect((await read(path))["$schema"]).toBe("./my-schema.json");
  });

  test("is idempotent", async () => {
    const { dir, path } = await withConfig();
    const backups = join(dir, "backups");
    await installOpenCodePlugin(path, backups);
    expect((await installOpenCodePlugin(path, backups)).status).toBe("already-installed");
    expect((await read(path))["plugin"]).toEqual([OPENCODE_PLUGIN_SPEC]);
  });

  test("backs the file up before rewriting it", async () => {
    const { dir, path } = await withConfig({ plugin: ["someone-else"] });
    const backups = join(dir, "backups");
    await installOpenCodePlugin(path, backups);
    expect((await readdir(backups)).some((name) => name.startsWith("opencode-tui-"))).toBe(true);
  });

  test("refuses a file it cannot parse rather than rewriting it", async () => {
    const dir = await scratch();
    const path = join(dir, "tui.json");
    // Comments are legal in this file's schema and illegal in JSON. Rewriting from a
    // lossy parse would silently delete them, so the refusal is the correct outcome.
    await Bun.write(path, '{\n  // my notes\n  "theme": "dark"\n}');
    expect(installOpenCodePlugin(path, join(dir, "backups"))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toContain("// my notes");
  });

  test("refuses when `plugin` is not an array", async () => {
    const { dir, path } = await withConfig({ plugin: "nonsense" });
    expect(installOpenCodePlugin(path, join(dir, "backups"))).rejects.toThrow(/non-array/u);
  });
});

describe("uninstalling", () => {
  test("removes only our entry", async () => {
    const { dir, path } = await withConfig({ plugin: ["opencode-subagent-statusline"] });
    const backups = join(dir, "backups");
    await installOpenCodePlugin(path, backups);

    expect(await uninstallOpenCodePlugin(path, backups)).toBe("removed");
    expect((await read(path))["plugin"]).toEqual(["opencode-subagent-statusline"]);
  });

  test("drops the key when nothing is left, restoring the shape we found", async () => {
    const { dir, path } = await withConfig();
    const backups = join(dir, "backups");
    await installOpenCodePlugin(path, backups);
    await uninstallOpenCodePlugin(path, backups);
    expect((await read(path))["plugin"]).toBeUndefined();
  });

  test("recognises a pinned or option-carrying entry as ours", async () => {
    const { dir, path } = await withConfig({
      plugin: [[`${OPENCODE_PLUGIN_SPEC}@1.2.3`, { verbose: true }]],
    });
    expect(hasOurPlugin(await readTuiConfig(path))).toBe(true);
    expect(await uninstallOpenCodePlugin(path, join(dir, "backups"))).toBe("removed");
  });

  test("reports nothing to do when no entry is ours", async () => {
    const { dir, path } = await withConfig({ plugin: ["someone-else"] });
    expect(await uninstallOpenCodePlugin(path, join(dir, "backups"))).toBe("not-installed");
  });

  test("is a no-op when there is no config at all", async () => {
    const dir = await scratch();
    expect(await uninstallOpenCodePlugin(join(dir, "tui.json"), join(dir, "backups"))).toBe(
      "not-installed",
    );
  });
});

describe("the entry earlier installs wrote, which OpenCode cannot load", () => {
  test("names the package, whose exports OpenCode reads `./tui` from", () => {
    // A subpath is read by npm's spec parser as a local directory, so the install fails silently.
    expect(OPENCODE_PLUGIN_SPEC).toBe("@obrigado/opencode-plugin");
  });

  test("install replaces it where it stands, and then has nothing left to do", async () => {
    const { dir, path } = await withConfig({ plugin: ["first", LEGACY, "last"] });
    const backups = join(dir, "backups");

    expect((await installOpenCodePlugin(path, backups)).status).toBe("installed");
    expect((await read(path))["plugin"]).toEqual(["first", OPENCODE_PLUGIN_SPEC, "last"]);
    expect((await readdir(backups)).some((name) => name.startsWith("opencode-tui-"))).toBe(true);
    expect((await installOpenCodePlugin(path, backups)).status).toBe("already-installed");
  });

  test("install drops it beside a current entry rather than writing ours twice", async () => {
    const pinned = `${OPENCODE_PLUGIN_SPEC}@0.1.0`;
    const { dir, path } = await withConfig({ plugin: [LEGACY, pinned] });

    await installOpenCodePlugin(path, join(dir, "backups"));
    expect((await read(path))["plugin"]).toEqual([pinned]);
  });

  test("the repair rewrites it in place, options and all, once", async () => {
    const { dir, path } = await withConfig({ plugin: [[LEGACY, { verbose: true }], "theirs"] });
    const backups = join(dir, "backups");

    expect(await repairOpenCodePlugin(path, backups)).toBe("repaired");
    expect((await read(path))["plugin"]).toEqual([
      [OPENCODE_PLUGIN_SPEC, { verbose: true }],
      "theirs",
    ]);
    expect(await repairOpenCodePlugin(path, backups)).toBe("unchanged");
  });

  test("the repair never adds ours to a list that does not have it", async () => {
    const document = { plugin: ["theirs"] };
    const { dir, path } = await withConfig(document);

    expect(await repairOpenCodePlugin(path, join(dir, "backups"))).toBe("unchanged");
    expect(await read(path)).toEqual(document);
    expect(await repairOpenCodePlugin(join(dir, "absent.json"), join(dir, "backups"))).toBe(
      "unchanged",
    );
  });

  test("the repair leaves a current or pinned entry alone", async () => {
    const document = { plugin: [OPENCODE_PLUGIN_SPEC, `${OPENCODE_PLUGIN_SPEC}@0.1.0`] };
    const { dir, path } = await withConfig(document);

    expect(await repairOpenCodePlugin(path, join(dir, "backups"))).toBe("unchanged");
    expect(await read(path)).toEqual(document);
  });

  test("uninstall takes it out like any other form of ours", async () => {
    const { dir, path } = await withConfig({ plugin: ["theirs", LEGACY] });

    expect(await uninstallOpenCodePlugin(path, join(dir, "backups"))).toBe("removed");
    expect((await read(path))["plugin"]).toEqual(["theirs"]);
  });
});
