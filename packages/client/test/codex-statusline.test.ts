import { describe, expect, test } from "bun:test";

import {
  CODEX_TRACKING_ISSUE,
  CodexUnsupportedError,
  codexConfigBlock,
  codexStatusLineCommand,
  codexSupport,
  installCodexStatusLine,
} from "../src/codex-statusline.ts";
import { agentFromArgv } from "../src/commands/statusline.ts";

describe("install refuses while the surface does not exist", () => {
  test("rejects rather than degrading to a worse surface", async () => {
    await expect(installCodexStatusLine()).rejects.toBeInstanceOf(CodexUnsupportedError);
  });

  test("the refusal names the blocker, so nobody has to guess", async () => {
    const message = await installCodexStatusLine().catch((error: unknown) =>
      error instanceof Error ? error.message : "",
    );
    expect(message).toContain(CODEX_TRACKING_ISSUE);
    // A developer running a patched build should be able to act on the refusal
    // itself rather than go reading source.
    expect(message).toContain("[tui.status_line_command]");
  });

  test("support is reported from one place", () => {
    expect(codexSupport().supported).toBe(false);
    expect(codexSupport().issue).toBe(CODEX_TRACKING_ISSUE);
  });
});

describe("the config we will write", () => {
  test("adds the sponsored item without evicting Codex's own fields", () => {
    const block = codexConfigBlock("obrigado statusline --agent codex");
    expect(block).toContain('status_line = ["model-with-reasoning"');
    expect(block).toContain('"custom"');
    // Model, context, and directory are the developer's operational readout, not
    // inventory to displace.
    expect(block).toContain("context-remaining");
    expect(block).toContain("current-dir");
  });

  test("quotes the command, so a path with spaces survives TOML", () => {
    const block = codexConfigBlock(
      "/Applications/My Tools/bun /src/cli.ts statusline --agent codex",
    );
    expect(block).toContain(
      'command = "/Applications/My Tools/bun /src/cli.ts statusline --agent codex"',
    );
  });

  test("the installed command attributes impressions to Codex", () => {
    expect(codexStatusLineCommand()).toContain("statusline");
    expect(codexStatusLineCommand()).toContain("--agent codex");
  });

  test("and the renderer reads that flag back", () => {
    expect(agentFromArgv(["--agent", "codex"])).toBe("codex");
    expect(agentFromArgv(["--agent=codex"])).toBe("codex");
    // Every existing install runs the flagless command; it must keep meaning Claude.
    expect(agentFromArgv([])).toBe("claude-code");
    expect(agentFromArgv(["--agent", "nonsense"])).toBe("claude-code");
  });
});
