import { describe, expect, test } from "bun:test";

import { CHAIN_MARKER, chainArgv, isChainedRender, runChained } from "../src/chain.ts";
import type { ChainMachine } from "../src/chain.ts";

const PAYLOAD = JSON.stringify({
  session_id: "abc",
  workspace: { current_dir: "/Users/dev/project" },
  model: { display_name: "Opus 5" },
});

describe("runChained", () => {
  test("returns the chained command's stdout", async () => {
    expect(await runChained("printf 'my status line'", PAYLOAD)).toBe("my status line");
  });

  test("forwards the same stdin payload Claude Code sent", async () => {
    // The chained command must see exactly what it would have seen if Claude
    // Code had invoked it directly — many statuslines read cwd from stdin.
    const command = `input=$(cat); echo "$input" | sed -n 's/.*"current_dir":"\\([^"]*\\)".*/\\1/p'`;
    expect(await runChained(command, PAYLOAD)).toBe("/Users/dev/project");
  });

  test("strips trailing newlines but keeps internal ones", async () => {
    expect(await runChained("printf 'line one\\nline two\\n\\n'", PAYLOAD)).toBe(
      "line one\nline two",
    );
  });

  test("returns null when the command fails", async () => {
    // A broken statusline should cost the developer their own line, never fill
    // their terminal with our error output.
    expect(await runChained("exit 1", PAYLOAD)).toBeNull();
    expect(await runChained("this-command-does-not-exist-anywhere", PAYLOAD)).toBeNull();
  });

  test("returns null for a command that prints nothing", async () => {
    expect(await runChained("true", PAYLOAD)).toBeNull();
  });

  test("does not leak stderr into the status line", async () => {
    expect(await runChained("printf 'ok'; echo 'noise' >&2", PAYLOAD)).toBe("ok");
  });

  test("REFUSES to invoke our own command", async () => {
    // Chaining our own command forks once per render, forever. Re-running
    // install is enough to put it in the config, so the hot path guards too.
    expect(await runChained("obrigado statusline", PAYLOAD)).toBeNull();
    expect(
      await runChained(
        "/opt/homebrew/bin/bun /repo/obrigado/packages/client/src/cli.ts statusline",
        PAYLOAD,
      ),
    ).toBeNull();
  });

  test("kills a command that hangs, rather than stalling the status line", async () => {
    const started = Bun.nanoseconds();
    const result = await runChained("sleep 30 & wait", PAYLOAD);
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(4_000);
  });
});

/*
 * The string guard in `runChained` catches a command that NAMES us. These are the routes it
 * cannot see, and the reason the marker exists: a checkout in a directory not called
 * "obrigado", and a launcher that reads the program it wraps from its own config rather than
 * from the command line. Both reached us in a real install and duplicated the line.
 */
describe("re-entrancy, for a chain that comes back around", () => {
  test("marks the environment of the command it runs", async () => {
    const output = await runChained(`printf '%s' "$${CHAIN_MARKER}"`, "{}");

    expect(output).toBe("1");
  });

  test("recognises a nested render", () => {
    expect(isChainedRender({ [CHAIN_MARKER]: "1" })).toBe(true);
    expect(isChainedRender({})).toBe(false);
    expect(isChainedRender({ [CHAIN_MARKER]: "0" })).toBe(false);
  });

  /* The whole point: a command naming a path that never says "obrigado" still terminates. */
  test("a chained command under a differently named path still gets the marker", async () => {
    const output = await runChained(
      `printf '%s' "$${CHAIN_MARKER}" # /Users/someone/Code/obliged-dev/packages/client/src/cli.ts`,
      "{}",
    );

    expect(output).toBe("1");
  });
});

/** A Windows machine with these files, these programs on PATH and this environment. */
function windows(files: readonly string[], onPath: Record<string, string> = {}, env = {}) {
  const machine: ChainMachine = {
    platform: "win32",
    env,
    which: (program) => onPath[program] ?? null,
    exists: (path) => files.includes(path),
  };
  return machine;
}

/**
 * Windows (A46): Claude Code runs a status line through Git Bash when it finds one and PowerShell
 * when it does not, so the developer's own runs in whichever of the two ran it before.
 */
describe("the shell a chained command runs in", () => {
  test("is sh everywhere but Windows", () => {
    expect(chainArgv("my-line", { ...windows([]), platform: "linux" })).toEqual([
      "sh",
      "-c",
      "my-line",
    ]);
  });

  test("is Git Bash where Git installs it", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";

    expect(chainArgv("my-line", windows([bash]))).toEqual([bash, "-c", "my-line"]);
  });

  test("is the Git Bash Claude Code was pointed at, first", () => {
    const pointed = "D:\\tools\\git\\bin\\bash.exe";
    const machine = windows(
      [pointed, "C:\\Program Files\\Git\\bin\\bash.exe"],
      {},
      {
        CLAUDE_CODE_GIT_BASH_PATH: pointed,
      },
    );

    expect(chainArgv("my-line", machine)[0]).toBe(pointed);
  });

  test("is the Git Bash beside the git on PATH", () => {
    const bash = "D:\\Git\\bin\\bash.exe";
    const machine = windows([bash], { git: "D:\\Git\\cmd\\git.exe" });

    expect(chainArgv("my-line", machine)[0]).toBe(bash);
  });

  test("is PowerShell, with Claude Code's flags, where there is no Git Bash", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

    expect(chainArgv("my-line", windows([], { pwsh }))).toEqual([
      pwsh,
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "my-line",
    ]);
  });

  test("is Windows PowerShell where it is the only one", () => {
    expect(chainArgv("my-line", windows([], {}, { SystemRoot: "C:\\Windows" }))[0]).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});
