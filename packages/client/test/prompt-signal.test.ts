/**
 * The prompt signal (`prompt-signal.ts`): a new `prompt_id` is noticed once, its age is what
 * travels, and the id itself is never kept or sent as it is.
 */
import { describe, expect, test } from "bun:test";

import {
  activityFromPayload,
  inputAgeSeconds,
  inSessionFromPayload,
  promptFromActivity,
  promptFromPayload,
  seenPrompt,
} from "../src/prompt-signal.ts";

const PROMPT_ID = "2b4f9c1e-3a7d-4e8b-9f10-6c5d4e3b2a19";
const payload = (fields: Record<string, unknown>): string => JSON.stringify(fields);

describe("the prompt a payload names", () => {
  test("is kept as a digest, never as the id", () => {
    const key = promptFromPayload(payload({ prompt_id: PROMPT_ID, cost: {} }))?.key;
    expect(key).toMatch(/^[0-9a-f]{16}$/u);
    expect(key).not.toContain(PROMPT_ID.slice(0, 8));
    expect(promptFromPayload(payload({ prompt_id: PROMPT_ID }))?.key).toBe(key);
  });

  test("carries when it was sent, where the host says", () => {
    expect(promptFromPayload(payload({ prompt_id: PROMPT_ID, prompt_at: 1_000 }))?.at).toBe(1_000);
    expect(
      promptFromPayload(payload({ prompt_id: PROMPT_ID, prompt_at: "soon" })),
    ).not.toHaveProperty("at");
  });

  test("is nothing when the payload names none", () => {
    expect(promptFromPayload("")).toBeNull();
    expect(promptFromPayload("not json")).toBeNull();
    expect(promptFromPayload(payload({ session_id: "s" }))).toBeNull();
    expect(promptFromPayload(payload({ prompt_id: "" }))).toBeNull();
  });
});

describe("a prompt seen across renders", () => {
  test("is dated by the render that first saw it, and keeps that date after", () => {
    const first = seenPrompt(undefined, { key: "aaaa" }, 1_000);
    expect(first).toEqual({ id: "aaaa", seen_at: 1_000 });
    expect(seenPrompt(first, { key: "aaaa" }, 90_000)).toBe(first);
    expect(seenPrompt(first, { key: "bbbb" }, 90_000)).toEqual({ id: "bbbb", seen_at: 90_000 });
  });

  test("is dated when the host says it was sent, but never in the future", () => {
    expect(seenPrompt(undefined, { key: "aaaa", at: 40_000 }, 90_000)?.seen_at).toBe(40_000);
    expect(seenPrompt(undefined, { key: "aaaa", at: 99_000 }, 90_000)?.seen_at).toBe(90_000);
  });

  test("is unchanged by a render whose payload names none", () => {
    const first = seenPrompt(undefined, { key: "aaaa" }, 1_000);
    expect(seenPrompt(first, null, 90_000)).toBe(first);
    expect(seenPrompt(undefined, null, 90_000)).toBeUndefined();
  });

  test("has an age in whole seconds, and none before any prompt", () => {
    expect(inputAgeSeconds(undefined, 5_000)).toBeUndefined();
    expect(inputAgeSeconds({ id: "aaaa", seen_at: 1_000 }, 62_999)).toBe(61);
    // A clock that went backwards reads as just now, never a negative age.
    expect(inputAgeSeconds({ id: "aaaa", seen_at: 9_000 }, 1_000)).toBe(0);
  });
});

/*
 * Antigravity CLI names no prompt (A47). What it reports instead is read across two renders: the
 * agent starting a turn, a tool-approval dialog being answered, or a message queued behind the
 * running turn is a person acting, dated by the render that saw the change.
 */
describe("a prompt read from what the agent is doing", () => {
  const NOW = 1_800_000_000_000;

  test("keeps the three fields the host reports, and nothing else", () => {
    expect(
      activityFromPayload(
        payload({
          agent_state: "thinking",
          tool_confirmation_pending: false,
          pending_input_count: 2,
          conversation_title: "fix the ledger",
        }),
      ),
    ).toEqual({ state: "thinking", confirming: false, queued: 2 });
    expect(activityFromPayload(payload({ session_id: "s" }))).toBeNull();
    // Left out when false or zero, as Antigravity CLI 1.4.2 sends an idle session.
    expect(activityFromPayload(payload({ agent_state: "idle" }))).toEqual({
      state: "idle",
      confirming: false,
      queued: 0,
    });
    expect(activityFromPayload(payload({ pending_input_count: -1 }))).toBeNull();
    expect(activityFromPayload("not json")).toBeNull();
  });

  test("is a turn starting: idle, then working", () => {
    for (const state of ["thinking", "working", "tool_use"]) {
      expect(promptFromActivity({ state: "idle" }, { state }, NOW)).toEqual({
        key: `activity-${NOW}`,
        at: NOW,
      });
    }
  });

  test("is not the turn going on, ending, or the agent starting up", () => {
    expect(promptFromActivity({ state: "thinking" }, { state: "tool_use" }, NOW)).toBeNull();
    expect(promptFromActivity({ state: "working" }, { state: "idle" }, NOW)).toBeNull();
    expect(promptFromActivity({ state: "initializing" }, { state: "idle" }, NOW)).toBeNull();
    expect(promptFromActivity({ state: "idle" }, { state: "idle" }, NOW)).toBeNull();
  });

  test("is a tool-approval dialog answered, which only a person does", () => {
    const answered = promptFromActivity(
      { state: "tool_use", confirming: true },
      { state: "tool_use", confirming: false },
      NOW,
    );
    expect(answered?.at).toBe(NOW);
    expect(promptFromActivity({ confirming: false }, { confirming: true }, NOW)).toBeNull();
    // The dialog's field disappearing, as the host sends it, is the same answer.
    const closed = activityFromPayload(payload({ agent_state: "tool_use" }));
    expect(promptFromActivity({ state: "tool_use", confirming: true }, closed, NOW)?.at).toBe(NOW);
  });

  test("is a message typed while the agent works, but not the queue draining", () => {
    expect(promptFromActivity({ queued: 0 }, { queued: 1 }, NOW)?.at).toBe(NOW);
    expect(promptFromActivity({}, { queued: 1 }, NOW)?.at).toBe(NOW);
    expect(promptFromActivity({ queued: 2 }, { queued: 1 }, NOW)).toBeNull();
  });

  /* A turn already running when first seen began at a moment this render does not know. */
  test("is nothing on the session's first render, with nothing to compare", () => {
    expect(promptFromActivity(undefined, { state: "thinking", queued: 3 }, NOW)).toBeNull();
  });

  test("is a new prompt every time, so each act is dated by its own render", () => {
    const first = seenPrompt(
      undefined,
      promptFromActivity({ state: "idle" }, { state: "thinking" }, NOW),
      NOW,
    );
    const later = NOW + 90_000;
    const second = seenPrompt(
      first,
      promptFromActivity({ state: "idle" }, { state: "working" }, later),
      later,
    );
    expect(second?.seen_at).toBe(later);
  });
});

/* Antigravity CLI draws its status line on its sign-in screen too, with no session behind it. */
describe("whether the host is in a session", () => {
  test("is not, while it signs in or starts up", () => {
    expect(inSessionFromPayload(payload({ agent_state: "authenticating", session_id: "" }))).toBe(
      false,
    );
    expect(inSessionFromPayload(payload({ agent_state: "initializing" }))).toBe(false);
  });

  test("is, once its agent is idle or working", () => {
    for (const agent_state of ["idle", "thinking", "working", "tool_use"]) {
      expect(inSessionFromPayload(payload({ agent_state }))).toBe(true);
    }
  });

  test("is, for a host that reports no state, as every host was before", () => {
    expect(inSessionFromPayload(payload({ session_id: "s", prompt_id: PROMPT_ID }))).toBe(true);
    expect(inSessionFromPayload("")).toBe(true);
    expect(inSessionFromPayload("not json")).toBe(true);
  });
});
