import { describe, expect, test } from "bun:test";

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
