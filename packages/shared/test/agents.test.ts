/**
 * The agent table is now the single source for four lists that used to be maintained by hand.
 *
 * That is a strict improvement only if the table itself cannot go quietly wrong. Most of the
 * ways it can are not type errors: an `inherits` pointing at a host that was removed, a fork
 * that grew a surface of its own, a row whose id no longer matches the wire. Those are checked
 * here, along with the four derived views, so that a change to the table which breaks one of
 * its consumers fails in this file rather than on the consumer's page.
 */
import { describe, expect, test } from "bun:test";

import {
  AGENT_IDS,
  AGENTS,
  EDITOR_AGENT_IDS,
  INSTALLABLE_AGENTS,
  isAgentId,
  SURFACED_AGENTS,
  surfaceLabel,
} from "../src/agents.ts";

describe("the table", () => {
  test("has no duplicate ids, which would split a rollup key against itself", () => {
    expect(new Set(AGENT_IDS).size).toBe(AGENT_IDS.length);
  });

  test("names every host it knows about", () => {
    expect([...AGENT_IDS]).toEqual([
      "claude-code",
      "codex",
      "opencode",
      "vscode",
      "cursor",
      "gemini-cli",
    ]);
  });

  test("gives every agent a label a reader would recognise", () => {
    for (const agent of AGENTS) {
      expect(agent.label.length).toBeGreaterThan(0);
    }
  });

  /*
   * A fork inherits a surface; it does not have one. Both at once would put the same extension
   * on the landing page twice, under two names, as though they were separate integrations.
   */
  test("never lets an agent both inherit a surface and declare one", () => {
    for (const agent of AGENTS) {
      if (agent.inherits !== null) expect(agent.surface).toBeNull();
    }
  });

  test("only inherits from hosts that exist", () => {
    for (const agent of AGENTS) {
      if (agent.inherits !== null) expect(AGENT_IDS).toContain(agent.inherits);
    }
  });

  test("never has an agent inherit from itself", () => {
    for (const agent of AGENTS) {
      expect(agent.inherits).not.toBe(agent.id);
    }
  });
});

describe("the derived views", () => {
  /*
   * `installs: "cli"` means this client owns the installer, not that installing succeeds:
   * codex is accepted by `--agent` precisely so it can be refused with the reason.
   */
  test("installable is what `obrigado install --agent` accepts", () => {
    expect(INSTALLABLE_AGENTS.map((agent) => agent.id)).toEqual([
      "claude-code",
      "codex",
      "opencode",
    ]);
  });

  test("surfaced is what the landing page can honestly demo", () => {
    expect(SURFACED_AGENTS.map((agent) => agent.id)).toEqual(["claude-code", "opencode", "vscode"]);
  });

  /* A19: none of Codex's reachable surfaces is persistent and host-owned. */
  test("excludes codex and gemini-cli from the surfaced view", () => {
    const ids = SURFACED_AGENTS.map((agent) => agent.id) as readonly string[];

    expect(ids).not.toContain("codex");
    expect(ids).not.toContain("gemini-cli");
  });

  test("editors are the hosts polled as editors", () => {
    expect([...EDITOR_AGENT_IDS]).toEqual(["vscode", "cursor"]);
  });

  test("every surfaced agent actually carries the sentence the demo prints", () => {
    for (const agent of SURFACED_AGENTS) {
      expect(agent.surface.length).toBeGreaterThan(20);
    }
  });
});

describe("surfaceLabel", () => {
  test("composes a shared surface from the hosts that share it", () => {
    expect(surfaceLabel("vscode")).toBe("VS Code / Cursor");
  });

  test("leaves a host that owns its surface alone", () => {
    expect(surfaceLabel("claude-code")).toBe("Claude Code");
    expect(surfaceLabel("opencode")).toBe("OpenCode");
  });
});

describe("isAgentId", () => {
  test("accepts every id in the table", () => {
    for (const id of AGENT_IDS) {
      expect(isAgentId(id)).toBe(true);
    }
  });

  /*
   * It guards a value arriving over the wire, which is arbitrary text until it is checked.
   *
   * The unsupported-host sample is deliberately not the name of a real editor. It was "zed"
   * until adding Zed became a plausible contribution, at which point this test would have
   * failed for someone whose change was entirely correct — a rejection sample has to be a
   * name nobody will ever legitimately add.
   */
  test("rejects anything else", () => {
    for (const value of ["", "Claude-Code", "vscode ", "not-a-real-host", null, undefined, 7, {}]) {
      expect(isAgentId(value)).toBe(false);
    }
  });
});
