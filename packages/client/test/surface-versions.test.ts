/**
 * Every shim of ours inside a host reports its own version, and reports the right one (A30).
 *
 * The version travels in the payload the shim writes to the renderer, so the renderer can tell
 * the server which piece of an install has fallen behind. A literal that drifted from the
 * manifest would make that answer confidently wrong — the same failure `version.test.ts` guards
 * for the client itself.
 */
import { describe, expect, test } from "bun:test";

import { surfaceVersionFromPayload } from "../src/api.ts";

/** Hosts whose shim ships on its own schedule, and so carries its own manifest version. */
const PUBLISHED_SHIMS = [
  { name: "opencode-plugin", source: "../../opencode-plugin/src/tui.tsx" },
  { name: "vscode-extension", source: "../../vscode-extension/src/extension.ts" },
] as const;

function text(relative: string): Promise<string> {
  return Bun.file(new URL(relative, import.meta.url).pathname).text();
}

describe("a published shim reports its manifest's version", () => {
  for (const shim of PUBLISHED_SHIMS) {
    test(shim.name, async () => {
      const source = await text(shim.source);
      const manifest = JSON.parse(await text(`../../${shim.name}/package.json`)) as {
        version: string;
      };

      expect(source).toContain(`const SURFACE_VERSION = ${JSON.stringify(manifest.version)};`);
      // Declared and never sent is the quiet version of the same bug.
      expect(source).toContain("surface_version: SURFACE_VERSION");
    });
  }
});

describe("reading the version back out of a payload", () => {
  test("a well-formed version is read", () => {
    expect(surfaceVersionFromPayload(JSON.stringify({ surface_version: "0.3.1-beta.2" }))).toBe(
      "0.3.1-beta.2",
    );
  });

  test("anything the database column would refuse is no signal at all", () => {
    // The column's CHECK is what the upsert has to pass, and the upsert is the request that
    // serves the line: a malformed version must cost a signal, never a render.
    for (const bad of ["", "has space", "x".repeat(33), "0.1;DROP", 7, null]) {
      expect(surfaceVersionFromPayload(JSON.stringify({ surface_version: bad }))).toBeUndefined();
    }
    expect(surfaceVersionFromPayload("not json")).toBeUndefined();
    expect(surfaceVersionFromPayload("")).toBeUndefined();
  });
});
