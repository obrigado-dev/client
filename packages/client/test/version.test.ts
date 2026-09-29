/**
 * `CLIENT_VERSION` and `package.json` must agree.
 *
 * The constant is a literal because `rootDir` is `src` and importing the manifest means
 * loosening the build to carry one string. That leaves two places to bump, so this closes
 * the gap the import would have closed — and closes it louder, because a mismatch fails a
 * named test rather than producing a plausible wrong number.
 *
 * The failure this prevents is quiet: the server believes a population is running a version
 * it is not, and every decision taken from that number — is it safe to change the contract,
 * which release started dropping impressions — is confidently wrong.
 */
import { describe, expect, test } from "bun:test";

import { CLIENT_VERSION } from "../src/version.ts";

describe("the version on the wire is the version we shipped", () => {
  test("CLIENT_VERSION matches package.json", async () => {
    const manifest = (await Bun.file(
      new URL("../package.json", import.meta.url).pathname,
    ).json()) as { version: string };

    expect(CLIENT_VERSION).toBe(manifest.version);
  });

  test("it fits the column that stores it", () => {
    // migration 0017: text, CHECK ~ '^[0-9A-Za-z.+-]{1,32}$'. A version the database refuses
    // would fail the session upsert, which is the request that serves the ad.
    expect(CLIENT_VERSION).toMatch(/^[0-9A-Za-z.+-]{1,32}$/u);
  });
});

/**
 * Every workspace's version in `bun.lock` must be its manifest's.
 *
 * `bun pm pack` rewrites `workspace:*` from the LOCKFILE's workspace versions, not from the
 * manifests, and `bun install` does not refresh them after `bun pm version`. So the first
 * pack after surface 0.2.0 pinned the OpenCode plugin to surface 0.1.0 — the release whose
 * parser drops the whole line when a developer turns the label off — and only reading the
 * tarball caught it. This fails the gate on the release commit instead, before a tag exists.
 */
describe("the lockfile agrees with the manifests", () => {
  test("every workspace package is locked at the version it declares", async () => {
    const root = new URL("../../../", import.meta.url).pathname;
    const lock = await Bun.file(`${root}bun.lock`).text();
    const paths = await Array.fromAsync(new Bun.Glob("packages/*/package.json").scan(root));
    const manifests = await Promise.all(
      paths.map(async (path) => ({
        dir: path.replace(/\/package\.json$/u, ""),
        version: ((await Bun.file(`${root}${path}`).json()) as { version?: string }).version,
      })),
    );

    const stale = manifests.flatMap(({ dir, version }) => {
      if (version === undefined) return [];
      const locked = new RegExp(
        `"${dir}": \\{\\s*"name": "[^"]+",\\s*"version": "([^"]+)"`,
        "u",
      ).exec(lock)?.[1];
      return locked === version ? [] : [`${dir}: package.json ${version}, bun.lock ${locked}`];
    });

    // Fix: set that entry's "version" in bun.lock by hand. `bun install` will not.
    expect(stale).toEqual([]);
  });
});
