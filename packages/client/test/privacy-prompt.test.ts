/**
 * The install-time targeting questions.
 *
 * Two things worth guarding, and both are about consent rather than formatting.
 *
 * **Only an explicit yes turns anything on.** A newline, a typo, a stray line arriving from a
 * pipe: all of them are no. The asymmetry is the point — misreading a yes as no costs one
 * `obrigado privacy region on`, and misreading a no as yes targets somebody who did not agree.
 *
 * **The JSON shown is the JSON sent.** The screen's whole claim is that it is not a summary, so
 * these assert the previewed fragment against what `collectSignals` actually builds — including
 * the case that matters most, where activity is off and the `retrieved` key is absent rather
 * than empty.
 */
import { describe, expect, test } from "bun:test";

import { collectSignals } from "../src/api.ts";
import { wrapAt } from "../src/commands/privacy.ts";
import {
  canAsk,
  NOTHING_SHARED,
  parseAnswer,
  requestPreview,
  runTargetingSetup,
} from "../src/commands/privacy-prompt.ts";
import type { Ask } from "../src/commands/privacy-prompt.ts";

/** Answers in order, then nothing — a stream that ends is how Ctrl-D and a closed pipe arrive. */
function answering(...lines: readonly string[]): { ask: Ask; asked: string[] } {
  const asked: string[] = [];
  let next = 0;
  return {
    asked,
    ask: (question) => {
      asked.push(question);
      const line = lines[next++];
      return Promise.resolve(line ?? null);
    },
  };
}

function collector(): { say: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { say: (line) => lines.push(line), text: () => lines.join("\n") };
}

describe("parseAnswer", () => {
  test("only an explicit yes is a yes", () => {
    for (const yes of ["y", "Y", "yes", "YES", " y ", "Yes\r"]) expect(parseAnswer(yes)).toBe(true);
  });

  test("everything else is no, including what it cannot read", () => {
    for (const no of ["", "\n", "n", "no", "ys", "yeah", "1", "true", "sure"]) {
      expect(parseAnswer(no)).toBe(false);
    }
  });

  test("a closed stream is not an answer", () => {
    expect(parseAnswer(null)).toBeNull();
  });
});

describe("runTargetingSetup", () => {
  test("asks the three, in the order privacy lists them", async () => {
    const { ask, asked } = answering("n", "n", "n", "n");
    const sharing = await runTargetingSetup(ask, [], () => {});

    expect(asked).toEqual([
      "  Allow packages? [y/N] ",
      "  Allow region? [y/N] ",
      "  Allow network? [y/N] ",
      "  Allow activity? [y/N] ",
    ]);
    expect(sharing).toEqual(NOTHING_SHARED);
  });

  test("records exactly the ones answered yes", async () => {
    const { ask } = answering("y", "y", "", "yes");
    expect(await runTargetingSetup(ask, [], () => {})).toEqual({
      packages: true,
      region: true,
      network: false,
      activity: true,
    });
  });

  test("a stream that ends mid-run records nothing at all", async () => {
    const { ask } = answering("y", "y");
    expect(await runTargetingSetup(ask, [], () => {})).toBeNull();
  });

  test("asks, and nothing more: the JSON comes once, afterwards", async () => {
    const { ask } = answering("y", "n", "n", "n");
    const out = collector();
    await runTargetingSetup(ask, [], out.say);

    // Redrawn after every answer, this printed four drafts of a choice the developer had not
    // finished making, and read as output rather than a question.
    expect(out.text()).not.toContain('"sharing"');
  });

  test("says so when activity would share an empty queue", async () => {
    const { ask } = answering("n", "n", "n", "n");
    const out = collector();
    await runTargetingSetup(ask, [], out.say);

    expect(out.text()).toContain("Nothing queued yet");
  });
});

/** The fragment on screen, against the request the client would really build. */
function sentFor(sharing: typeof NOTHING_SHARED, retrieved: readonly string[]): string {
  const signals = collectSignals({ agent: "claude-code", sharing, retrieved });
  return JSON.stringify({ sharing: signals.sharing, retrieved: signals.retrieved });
}

describe("requestPreview", () => {
  test("matches what collectSignals builds, key for key", () => {
    const sharing = { packages: true, region: true, network: false, activity: true };
    const retrieved = ["npm:zod", "npm:hono"];
    const preview = requestPreview(sharing, retrieved);

    // The fragment is real JSON, and it is the fragment the request carries.
    expect(JSON.parse(`{${preview}}`)).toEqual({ signals: { sharing, retrieved } });
    expect(sentFor(sharing, retrieved)).toBe(JSON.stringify({ sharing, retrieved }));
  });

  test("activity off drops the retrieved key, and the screen shows it dropped", () => {
    const sharing = { packages: true, region: true, network: true, activity: false };
    const preview = requestPreview(sharing, ["npm:zod"]);

    expect(preview).not.toContain("retrieved");
    expect(
      collectSignals({ agent: "claude-code", sharing, retrieved: ["npm:zod"] }).retrieved,
    ).toBeUndefined();
  });

  test("a long queue is elided, and says how much it elided", () => {
    const ids = Array.from({ length: 40 }, (_, index) => `npm:package-${index}`);
    const preview = requestPreview(
      { packages: false, region: false, network: false, activity: true },
      ids,
    );

    expect(preview).toContain('"npm:package-5"');
    expect(preview).not.toContain('"npm:package-6"');
    expect(preview).toContain("6 of 40 shown.");
  });
});

describe("canAsk", () => {
  test("--no-input is a no even with a terminal attached", () => {
    expect(canAsk(["--no-input"])).toBe(false);
  });

  test("no terminal, no questions — install runs in scripts", () => {
    // bun test detaches stdin, so this is the piped/provisioned case exactly.
    expect(canAsk([])).toBe(false);
  });
});

describe("wrapAt", () => {
  test("keeps every line inside the width, indent included", () => {
    const text =
      "Advertisers can target the packages your agent has been reading lately, and nothing else.";
    for (const line of wrapAt(text, "       ")) expect(line.length).toBeLessThanOrEqual(78);
  });

  test("loses no words and adds none", () => {
    const text = "Nothing is stored. Your address is compared during the request and discarded.";
    expect(wrapAt(text, "    ").join("\n").replaceAll(/\s+/gu, " ").trim()).toBe(text);
  });

  test("a word longer than the room gets its own line rather than being cut", () => {
    const lines = wrapAt(
      "short https://example.com/an-extremely-long-url-that-cannot-be-broken end",
      "  ",
      30,
    );
    expect(lines.join(" ")).toContain(
      "https://example.com/an-extremely-long-url-that-cannot-be-broken",
    );
  });
});
