/**
 * The line in the app across a conversation's end: `/clear` and `/resume` begin the next one in
 * the same process, where Claude Code raises no second `session.start`, so the refreshing must
 * outlive them. Only a session that really ends stops it.
 */
import { describe, expect, test } from "bun:test";

import { register } from "../hooks/register.ts";

type Hook = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

interface FakeTimer {
  readonly fn: () => void;
  readonly every: boolean;
  cancelled: boolean;
}

const timers: FakeTimer[] = [];
const added = (fn: () => void, every: boolean): { cancel(): void } => {
  const timer: FakeTimer = { fn, every, cancelled: false };
  timers.push(timer);
  return {
    cancel: () => {
      timer.cancelled = true;
    },
  };
};

/** What the renderer was asked for, one entry a render. */
const renders: string[] = [];

const mods = {
  clock: {
    now: () => Promise.resolve(Date.now()),
    after: (_ms: number, fn: () => void) => added(fn, false),
    every: (_ms: number, fn: () => void) => added(fn, true),
  },
  env: { get: () => Promise.resolve("obrigado statusline") },
  process: {
    run: (_argv: readonly string[], init: { readonly stdin: string }) => {
      renders.push(init.stdin);
      return Promise.resolve({ exitCode: 0, stdout: "" });
    },
  },
  session: {
    id: () => Promise.resolve("session-1"),
    cwd: () => Promise.resolve("/work"),
    surfaces: () => Promise.resolve(["desktop"]),
  },
  ui: { invalidate: () => {}, resolve: () => ({}) },
};

/** Runs what the clock has due: each one-off once, and each interval once, as a tick. */
async function tick(): Promise<void> {
  for (const timer of timers.filter((each) => !each.cancelled)) {
    if (!timer.every) timer.cancelled = true;
    timer.fn();
  }
  // The refresh is asynchronous: let it reach the renderer.
  await Bun.sleep(5);
}

const hooks = new Map<string, Hook>();
register(((event: string, matcherOrHook: unknown, hook?: unknown) => {
  hooks.set(event, (hook ?? matcherOrHook) as Hook);
}) as never);
const next = (e: unknown): Promise<unknown> => Promise.resolve(e);
const fire = async (event: string, e: unknown): Promise<void> => {
  await hooks.get(event)?.(mods, e, next);
};

describe("the line in the app", () => {
  test("goes on after /clear and /resume, and stops when the session ends", async () => {
    await fire("session.start", {});
    await tick();
    expect(renders.length).toBe(2);

    for (const reason of ["clear", "resume"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one conversation after another
      await fire("session.end", { reason });
      const before = renders.length;
      // oxlint-disable-next-line eslint/no-await-in-loop -- the same
      await tick();
      // The next conversation's first line at once, and the interval still ticking.
      expect(renders.length).toBe(before + 2);
    }

    await fire("session.end", { reason: "prompt_input_exit" });
    const ended = renders.length;
    await tick();
    expect(renders.length).toBe(ended);
  });
});
