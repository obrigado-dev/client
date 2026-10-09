/**
 * Which message the plugin reports as the person's latest prompt (`src/prompt.ts`): the newest
 * user message with text OpenCode did not write itself, never the text, and nothing at all from
 * an OpenCode without the state API.
 */
import { describe, expect, test } from "bun:test";

import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

import { lastTypedPrompt } from "../src/prompt.ts";

type Part = { type: string; synthetic?: boolean; ignored?: boolean; text?: string };
type Message = { id: string; role: "user" | "assistant"; time: { created: number } };

function api(messages: Message[], parts: Record<string, Part[]>): TuiPluginApi {
  return {
    state: {
      session: { messages: () => messages },
      part: (id: string) => parts[id] ?? [],
    },
  } as unknown as TuiPluginApi;
}

describe("the person's latest prompt", () => {
  test("is the newest user message with text the person wrote", () => {
    const found = lastTypedPrompt(
      api(
        [
          { id: "m1", role: "user", time: { created: 1_000 } },
          { id: "m2", role: "assistant", time: { created: 2_000 } },
          { id: "m3", role: "user", time: { created: 3_000 } },
        ],
        {
          m1: [{ type: "text", text: "fix the build" }],
          m3: [{ type: "text", text: "Summary of the session", synthetic: true }],
        },
      ),
      "s",
    );
    // m3 is OpenCode's own text, so the person's latest is m1; only its id and time come back.
    expect(found).toEqual({ id: "m1", at: 1_000 });
  });

  test("is nothing before the person has typed, or on an OpenCode without the state API", () => {
    expect(lastTypedPrompt(api([], {}), "s")).toBeNull();
    expect(lastTypedPrompt({} as TuiPluginApi, "s")).toBeNull();
  });
});
