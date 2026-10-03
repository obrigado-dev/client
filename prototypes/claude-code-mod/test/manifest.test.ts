/**
 * The mod's files agree with the packages they come from.
 *
 * A hooks module may import only files inside the plugin directory, so `@obrigado/surface` is
 * carried in as `hooks/surface.ts` rather than imported. A copy is only safe while it is the
 * same file: the rules it holds — the label, the URL, the styles a host may draw — must not
 * differ between this host and the others.
 *
 * Parked or not, these run in the gate, so the mod is still ready to go when it is picked up.
 */
import { describe, expect, test } from "bun:test";

function text(relative: string): Promise<string> {
  return Bun.file(new URL(relative, import.meta.url).pathname).text();
}

describe("the vendored surface", () => {
  test("is byte for byte the package's source", async () => {
    // To refresh it: cp packages/surface/src/index.ts prototypes/claude-code-mod/hooks/surface.ts
    expect(await text("../hooks/surface.ts")).toBe(
      await text("../../../packages/surface/src/index.ts"),
    );
  });
});

describe("the version", () => {
  test("is the same in the plugin manifest Claude Code reads and the workspace's", async () => {
    // Claude Code caches an installed plugin by this version, so a release that forgot to
    // bump it would never reach anybody who already had the mod.
    const plugin = JSON.parse(await text("../.claude-plugin/plugin.json")) as { version: string };
    const workspace = JSON.parse(await text("../package.json")) as { version: string };

    expect(plugin.version).toBe(workspace.version);
  });

  test("is the one the mod reports on every render (A30)", async () => {
    // What `surface-versions.test.ts` holds every published shim to, held here while this one
    // is not published.
    const source = await text("../hooks/register.ts");
    const plugin = JSON.parse(await text("../.claude-plugin/plugin.json")) as { version: string };

    expect(source).toContain(`const SURFACE_VERSION = ${JSON.stringify(plugin.version)};`);
    // Declared and never sent is the quiet version of the same bug.
    expect(source).toContain("surface_version: SURFACE_VERSION");
  });
});
