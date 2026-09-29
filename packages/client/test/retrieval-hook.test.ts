/**
 * The retrieval hook, driven the way Claude Code drives it (§14 Phase 6).
 *
 * The config `obrigado read --print-hook` used to print passed `"$CLAUDE_TOOL_INPUT_FILE_PATH"`,
 * a variable Claude Code has never set: a command hook gets its input as JSON on stdin. Every
 * unit underneath was correct and no read was ever recorded. So these run the PRINTED command,
 * through a shell, with the payload Claude Code sends — the one level at which that was visible.
 * A scratch `HOME` keeps them away from the developer's own queue, as in `label-off.test.ts`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { pathOfHookInput } from "../src/retrieval.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

let home: string;

function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "CLAUDE_TOOL_INPUT_FILE_PATH") env[key] = value;
  }
  // Makes the printed command run this checkout rather than whatever `obrigado` is on PATH.
  return {
    ...env,
    HOME: home,
    OBRIGADO_STATUSLINE_COMMAND: `${process.execPath} ${CLI} statusline`,
  };
}

/** A `PostToolUse` payload in the shape Claude Code sends, trimmed to the fields that vary. */
function payload(toolName: string, toolInput: Record<string, string>): string {
  return JSON.stringify({
    session_id: "s-1",
    cwd: home,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_1",
  });
}

async function printedCommand(): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI, "read", "--print-hook"], {
    stdout: "pipe",
    env: childEnvironment(),
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const lines = out.split("\n");
  const start = lines.indexOf("  {");
  const end = lines.indexOf("  }", start);
  const config = JSON.parse(lines.slice(start, end + 1).join("\n")) as {
    hooks: { PostToolUse: [{ hooks: [{ command: string }] }] };
  };
  return config.hooks.PostToolUse[0].hooks[0].command;
}

async function runHook(
  command: string,
  stdin: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: childEnvironment(),
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

const queued = (): Promise<string> =>
  readFile(join(home, ".obrigado", "retrieval.jsonl"), "utf8").catch(() => "");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "obrigado-hook-"));
  await mkdir(join(home, ".obrigado"), { recursive: true });
  await writeFile(
    join(home, ".obrigado", "config.json"),
    JSON.stringify({ install_key: "k".repeat(32), api_origin: "http://localhost:9" }),
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("the printed hook", () => {
  test("records a package the agent read, silently", async () => {
    const read = payload("Read", {
      file_path: join(home, "app", "node_modules", "react", "index.js"),
    });

    const { code, out, err } = await runHook(await printedCommand(), read);

    // A nonzero exit, or stderr alongside one, is a "hook error" notice in the transcript.
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toBe("");
    expect(await queued()).toBe(`${JSON.stringify({ p: "npm:react" })}\n`);
  });

  test("the config it used to print records too, without pasting again", async () => {
    // What a developer with `obrigado` on PATH was told to paste, pointed at this checkout.
    const legacy = `${process.execPath} ${CLI} read "$CLAUDE_TOOL_INPUT_FILE_PATH"`;
    const read = payload("Read", { file_path: join(home, "node_modules", "zod", "index.js") });

    await runHook(legacy, read);

    expect(await queued()).toBe(`${JSON.stringify({ p: "npm:zod" })}\n`);
  });
});

describe("the hook's input", () => {
  test("names the file for Read and Edit, and the search root for Grep", () => {
    expect(pathOfHookInput(payload("Read", { file_path: "/a/node_modules/x/i.js" }))).toBe(
      "/a/node_modules/x/i.js",
    );
    expect(pathOfHookInput(payload("Edit", { file_path: "/a/b.ts", old_string: "x" }))).toBe(
      "/a/b.ts",
    );
    expect(pathOfHookInput(payload("Grep", { pattern: "x", path: "/a/node_modules/y" }))).toBe(
      "/a/node_modules/y",
    );
  });

  test("anything without a path is nothing, never an error", () => {
    expect(pathOfHookInput(payload("Grep", { pattern: "x" }))).toBeNull();
    expect(pathOfHookInput("")).toBeNull();
    expect(pathOfHookInput("not json")).toBeNull();
    expect(pathOfHookInput("null")).toBeNull();
    expect(pathOfHookInput(JSON.stringify({ tool_input: { file_path: 7 } }))).toBeNull();
  });
});
