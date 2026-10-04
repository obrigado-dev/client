/**
 * The renderer the installer names in the app's settings, split back into argv by the mod.
 *
 * The installer quotes a path with a space in it (`claude-desktop.test.ts` pins this exact
 * string), and the mod splits the variable with the vendored `splitCommand`. The two ends are
 * different packages, so the string is the contract and both sides pin it.
 */
import { describe, expect, test } from "bun:test";

import { statuslineArgv } from "../hooks/surface.ts";

describe("the renderer named by the installer", () => {
  test("comes back as the parts it was written from", () => {
    const written = `'/Applications/My Tools/bun' '/src/it'\\''s/cli.ts' statusline`;

    expect(statuslineArgv("claude-desktop", written)).toEqual([
      "/Applications/My Tools/bun",
      "/src/it's/cli.ts",
      "statusline",
      "--agent",
      "claude-desktop",
      "--json",
    ]);
  });
});
