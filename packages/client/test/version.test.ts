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

import { AGENTS, CLIENT_VERSION, DEFAULT_AGENT, isAgent } from "../src/version.ts";

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

describe("which host a build targets", () => {
  test("the default is a member of the closed set", () => {
    expect(AGENTS).toContain(DEFAULT_AGENT);
  });

  test("the set is closed, because it is a rollup key", () => {
    // A typo splits one agent's traffic into two populations no query joins back together.
    expect(isAgent("claude-code")).toBe(true);
    expect(isAgent("codex")).toBe(true);
    expect(isAgent("Claude-Code")).toBe(false);
    expect(isAgent("claude_code")).toBe(false);
    // oxlint-disable-next-line unicorn/no-useless-undefined -- passing undefined IS the case under test; the autofix strips it and the call stops compiling
    expect(isAgent(undefined)).toBe(false);
  });

  test("the agents the spec names are all present", () => {
    // §2: "Claude Code, Codex, Cursor, Gemini CLI". Adding a client later should be adding
    // an installer, not discovering the enum was never extended.
    const named: readonly string[] = ["claude-code", "codex", "cursor", "gemini-cli"];
    for (const agent of named) {
      expect(AGENTS as readonly string[]).toContain(agent);
    }
  });
});
