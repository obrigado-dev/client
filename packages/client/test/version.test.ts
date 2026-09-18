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
