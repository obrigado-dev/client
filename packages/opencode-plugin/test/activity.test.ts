/**
 * When the line is drawn again (`src/activity.ts`): only after something happened in the session,
 * the agent at work or its messages changed, so an OpenCode left open and idle keeps the line it has
 * and counts nothing more. OpenCode 1 and 2 report a session differently; each has a reader.
 */
import { describe, expect, test } from "bun:test";

import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

import { drawsAgain, sessionActivity, sessionActivity2, STILL } from "../src/activity.ts";
import type { OpenCode2Context } from "../src/opencode2.ts";

function api(messages: Array<{ id: string }>, status: { type: string } | undefined): TuiPluginApi {
  return {
    state: { session: { messages: () => messages, status: () => status } },
  } as unknown as TuiPluginApi;
}

function context(messages: Array<{ id: string }>, status: "idle" | "running"): OpenCode2Context {
  return {
    data: { session: { status: () => status, message: { list: () => messages } } },
  } as unknown as OpenCode2Context;
}

describe("what a session is doing", () => {
  test("OpenCode 1: working while busy or retrying, and a mark that moves with its messages", () => {
    expect(sessionActivity(api([{ id: "m1" }], { type: "busy" }), "s")).toEqual({
      working: true,
      mark: "1:m1",
    });
    expect(sessionActivity(api([{ id: "m1" }, { id: "m2" }], { type: "idle" }), "s")).toEqual({
      working: false,
      mark: "2:m2",
    });
    expect(sessionActivity(api([], { type: "retry" }), "s").working).toBe(true);
    // An OpenCode without the state API: nothing to read, so nothing drawn again.
    expect(sessionActivity({} as TuiPluginApi, "s")).toEqual(STILL);
  });

  test("OpenCode 2: the same, from its own data API", () => {
    expect(sessionActivity2(context([{ id: "m1" }], "running"), "s")).toEqual({
      working: true,
      mark: "1:m1",
    });
    expect(sessionActivity2(context([{ id: "m1" }], "idle"), "s").working).toBe(false);
    expect(sessionActivity2({} as OpenCode2Context, "s")).toEqual(STILL);
  });
});

describe("the next line", () => {
  test("is drawn first, then only once something happened", () => {
    expect(drawsAgain(null, "s|1:m1", false)).toBe(true);
    // Idle and unchanged: the line stays, and nothing more is counted.
    expect(drawsAgain("s|1:m1", "s|1:m1", false)).toBe(false);
    // A message typed or a reply, another session, or the agent at work.
    expect(drawsAgain("s|1:m1", "s|2:m2", false)).toBe(true);
    expect(drawsAgain("s|1:m1", "t|1:m9", false)).toBe(true);
    expect(drawsAgain("s|1:m1", "s|1:m1", true)).toBe(true);
  });
});
