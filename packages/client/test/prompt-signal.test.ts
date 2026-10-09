/**
 * The prompt signal (`prompt-signal.ts`): a new `prompt_id` is noticed once, its age is what
 * travels, and the id itself is never kept or sent as it is.
 */
import { describe, expect, test } from "bun:test";

import { inputAgeSeconds, promptFromPayload, seenPrompt } from "../src/prompt-signal.ts";

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
