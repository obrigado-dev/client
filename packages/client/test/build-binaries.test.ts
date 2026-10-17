/**
 * A release's binaries by name: the contract between the build, `SHA256SUMS`, install.sh,
 * install.ps1 and the self-update (A38, A46). A name changed on one side is a 404 on one
 * platform alone, which shows up as a support question rather than a failed build.
 */
import { describe, expect, test } from "bun:test";

import { NOT_ON_NPM, NPM_PLATFORMS } from "../src/npm-packages.ts";
import { binaryAsset, RELEASE_TARGETS } from "../src/release.ts";

describe("a release's binaries", () => {
  test("are named as the installers and the self-update ask for them", () => {
    expect(Object.keys(RELEASE_TARGETS).map((target) => binaryAsset(target))).toEqual([
      "obrigado-darwin-arm64",
      "obrigado-darwin-x64",
      "obrigado-linux-arm64",
      "obrigado-linux-x64",
      "obrigado-linux-x64-musl",
      "obrigado-windows-x64.exe",
      "obrigado-windows-arm64.exe",
    ]);
  });

  test("are each compiled for the platform they are named for", () => {
    for (const [target, bun] of Object.entries(RELEASE_TARGETS)) {
      expect<string>(bun).toBe(`bun-${target}`);
    }
  });

  test("are each on npm, or refused there by name", () => {
    for (const target of Object.keys(RELEASE_TARGETS)) {
      expect(`${target}: ${target in NPM_PLATFORMS || NOT_ON_NPM.has(target)}`).toBe(
        `${target}: true`,
      );
    }
    expect([...NOT_ON_NPM].every((target) => target.startsWith("windows-"))).toBe(true);
  });
});
