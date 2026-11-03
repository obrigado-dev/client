/**
 * The monthly summary (`summary-offer.ts`, A54): asked only at a terminal, starting on No, with
 * the server's question sent back verbatim on a yes; `obrigado link summary off` stops it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { LinkedEmailWire, LinkSummaryRequest } from "@obrigado/shared";

import type { Key } from "../src/commands/choose.ts";
import { offerSummary, summaryCommand } from "../src/commands/summary-offer.ts";

const flow = {
  config: { install_key: "test-key", api_origin: "http://api.test" },
  origin: "http://api.test",
  options: { apiOrigin: "http://api.test", installKey: "test-key" },
};
const OFFER =
  "Email ada@example.com a monthly summary of what your installs contributed to open source?\n" +
  "From Obrigado (Principle Stash Inc, 1 Example St, obrigado.dev). Unsubscribe any time.";

const entry = (overrides: Partial<LinkedEmailWire> = {}): LinkedEmailWire => ({
  email: "ada@example.com",
  entity_kind: "individual",
  verified: true,
  listed: false,
  pending_review: false,
  qualified_this_period: false,
  monthly_summary: false,
  summary_offer: OFFER,
  ...overrides,
});

let said: string[] = [];
let drawn: string[] = [];
let sent: LinkSummaryRequest[] = [];

const deps = (keys: readonly Key[], prompt = true) => ({
  prompt,
  io: {
    write: (text: string) => drawn.push(text),
    keys: (onKey: (key: Key) => void) => {
      queueMicrotask(() => {
        for (const key of keys) onKey(key);
      });
      return () => {};
    },
  },
  say: (line: string) => said.push(line),
  send: (_options: unknown, request: LinkSummaryRequest) => {
    sent.push(request);
    return Promise.resolve({ ok: true as const, data: { monthly_summary: request.on } });
  },
});

const ENTER: Key = { name: "return" };
const UP: Key = { name: "up" };

beforeEach(() => {
  said = [];
  drawn = [];
  sent = [];
});

describe("after a verified link", () => {
  test("Enter takes the No it starts on, and nothing is sent", async () => {
    await offerSummary(flow, entry(), deps([ENTER]));
    expect(drawn[0]).toContain(OFFER);
    expect(sent).toEqual([]);
    expect(said.join("\n")).toContain("No monthly summary.");
  });

  test("a yes sends the question exactly as it was shown", async () => {
    await offerSummary(flow, entry(), deps([UP, ENTER]));
    expect(sent).toEqual([{ email: "ada@example.com", on: true, asked: OFFER }]);
    expect(said.join("\n")).toContain("Monthly summary on for ada@example.com.");
  });

  test("away from a terminal it says how to ask, and asks nothing", async () => {
    await offerSummary(flow, entry(), deps([], false));
    expect(drawn).toEqual([]);
    expect(said.join("\n")).toContain("obrigado link summary");
  });

  test("nothing when the server offers nothing, or it is on already", async () => {
    const { summary_offer: _none, ...withoutOffer } = entry();
    await offerSummary(flow, withoutOffer, deps([UP, ENTER]));
    await offerSummary(flow, entry({ monthly_summary: true }), deps([UP, ENTER]));
    expect(drawn).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe("obrigado link summary", () => {
  const realFetch = globalThis.fetch;
  let emails: LinkedEmailWire[] = [];

  beforeEach(() => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ period: "2026-11-01", emails, github: [] }),
      )) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("off stops it for every address that has it", async () => {
    emails = [
      entry({ monthly_summary: true, summary_offer: undefined }),
      entry({ email: "b@x.dev" }),
    ];
    expect(await summaryCommand(flow, ["off"], deps([]))).toBe(0);
    expect(sent).toEqual([{ email: "ada@example.com", on: false }]);
  });

  test("asks for each address it can be offered for", async () => {
    emails = [entry()];
    expect(await summaryCommand(flow, [], deps([UP, ENTER]))).toBe(0);
    expect(sent).toEqual([{ email: "ada@example.com", on: true, asked: OFFER }]);
  });

  test("with no verified email, says to link one", async () => {
    emails = [entry({ verified: false })];
    expect(await summaryCommand(flow, [], deps([]))).toBe(1);
    expect(said.join("\n")).toContain("--no-list");
  });
});
