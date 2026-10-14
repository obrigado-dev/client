import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  installOpenCodePlugin,
  OPENCODE_PLUGIN_SPEC,
  OPENCODE_PLUGIN_VERSION,
  openCodePluginFiles,
  repairOpenCodePlugin,
  uninstallOpenCodePlugin,
} from "../src/opencode-plugin.ts";
import type { OpenCodeConfigPaths } from "../src/opencode-plugin.ts";

/** What every install wrote before 0.3.3, which OpenCode cannot load. */
const LEGACY = "@obrigado/opencode-plugin/tui";

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "obrigado-opencode-"));
}

/** OpenCode's two files in `dir`: `tui.json` for 1, and `cli.json`, which 2 makes. */
function pathsIn(dir: string, tui = "tui.json"): OpenCodeConfigPaths {
  return { tui: join(dir, tui), cli: join(dir, "cli.json") };
}

async function withConfig(
  document?: unknown,
): Promise<{ dir: string; path: string; paths: OpenCodeConfigPaths }> {
  const dir = await scratch();
  const paths = pathsIn(dir);
  if (document !== undefined) await Bun.write(paths.tui, JSON.stringify(document, null, 2));
  return { dir, path: paths.tui, paths };
}

async function read(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("installing into tui.json", () => {
  test("pins the plugin this release ships, because OpenCode never updates one it has (A41)", async () => {
    // An unpinned spec stays on whatever version OpenCode first cached; a new pin is a new install.
    const manifest = (await Bun.file(
      new URL("../../opencode-plugin/package.json", import.meta.url).pathname,
    ).json()) as { version: string };
    expect(OPENCODE_PLUGIN_VERSION).toBe(manifest.version);
    expect(OPENCODE_PLUGIN_SPEC).toBe(`@obrigado/opencode-plugin@${manifest.version}`);
  });

  test("creates the file when OpenCode has no TUI config yet", async () => {
    const { dir, path, paths } = await withConfig();
    const outcome = await installOpenCodePlugin(paths, join(dir, "backups"));
    expect(outcome.status).toBe("installed");

    const after = await read(path);
    expect(after["plugin"]).toEqual([OPENCODE_PLUGIN_SPEC]);
    // The schema line is what makes the file self-describing in an editor.
    expect(after["$schema"]).toBe("https://opencode.ai/tui.json");
  });

  test("appends beside another tool's plugin rather than replacing it", async () => {
    const { dir, path, paths } = await withConfig({
      $schema: "https://opencode.ai/tui.json",
      theme: "tokyonight",
      plugin: ["opencode-subagent-statusline"],
    });
    await installOpenCodePlugin(paths, join(dir, "backups"));

    const after = await read(path);
    expect(after["plugin"]).toEqual(["opencode-subagent-statusline", OPENCODE_PLUGIN_SPEC]);
    // Everything that was not the plugin array is carried through untouched.
    expect(after["theme"]).toBe("tokyonight");
  });

  test("keeps a developer's own $schema rather than overwriting it", async () => {
    const { dir, path, paths } = await withConfig({ $schema: "./my-schema.json" });
    await installOpenCodePlugin(paths, join(dir, "backups"));
    expect((await read(path))["$schema"]).toBe("./my-schema.json");
  });

  test("is idempotent", async () => {
    const { dir, path, paths } = await withConfig();
    const backups = join(dir, "backups");
    await installOpenCodePlugin(paths, backups);
    expect((await installOpenCodePlugin(paths, backups)).status).toBe("already-installed");
    expect((await read(path))["plugin"]).toEqual([OPENCODE_PLUGIN_SPEC]);
  });

  test("backs the file up before rewriting it", async () => {
    const { dir, paths } = await withConfig({ plugin: ["someone-else"] });
    const backups = join(dir, "backups");
    await installOpenCodePlugin(paths, backups);
    expect((await readdir(backups)).some((name) => name.startsWith("opencode-tui-"))).toBe(true);
  });

  test("refuses a file it cannot parse rather than rewriting it", async () => {
    const dir = await scratch();
    const paths = pathsIn(dir);
    const path = paths.tui;
    // Comments are legal in this file's schema and illegal in JSON. Rewriting from a
    // lossy parse would silently delete them, so the refusal is the correct outcome.
    await Bun.write(path, '{\n  // my notes\n  "theme": "dark"\n}');
    await expect(installOpenCodePlugin(paths, join(dir, "backups"))).rejects.toThrow(path);
    expect(await readFile(path, "utf8")).toContain("// my notes");
  });

  test("refuses when `plugin` is not an array", async () => {
    const { dir, paths } = await withConfig({ plugin: "nonsense" });
    await expect(installOpenCodePlugin(paths, join(dir, "backups"))).rejects.toThrow(/non-array/u);
  });
});

describe("uninstalling", () => {
  test("removes only our entry", async () => {
    const { dir, path, paths } = await withConfig({ plugin: ["opencode-subagent-statusline"] });
    const backups = join(dir, "backups");
    await installOpenCodePlugin(paths, backups);

    expect(await uninstallOpenCodePlugin(paths, backups)).toBe("removed");
    expect((await read(path))["plugin"]).toEqual(["opencode-subagent-statusline"]);
  });

  test("drops the key when nothing is left, restoring the shape we found", async () => {
    const { dir, path, paths } = await withConfig();
    const backups = join(dir, "backups");
    await installOpenCodePlugin(paths, backups);
    await uninstallOpenCodePlugin(paths, backups);
    expect((await read(path))["plugin"]).toBeUndefined();
  });

  test("recognises a pinned or option-carrying entry as ours", async () => {
    const { dir, path, paths } = await withConfig({
      plugin: [["@obrigado/opencode-plugin@1.2.3", { verbose: true }]],
    });
    expect(await openCodePluginFiles(paths)).toEqual([path]);
    expect(await uninstallOpenCodePlugin(paths, join(dir, "backups"))).toBe("removed");
  });

  test("reports nothing to do when no entry is ours", async () => {
    const { dir, paths } = await withConfig({ plugin: ["someone-else"] });
    expect(await uninstallOpenCodePlugin(paths, join(dir, "backups"))).toBe("not-installed");
  });

  test("is a no-op when there is no config at all", async () => {
    const dir = await scratch();
    expect(await uninstallOpenCodePlugin(pathsIn(dir), join(dir, "backups"))).toBe("not-installed");
  });
});

describe("the entry earlier installs wrote, which OpenCode cannot load", () => {
  test("names the package, whose exports OpenCode reads `./tui` from", () => {
    // A subpath is read by npm's spec parser as a local directory, so the install fails silently.
    expect(OPENCODE_PLUGIN_SPEC).not.toContain("/tui");
  });

  test("install replaces it where it stands, and then has nothing left to do", async () => {
    const { dir, path, paths } = await withConfig({ plugin: ["first", LEGACY, "last"] });
    const backups = join(dir, "backups");

    expect((await installOpenCodePlugin(paths, backups)).status).toBe("installed");
    expect((await read(path))["plugin"]).toEqual(["first", OPENCODE_PLUGIN_SPEC, "last"]);
    expect((await readdir(backups)).some((name) => name.startsWith("opencode-tui-"))).toBe(true);
    expect((await installOpenCodePlugin(paths, backups)).status).toBe("already-installed");
  });

  test("install drops it beside a current entry rather than writing ours twice", async () => {
    const later = "@obrigado/opencode-plugin@9.9.9";
    const { dir, path, paths } = await withConfig({ plugin: [LEGACY, later] });

    await installOpenCodePlugin(paths, join(dir, "backups"));
    expect((await read(path))["plugin"]).toEqual([later]);
  });

  test("the repair rewrites it in place, options and all, once", async () => {
    const { dir, path, paths } = await withConfig({
      plugin: [[LEGACY, { verbose: true }], "theirs"],
    });
    const backups = join(dir, "backups");

    expect(await repairOpenCodePlugin(paths, backups)).toBe("repaired");
    expect((await read(path))["plugin"]).toEqual([
      [OPENCODE_PLUGIN_SPEC, { verbose: true }],
      "theirs",
    ]);
    expect(await repairOpenCodePlugin(paths, backups)).toBe("unchanged");
  });

  test("the repair never adds ours to a list that does not have it", async () => {
    const document = { plugin: ["theirs"] };
    const { dir, path, paths } = await withConfig(document);

    expect(await repairOpenCodePlugin(paths, join(dir, "backups"))).toBe("unchanged");
    expect(await read(path)).toEqual(document);
    expect(await repairOpenCodePlugin(pathsIn(dir, "absent.json"), join(dir, "backups"))).toBe(
      "unchanged",
    );
  });

  test("the repair leaves this release's pin, and a later one, alone", async () => {
    const document = { plugin: [OPENCODE_PLUGIN_SPEC, "@obrigado/opencode-plugin@9.9.9"] };
    const { dir, path, paths } = await withConfig(document);

    expect(await repairOpenCodePlugin(paths, join(dir, "backups"))).toBe("unchanged");
    expect(await read(path)).toEqual(document);
  });

  test("uninstall takes it out like any other form of ours", async () => {
    const { dir, path, paths } = await withConfig({ plugin: ["theirs", LEGACY] });

    expect(await uninstallOpenCodePlugin(paths, join(dir, "backups"))).toBe("removed");
    expect((await read(path))["plugin"]).toEqual(["theirs"]);
  });
});

describe("moving the pin (A41)", () => {
  test("the unpinned form and an earlier pin move to this release's version", async () => {
    const unpinned = await withConfig({ plugin: ["@obrigado/opencode-plugin"] });
    expect(await repairOpenCodePlugin(unpinned.paths, join(unpinned.dir, "backups"))).toBe(
      "repaired",
    );
    expect((await read(unpinned.path))["plugin"]).toEqual([OPENCODE_PLUGIN_SPEC]);

    const older = await withConfig({ plugin: ["@obrigado/opencode-plugin@0.1.0", "theirs"] });
    expect(await repairOpenCodePlugin(older.paths, join(older.dir, "backups"))).toBe("repaired");
    expect((await read(older.path))["plugin"]).toEqual([OPENCODE_PLUGIN_SPEC, "theirs"]);
  });

  test("install moves an earlier pin too, instead of calling it installed", async () => {
    const { dir, path, paths } = await withConfig({ plugin: ["@obrigado/opencode-plugin@0.1.0"] });

    expect((await installOpenCodePlugin(paths, join(dir, "backups"))).status).toBe("installed");
    expect((await read(path))["plugin"]).toEqual([OPENCODE_PLUGIN_SPEC]);
  });

  test("a local path of ours is a developer's choice, and is left alone", async () => {
    const local = "file:///work/node_modules/@obrigado/opencode-plugin";
    const { dir, path, paths } = await withConfig({ plugin: [local] });

    expect((await installOpenCodePlugin(paths, join(dir, "backups"))).status).toBe(
      "already-installed",
    );
    expect(await repairOpenCodePlugin(paths, join(dir, "backups"))).toBe("unchanged");
    expect((await read(path))["plugin"]).toEqual([local]);
  });
});

/** What OpenCode 2 writes when it carries a `tui.json` over, theme and all. */
function carriedOver(plugins: unknown[]): Record<string, unknown> {
  return { $schema: "https://opencode.ai/v2/cli.json", theme: { name: "tokyonight" }, plugins };
}

async function withBoth(
  tui: unknown,
  cli: unknown,
): Promise<{ dir: string; paths: OpenCodeConfigPaths }> {
  const dir = await scratch();
  const paths = pathsIn(dir);
  await Bun.write(paths.tui, JSON.stringify(tui, null, 2));
  await Bun.write(paths.cli, JSON.stringify(cli, null, 2));
  return { dir, paths };
}

describe("OpenCode 2's cli.json (A42)", () => {
  test("install writes ours into both once OpenCode 2 has made its file", async () => {
    const { dir, paths } = await withBoth({ plugin: [] }, carriedOver(["opencode-other-plugin"]));
    const backups = join(dir, "backups");

    const outcome = await installOpenCodePlugin(paths, backups);
    expect(outcome).toMatchObject({ status: "installed", files: [paths.tui, paths.cli] });
    expect((await read(paths.tui))["plugin"]).toEqual([OPENCODE_PLUGIN_SPEC]);
    // Appended to the list OpenCode 2 reads, and nothing else in the file touched.
    expect(await read(paths.cli)).toEqual(
      carriedOver(["opencode-other-plugin", OPENCODE_PLUGIN_SPEC]),
    );
    const names = await readdir(backups);
    expect(names.some((name) => name.startsWith("opencode-tui-"))).toBe(true);
    expect(names.some((name) => name.startsWith("opencode-cli-"))).toBe(true);

    expect((await installOpenCodePlugin(paths, backups)).status).toBe("already-installed");
  });

  test("install never makes cli.json, so OpenCode 2 still carries tui.json over itself", async () => {
    const { dir, paths } = await withConfig({ theme: "tokyonight" });

    const outcome = await installOpenCodePlugin(paths, join(dir, "backups"));
    expect(outcome).toMatchObject({ status: "installed", files: [paths.tui] });
    expect(await Bun.file(paths.cli).exists()).toBe(false);
  });

  test("the 0.3.0 pin OpenCode 2 carried over moves, so it installs a version it can load", async () => {
    // 0.3.0 exported only OpenCode 1's `tui()`, which OpenCode 2 refuses to load.
    const old = "@obrigado/opencode-plugin@0.3.0";
    const { dir, paths } = await withBoth({ plugin: [old] }, carriedOver([old]));

    expect(await repairOpenCodePlugin(paths, join(dir, "backups"))).toBe("repaired");
    expect((await read(paths.tui))["plugin"]).toEqual([OPENCODE_PLUGIN_SPEC]);
    expect(await read(paths.cli)).toEqual(carriedOver([OPENCODE_PLUGIN_SPEC]));
  });

  test("a pin with options moves in OpenCode 2's own form, beside its directives", async () => {
    const { dir, paths } = await withBoth(
      {},
      {
        plugins: [
          { package: "@obrigado/opencode-plugin@0.3.0", options: { verbose: true } },
          "-opencode.which-key",
        ],
      },
    );

    expect(await repairOpenCodePlugin(paths, join(dir, "backups"))).toBe("repaired");
    expect((await read(paths.cli))["plugins"]).toEqual([
      { package: OPENCODE_PLUGIN_SPEC, options: { verbose: true } },
      "-opencode.which-key",
    ]);
  });

  test("uninstall takes ours out of both, and leaves a developer's `-obrigado` alone", async () => {
    const { dir, paths } = await withBoth(
      { plugin: [OPENCODE_PLUGIN_SPEC, "theirs"] },
      { plugins: ["-obrigado", { package: OPENCODE_PLUGIN_SPEC }] },
    );

    expect(await openCodePluginFiles(paths)).toEqual([paths.tui, paths.cli]);
    expect(await uninstallOpenCodePlugin(paths, join(dir, "backups"))).toBe("removed");
    expect((await read(paths.tui))["plugin"]).toEqual(["theirs"]);
    expect((await read(paths.cli))["plugins"]).toEqual(["-obrigado"]);
    expect(await openCodePluginFiles(paths)).toEqual([]);
  });

  test("a cli.json it cannot parse stops the install before either file is written", async () => {
    const dir = await scratch();
    const paths = pathsIn(dir);
    await Bun.write(paths.cli, '{\n  // mine\n  "plugins": []\n}');

    await expect(installOpenCodePlugin(paths, join(dir, "backups"))).rejects.toThrow(paths.cli);
    expect(await Bun.file(paths.tui).exists()).toBe(false);
    expect(await readFile(paths.cli, "utf8")).toContain("// mine");
  });

  test("the repair still brings tui.json forward when cli.json cannot be read", async () => {
    const dir = await scratch();
    const paths = pathsIn(dir);
    await Bun.write(paths.tui, JSON.stringify({ plugin: ["@obrigado/opencode-plugin@0.3.0"] }));
    await Bun.write(paths.cli, "{ not json");

    expect(await repairOpenCodePlugin(paths, join(dir, "backups"))).toBe("repaired");
    expect((await read(paths.tui))["plugin"]).toEqual([OPENCODE_PLUGIN_SPEC]);
    expect(await readFile(paths.cli, "utf8")).toBe("{ not json");
  });
});
