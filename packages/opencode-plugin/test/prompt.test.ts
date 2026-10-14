/**
 * Which message the plugin reports as the person's latest prompt (`src/prompt.ts`): the newest
 * user message with text OpenCode did not write itself, never the text, and nothing at all from
 * an OpenCode without the state API. OpenCode 1 and 2 keep messages differently, so each has a
 * reader of its own and the same rules.
 */
import { describe, expect, test } from "bun:test";

import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

import type { OpenCode2Context, OpenCode2Message } from "../src/opencode2.ts";
import { lastTypedPrompt, lastUserMessage } from "../src/prompt.ts";

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

function context(messages: Record<string, OpenCode2Message[]>): OpenCode2Context {
  return {
    data: { session: { message: { list: (id: string) => messages[id] ?? [] } } },
  } as unknown as OpenCode2Context;
}

describe("the person's latest prompt, from OpenCode 2", () => {
  test("is the newest message the person sent, whatever OpenCode wrote after it", () => {
    const found = lastUserMessage(
      context({
        s: [
          { id: "m1", type: "user", time: { created: 1_000 } },
          { id: "m2", type: "assistant", time: { created: 2_000 } },
          { id: "m3", type: "user", time: { created: 3_000 } },
          // OpenCode's own text is a message type of its own in 2, never a flagged `user` one, and
          // a shell run is not typed text, as OpenCode 1's synthetic-only shell message was not.
          { id: "m4", type: "synthetic", time: { created: 4_000 } },
          { id: "m5", type: "shell", time: { created: 5_000 } },
        ],
        other: [{ id: "o1", type: "user", time: { created: 9_000 } }],
      }),
      "s",
    );
    expect(found).toEqual({ id: "m3", at: 3_000 });
  });

  test("is nothing before the person has sent one, or from a data API this was not written for", () => {
    expect(lastUserMessage(context({}), "s")).toBeNull();
    expect(
      lastUserMessage(context({ s: [{ id: "m1", type: "synthetic", time: { created: 1 } }] }), "s"),
    ).toBeNull();
    expect(lastUserMessage({} as OpenCode2Context, "s")).toBeNull();
  });
});
