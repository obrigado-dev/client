/**
 * The extension, driven the way Pi drives it.
 *
 * Pi's own API is stood in for rather than imported: the host is a separate program, and a test
 * that imported it would be testing pi-mono. What is asserted here is the contract this file was
 * written against — the three calls it makes, and the conditions under which it declines to make
 * them — with a stub CLI standing in for `obrigado statusline`.
 */
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import extension from "../src/obrigado.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function harness(): {
  handlers: Map<string, Handler>;
  api: { on: (e: string, h: Handler) => void };
} {
  const handlers = new Map<string, Handler>();
  return { handlers, api: { on: (event, handler) => void handlers.set(event, handler) } };
}

interface Recorded {
  readonly statuses: [string, string | undefined][];
}

function context(hasUI: boolean, recorded: Recorded): unknown {
  return {
    hasUI,
    cwd: "/tmp/project",
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        recorded.statuses.push([key, text]);
      },
    },
  };
}

/** A stand-in for the CLI: echoes one line, and reports the environment it was handed. */
async function stubCli(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "obrigado-stub-"));
  const path = join(dir, "stub.sh");
  await writeFile(path, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

let recorded: Recorded;

/*
 * `OBRIGADO_STATUSLINE_COMMAND` is read by the Claude Code installer too, and it returns the
 * override verbatim as the command it writes into settings. Leaking a stub path out of this file
 * made `statusline.test.ts` install a command it then failed to recognise as its own — so the
 * variable is restored rather than merely overwritten.
 */
const ORIGINAL_COMMAND = process.env["OBRIGADO_STATUSLINE_COMMAND"];

beforeEach(() => {
  recorded = { statuses: [] };
});

afterEach(() => {
  if (ORIGINAL_COMMAND === undefined) delete process.env["OBRIGADO_STATUSLINE_COMMAND"];
  else process.env["OBRIGADO_STATUSLINE_COMMAND"] = ORIGINAL_COMMAND;
});

describe("the footer entry", () => {
  test("sets the line the CLI printed, under a stable key", async () => {
    const cli = await stubCli(`printf 'sponsored \\xc2\\xb7 Neon\\n'`);
    process.env["OBRIGADO_STATUSLINE_COMMAND"] = cli;
    const { handlers, api } = harness();
    extension(api);

    await handlers.get("session_start")?.({}, context(true, recorded));

    expect(recorded.statuses).toEqual([["obrigado", "sponsored · Neon"]]);
  });

  /*
   * Print mode, JSON mode and subagents have no footer. Declining to even ASK is what keeps
   * those runs from counting as impressions: the CLI reports one when it renders, so a render
   * nobody could see would be a billed impression nobody saw.
   */
  test("asks for nothing when the host has no UI", async () => {
    const cli = await stubCli(`printf 'sponsored \\xc2\\xb7 Neon\\n'; touch "$0.ran"`);
    process.env["OBRIGADO_STATUSLINE_COMMAND"] = cli;
    const { handlers, api } = harness();
    extension(api);

    await handlers.get("session_start")?.({}, context(false, recorded));

    expect(recorded.statuses).toEqual([]);
    expect(await Bun.file(`${cli}.ran`).exists()).toBe(false);
  });

  /*
   * Pi's footer truncator drops trailing ANSI, so an OSC 8 hyperlink opened before the cut is
   * never closed and the advertiser's URL bleeds onto whatever is drawn next. The renderer's
   * documented override is how this surface refuses to emit them at all.
   */
  test("runs the renderer with hyperlinks turned off", async () => {
    const cli = await stubCli(`printf 'hyperlinks=%s\\n' "$OBRIGADO_HYPERLINKS"`);
    process.env["OBRIGADO_STATUSLINE_COMMAND"] = cli;
    const { handlers, api } = harness();
    extension(api);

    await handlers.get("session_start")?.({}, context(true, recorded));

    expect(recorded.statuses).toEqual([["obrigado", "hyperlinks=0"]]);
  });

  test("leaves the footer alone when the CLI prints nothing", async () => {
    process.env["OBRIGADO_STATUSLINE_COMMAND"] = await stubCli("true");
    const { handlers, api } = harness();
    extension(api);

    await handlers.get("session_start")?.({}, context(true, recorded));

    expect(recorded.statuses).toEqual([]);
  });

  test("leaves the footer alone when the CLI is not there at all", async () => {
    process.env["OBRIGADO_STATUSLINE_COMMAND"] = "/nonexistent/obrigado";
    const { handlers, api } = harness();
    extension(api);

    await handlers.get("session_start")?.({}, context(true, recorded));

    expect(recorded.statuses).toEqual([]);
  });

  test("clears its entry on shutdown", async () => {
    const { handlers, api } = harness();
    extension(api);

    await handlers.get("session_shutdown")?.({}, context(true, recorded));

    expect(recorded.statuses).toEqual([["obrigado", undefined]]);
  });

  test("refreshes on every turn, not only at session start", async () => {
    process.env["OBRIGADO_STATUSLINE_COMMAND"] = await stubCli(`printf 'sponsored\\n'`);
    const { handlers, api } = harness();
    extension(api);

    await handlers.get("turn_end")?.({}, context(true, recorded));

    expect(recorded.statuses).toEqual([["obrigado", "sponsored"]]);
  });
});
