/**
 * The newsletter, offered after a GitHub link (`newsletter-offer.ts`): once, at a terminal, about
 * the address the link brought back, starting on Yes, and a yes only asks for a confirmation email.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Key } from "../src/commands/choose.ts";

const BASE = { install_key: "test-key", api_origin: "http://api.test" };
let storedConfig: Record<string, unknown> = BASE;
let written: Array<Record<string, unknown>> = [];

const actualConfig = await import("../src/config.ts");
mock.module("../src/config.ts", () => ({
  ...actualConfig,
  readConfig: () => Promise.resolve(storedConfig),
  writeConfig: (config: Record<string, unknown>) => {
    written.push(config);
    storedConfig = config;
    return Promise.resolve();
  },
}));

const { newsletterQuestion, offerNewsletter } = await import("../src/commands/newsletter-offer.ts");

const flow = {
  config: BASE,
  origin: "http://api.test",
  options: { apiOrigin: "http://api.test", installKey: "test-key" },
};
const OFFER = { email: "ada@example.com", vouch: "1.v" };

let said: string[] = [];
let drawn: string[] = [];
let sent: Array<{ email: string; vouch: string }> = [];

/** The offer, with a person pressing `keys`, or nobody at a terminal when `prompt` is false. */
async function offer(
  keys: readonly Key[],
  {
    prompt = true,
    given = OFFER,
    answer = "confirm_sent",
  }: {
    readonly prompt?: boolean;
    readonly given?: { readonly email: string | undefined; readonly vouch: string | undefined };
    readonly answer?: "confirm_sent" | "subscribed" | null;
  } = {},
): Promise<void> {
  await offerNewsletter(flow, given, {
    prompt,
    io: {
      write: (text) => drawn.push(text),
      keys: (onKey) => {
        queueMicrotask(() => {
          for (const key of keys) onKey(key);
        });
        return () => {};
      },
    },
    say: (line) => said.push(line),
    send: (_flow, request) => {
      sent.push(request);
      return Promise.resolve(answer === null ? null : { status: answer });
    },
  });
}

beforeEach(() => {
  storedConfig = BASE;
  written = [];
  said = [];
  drawn = [];
  sent = [];
});

describe("after a GitHub link", () => {
  test("Enter takes the Yes it starts on, and asks for a confirmation email", async () => {
    await offer([{ name: "return" }]);

    expect(drawn[0]).toStartWith(newsletterQuestion("ada@example.com"));
    expect(drawn[0]).toContain("› Yes");
    expect(sent).toEqual([OFFER]);
    expect(said.at(-1)).toContain("Check ada@example.com for a link to confirm");
    expect(typeof written.at(-1)?.["newsletter_offered_at"]).toBe("string");
  });

  test("No sends nothing, and is not asked again", async () => {
    await offer([{ name: "down" }, { name: "return" }]);
    expect(sent).toEqual([]);
    drawn = [];

    await offer([{ name: "return" }]);
    expect(drawn).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("Ctrl-C is a no", async () => {
    await offer([{ name: "c", ctrl: true }]);
    expect(sent).toEqual([]);
  });

  test("is not asked without a terminal, or without an address", async () => {
    await offer([{ name: "return" }], { prompt: false });
    await offer([{ name: "return" }], { given: { email: undefined, vouch: undefined } });

    expect(drawn).toEqual([]);
    expect(written).toEqual([]);
  });

  test("says so when the address is already subscribed, or the server did not answer", async () => {
    await offer([{ name: "return" }], { answer: "subscribed" });
    expect(said.at(-1)).toContain("already subscribed");

    storedConfig = BASE;
    await offer([{ name: "return" }], { answer: null });
    expect(said.at(-1)).toContain("Couldn't sign you up");
  });
});
