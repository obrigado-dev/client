import { describe, expect, test } from "bun:test";

import { positionFromArgv, resolveClaudeState } from "../src/commands/claude-state.ts";
import { requestedAgent } from "../src/commands/install.ts";

describe("agent targeting", () => {
  test("plain install leaves selection to detection", () => {
    expect(requestedAgent([])).toBeNull();
  });

  test("supports both flag forms", () => {
    expect(requestedAgent(["--agent", "codex"])).toBe("codex");
    expect(requestedAgent(["--agent=claude-code"])).toBe("claude-code");
  });

  test("rejects hosts without an implemented adapter", () => {
    expect(() => requestedAgent(["--agent", "cursor"])).toThrow(/Unsupported agent/u);
  });
});

/*
 * Self-repair for installs that already carry a bad chain.
 *
 * Before the recognition boundaries were widened, a status line that nested our command as a
 * quoted inner argument read as the developer's own, so install recorded OUR command as the
 * thing to run first. Those configs exist on disk. Re-running install has to drop such an
 * entry rather than carry it forward, or the loop outlives the fix that closed it.
 */
describe("repairing a chained command that turned out to be ours", () => {
  const selfReferential =
    "RUNCOMMAND_BASE='/bin/bun /x/packages/client/src/cli.ts statusline' runcommand statusline";

  test("drops a recorded chain that names us, even without --chain", () => {
    const state = resolveClaudeState(
      { installed: true, chained_command: selfReferential },
      null,
      false,
    );

    expect(state.chainedCommand).toBeUndefined();
  });

  test("keeps a chain that is genuinely the developer's", () => {
    const state = resolveClaudeState(
      { installed: true, chained_command: "runcommand statusline" },
      null,
      false,
    );

    expect(state.chainedCommand).toBe("runcommand statusline");
  });
});

describe("choosing which row the sponsored line takes", () => {
  test("defaults to below, which is where every existing install already renders", () => {
    expect(positionFromArgv([], null)).toBe("below");
  });

  test("takes the flag when one is given", () => {
    expect(positionFromArgv(["--above"], null)).toBe("above");
    expect(positionFromArgv(["--below"], null)).toBe("below");
  });

  /*
   * Sticky across a re-install. `obrigado install` is what a developer runs to pick up a new
   * version, and doing so must not quietly move a line they deliberately placed.
   */
  test("keeps the previous choice when neither flag is given", () => {
    expect(positionFromArgv([], { installed: true, sponsored_position: "above" })).toBe("above");
  });

  test("an explicit --below overrides a stored above", () => {
    expect(positionFromArgv(["--below"], { installed: true, sponsored_position: "above" })).toBe(
      "below",
    );
  });
});
