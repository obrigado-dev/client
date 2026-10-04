/**
 * The mod's files agree with the packages they come from.
 *
 * A hooks module may import only files inside the plugin directory, so `@obrigado/surface` is
 * carried in as `hooks/surface.ts` rather than imported. A copy is only safe while it is the
 * same file: the rules it holds — the label, the URL, the styles a host may draw — must not
 * differ between this host and the others.
 *
 * Claude Code installs the mod from the marketplace at the client repository's root, pinned to a
 * tag, so the version has three places to agree: the two manifests and that pin.
 */
import { describe, expect, test } from "bun:test";

function text(relative: string): Promise<string> {
  return Bun.file(new URL(relative, import.meta.url).pathname).text();
}

describe("the vendored surface", () => {
  test("is byte for byte the package's source", async () => {
    // To refresh it: cp packages/surface/src/index.ts packages/claude-code-mod/hooks/surface.ts
    expect(await text("../hooks/surface.ts")).toBe(await text("../../surface/src/index.ts"));
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

  test("is the tag the marketplace installs", async () => {
    // The marketplace is read from the default branch, so a plugin installed from a path in it
    // would be whatever was last pushed there, under whatever version string it carried. Pinned
    // to the release's tag, what users get is what was released and nothing pushed since.
    const plugin = JSON.parse(await text("../.claude-plugin/plugin.json")) as { version: string };
    const marketplace = JSON.parse(await text("../../../.claude-plugin/marketplace.json")) as {
      plugins: { name: string; source: unknown }[];
    };
    const entry = marketplace.plugins.find((candidate) => candidate.name === "obrigado");

    expect(entry?.source).toEqual({
      source: "git-subdir",
      url: "https://github.com/obrigado-dev/client.git",
      path: "packages/claude-code-mod",
      ref: `claude-code-mod-v${plugin.version}`,
    });
  });
});
