/**
 * The GitHub link, offered at the end of `obrigado install` (`link-offer.ts`).
 *
 * Asked once, only of a person at a terminal, and taken only on an explicit yes: the same rules
 * the targeting questions keep, for the same reasons.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const INSTALLED = {
  install_key: "test-key",
  api_origin: "http://api.test",
  integrations: { "claude-code": { installed: true } },
};
let storedConfig: Record<string, unknown> | null = INSTALLED;
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

const { LINK_LATER, LINK_QUESTION, offerGitHubLink } =
  await import("../src/commands/link-offer.ts");

let asked: string[] = [];
let said: string[] = [];
let linked = 0;

/** The offer with a person who answers `answer`, or none at a terminal when `prompt` is false. */
async function offer(answer: string | null, prompt = true): Promise<void> {
  await offerGitHubLink([], {
    prompt,
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(answer);
    },
    say: (line) => said.push(line),
    run: () => {
      linked += 1;
      return Promise.resolve(0);
    },
  });
}

beforeEach(() => {
  storedConfig = INSTALLED;
  written = [];
  asked = [];
  said = [];
  linked = 0;
});

describe("at the end of an install", () => {
  test("a yes links GitHub, and the offer is recorded", async () => {
    await offer("y");

    expect(asked).toEqual([LINK_QUESTION]);
    expect(linked).toBe(1);
    expect(typeof written.at(-1)?.["link_offered_at"]).toBe("string");
  });

  test("a bare enter is a no: nothing is linked, and it says how to later", async () => {
    await offer("");

    expect(linked).toBe(0);
    expect(said).toContain(LINK_LATER);
    expect(typeof written.at(-1)?.["link_offered_at"]).toBe("string");
  });

  test("an input that ended is a no as well", async () => {
    await offer(null);

    expect(linked).toBe(0);
    expect(said).toContain(LINK_LATER);
  });

  test("is asked once: a reinstall after any answer says nothing", async () => {
    await offer("n");
    asked = [];
    said = [];

    await offer("y");

    expect(asked).toEqual([]);
    expect(said).toEqual([]);
    expect(linked).toBe(0);
  });

  test("is not offered to an install signed in with GitHub already", async () => {
    storedConfig = {
      ...INSTALLED,
      developer_session: { token: "t", login: "ada", expires_at: "2027-10-16T00:00:00Z" },
    };

    await offer("y");

    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });

  test("without a terminal is a line, not a question, and is not recorded", async () => {
    await offer("y", false);

    expect(asked).toEqual([]);
    expect(said).toEqual([LINK_LATER]);
    expect(linked).toBe(0);
    expect(written).toEqual([]);
  });

  test("is not offered when nothing was installed", async () => {
    storedConfig = { install_key: "test-key", api_origin: "http://api.test" };

    await offer("y");

    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });
});
