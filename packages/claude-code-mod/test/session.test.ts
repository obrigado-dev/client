/**
 * The line in the app over a session. Nothing tells the mod whether the app's window is in front,
 * so a new line is drawn only when the session has done something since the last one, a prompt or
 * a model request, as a terminal's status line redraws on the conversation's events. `/clear` and
 * `/resume` begin the next conversation in the same process, where Claude Code raises no second
 * `session.start`, so the lines must go on past them; only a session that really ends stops them.
 */
import { describe, expect, test } from "bun:test";

import { register } from "../hooks/register.ts";

type Hook = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown;

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

/** Runs what the clock has due: each one-off once, and each interval once, as one beat. */
async function beat(): Promise<number> {
  const before = renders.length;
  for (const timer of timers.filter((each) => !each.cancelled)) {
    if (!timer.every) timer.cancelled = true;
    timer.fn();
  }
  // The refresh is asynchronous: let it reach the renderer.
  await Bun.sleep(5);
  return renders.length - before;
}

const hooks = new Map<string, Hook>();
register(((event: string, matcherOrHook: unknown, hook?: unknown) => {
  hooks.set(event, (hook ?? matcherOrHook) as Hook);
}) as never);
const fire = async (event: string, e: unknown = {}): Promise<void> => {
  await hooks.get(event)?.(mods, e, (passed) => Promise.resolve(passed));
};

/** One model request, through the streaming hook as the engine would run it. */
async function modelRequest(): Promise<void> {
  const step = hooks.get("turn.step")?.(mods, {}, () =>
    (async function* () {
      // An empty stream: only its passing through matters here.
    })(),
  ) as AsyncIterable<unknown>;
  // oxlint-disable-next-line eslint/no-unused-vars -- draining the stream is the point
  for await (const _ of step) {
    // Nothing to read.
  }
}

describe("the line in the app", () => {
  test("is drawn at once, then anew on the clock only after the session does something", async () => {
    await fire("session.start");
    expect(await beat()).toBe(1);
    // Idle, hidden or not: nothing more is drawn or counted.
    expect(await beat()).toBe(0);

    await fire("prompt.submit");
    expect(await beat()).toBe(1);
    await modelRequest();
    expect(await beat()).toBe(1);
    expect(await beat()).toBe(0);
  });

  test("goes on after /clear and /resume, and stops when the session ends", async () => {
    for (const reason of ["clear", "resume"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one conversation after another
      await fire("session.end", { reason });
      // The next conversation's first line at once.
      // oxlint-disable-next-line eslint/no-await-in-loop -- the same
      expect(await beat()).toBe(1);
      // oxlint-disable-next-line eslint/no-await-in-loop -- the same
      await fire("prompt.submit");
      // oxlint-disable-next-line eslint/no-await-in-loop -- the same
      expect(await beat()).toBe(1);
    }

    await fire("session.end", { reason: "prompt_input_exit" });
    await fire("prompt.submit");
    expect(await beat()).toBe(0);
  });
});
