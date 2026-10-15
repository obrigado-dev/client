/**
 * The CLI on npm (A44): `@obrigado/client` and the one package per platform that carries the
 * release's binary.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  mainManifest,
  NPM_PLATFORMS,
  platformManifest,
  platformReadme,
} from "../src/npm-packages.ts";

describe("@obrigado/client", () => {
  test("names every platform package at its own exact version", () => {
    expect(mainManifest("1.2.3").optionalDependencies).toEqual({
      "@obrigado/client-darwin-arm64": "1.2.3",
      "@obrigado/client-darwin-x64": "1.2.3",
      "@obrigado/client-linux-arm64": "1.2.3",
      "@obrigado/client-linux-x64": "1.2.3",
      "@obrigado/client-linux-x64-musl": "1.2.3",
    });
  });

  test("puts the launcher on PATH as `obrigado`, and installs only where a build runs", () => {
    expect(mainManifest("1.2.3")).toMatchObject({
      name: "@obrigado/client",
      bin: { obrigado: "bin/obrigado" },
      os: ["darwin", "linux"],
      cpu: ["arm64", "x64"],
      files: ["bin"],
    });
    expect(mainManifest("1.2.3")).not.toHaveProperty("private");
  });

  test("comes from this repository, which npm holds the provenance to", async () => {
    const source = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as {
      repository: { type: string; url: string; directory: string };
    };

    expect(mainManifest("1.2.3").repository).toEqual(source.repository);
    expect(platformManifest("linux-x64", "1.2.3").repository).toEqual(source.repository);
  });
});

describe("the platform packages", () => {
  test("each says where it runs, so a package manager installs only the one that fits", () => {
    expect(
      Object.keys(NPM_PLATFORMS).map((asset) => {
        const { name, os, cpu, libc } = platformManifest(asset, "1.2.3");
        return { name, os, cpu, libc };
      }),
    ).toEqual([
      { name: "@obrigado/client-darwin-arm64", os: ["darwin"], cpu: ["arm64"], libc: undefined },
      { name: "@obrigado/client-darwin-x64", os: ["darwin"], cpu: ["x64"], libc: undefined },
      { name: "@obrigado/client-linux-arm64", os: ["linux"], cpu: ["arm64"], libc: ["glibc"] },
      { name: "@obrigado/client-linux-x64", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
      { name: "@obrigado/client-linux-x64-musl", os: ["linux"], cpu: ["x64"], libc: ["musl"] },
    ]);
  });

  test("exist only for a release binary", () => {
    expect(() => platformManifest("windows-x64", "1.2.3")).toThrow(
      "no npm package for obrigado-windows-x64",
    );
  });

  test("send whoever finds one by name to @obrigado/client", () => {
    expect(platformReadme("linux-arm64")).toContain(
      "Install [`@obrigado/client`](https://www.npmjs.com/package/@obrigado/client) instead",
    );
  });
});
