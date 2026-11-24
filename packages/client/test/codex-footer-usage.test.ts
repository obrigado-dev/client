/**
 * The counting items of Codex's footer (`codex-footer-usage.ts`, `codex-footer-format.ts`): the
 * context window, tokens, credits, dollars and rate limits, written as Codex 0.171.0 writes them.
 *
 * Codex shows none of these without a model, so nothing here was captured from the running
 * program. The expectations are upstream's own where it has a test for the case (named beside
 * each), and otherwise worked out from its source at `rust-v0.171.0`.
 */
import { describe, expect, test } from "bun:test";

import {
  compactTokens,
  creditMicros,
  fixed,
  microsOf,
  usdMicros,
  windowLabel,
} from "../src/codex-footer-format.ts";
import { redrawFooter } from "../src/codex-footer.ts";
import type { FooterMachine } from "../src/codex-footer.ts";
import type { UiNode } from "../src/codex-tree.ts";

const MACHINE: FooterMachine = {
  home: "/Users/dev",
  hostname: null,
  readFile: () => null,
  exists: () => false,
  now: 0,
};

function leafOf(node: UiNode): string {
  return typeof node === "string" ? node : node.children.map((child) => leafOf(child)).join("");
}

/** The footer for some items of a thread with the given usage and rate-limit windows. */
function footer(
  items: readonly string[],
  parts: { readonly usage?: unknown; readonly primary?: unknown; readonly secondary?: unknown },
): string {
  const state = {
    account: {
      rate_limits: [
        {
          limit_id: "codex",
          limit_name: null,
          primary_limit: parts.primary ?? null,
          secondary_limit: parts.secondary ?? null,
        },
      ],
    },
    config: { statusline_items: items },
    thread: { usage: parts.usage ?? { context: {} } },
  };
  const tree = redrawFooter(state, MACHINE, { useColors: false });
  return tree === null ? "" : leafOf(tree).replaceAll("·", " · ");
}

const window = (usedPercent: number, minutes: number | null): unknown => ({
  used_percent: usedPercent,
  window_minutes: minutes,
  resets_at: null,
});

/** What is left of a context window Codex says is this much used. */
function leftAt(used: number): string {
  return footer(["context-remaining"], {
    usage: { context: { context_window_size: 1_000, used_percentage: used } },
  });
}

/** A thread's usage with the given token totals, as Codex breaks them down. */
function totals(input: number, cached: number, output: number): unknown {
  return {
    context: { context_window_size: 272_000, used_percentage: 5 },
    total: {
      total_input_tokens: input,
      cache_read_input_tokens: cached,
      cache_write_input_tokens: 0,
      other_input_tokens: input - cached,
      output_tokens: output,
    },
  };
}

const HOUR = 60;
const DAY = 24 * HOUR;

describe("a number to fixed decimals, as Rust writes one", () => {
  test("takes a tie to the even digit, where toFixed takes it up", () => {
    expect([fixed(0.5, 0), fixed(1.5, 0), fixed(2.5, 0), fixed(62.5, 0)]).toEqual([
      "0",
      "2",
      "2",
      "62",
    ]);
    expect(fixed(1.125, 2)).toBe("1.12");
    expect(fixed(1.375, 2)).toBe("1.38");
  });

  test("rounds from the double's exact value, not its shortest spelling", () => {
    // 1.005 is stored a little under, 1.015 a little under, 8.345 a little over.
    expect([fixed(1.005, 2), fixed(1.015, 2), fixed(8.345, 2)]).toEqual(["1.00", "1.01", "8.35"]);
    expect([fixed(0, 0), fixed(100, 0), fixed(99.5, 0), fixed(0.049, 1)]).toEqual([
      "0",
      "100",
      "100",
      "0.0",
    ]);
  });
});

describe("a token count", () => {
  test("is whole under a thousand", () => {
    expect([compactTokens(-5), compactTokens(0), compactTokens(999)]).toEqual(["0", "0", "999"]);
  });

  test("has three significant digits above, without trailing zeros", () => {
    expect(
      [1_000, 1_234, 12_345, 123_456, 272_000, 13_700, 950_000].map((n) => compactTokens(n)),
    ).toEqual(["1K", "1.23K", "12.3K", "123K", "272K", "13.7K", "950K"]);
    // "950K window" and "13.7K used / 272K" are upstream's own expectations.
  });

  test("moves to the next unit where it would round to a thousand of this one", () => {
    expect(
      [999_499, 999_500, 1_234_567, 999_500_000, 2_500_000_000_000].map((n) => compactTokens(n)),
    ).toEqual(["999K", "1M", "1.23M", "1B", "2.5T"]);
  });

  test("rounds 9,995 and 99,950 the way the double falls", () => {
    expect([compactTokens(9_995), compactTokens(99_950)]).toEqual(["9.99K", "100K"]);
    expect(compactTokens(1_125)).toBe("1.12K");
  });
});

describe("credits and dollars", () => {
  test("credits round to one decimal place (upstream's test)", () => {
    const cases: readonly (readonly [bigint, string])[] = [
      [0n, "0"],
      [400_000n, "0.4"],
      [5_200_000n, "5.2"],
      [5_240_000n, "5.2"],
      [5_250_000n, "5.3"],
      [46_000_000n, "46"],
      [1_240_000_000n, "1.2K"],
      [12_400_000_000n, "12.4K"],
    ];
    for (const [micros, written] of cases) expect(creditMicros(micros)).toBe(written);
  });

  test("dollars are to the cent, and finer under a cent", () => {
    expect(
      [0n, 99n, 150n, 9_999n, 10_000n, 214_300n, 1_234_567_890n].map((micros) => usdMicros(micros)),
    ).toEqual(["~$0.00", "~$0.000099", "~$0.0002", "~$0.0100", "~$0.01", "~$0.21", "~$1234.57"]);
  });

  test("micros come back from the units the snapshot carries", () => {
    expect([microsOf(5.2), microsOf(0.2143), microsOf(0.000_001), microsOf(0)]).toEqual([
      5_200_000n,
      214_300n,
      1n,
      0n,
    ]);
    expect([microsOf(-1), microsOf(Number.NaN), microsOf(1e300)]).toEqual([null, null, null]);
  });

  test("are drawn as upstream's test has them, and left out without a cost", () => {
    const usage = { context: {}, cost: { total_cost_usd: 0.21, total_credits: 5.2 } };
    expect(footer(["thread-credits", "estimated-thread-cost"], { usage })).toBe(
      "5.2 credits · ~$0.21",
    );
    expect(footer(["thread-credits", "estimated-thread-cost"], {})).toBe("");
    expect(
      footer(["thread-credits", "estimated-thread-cost"], {
        usage: { context: {}, cost: { total_credits: 46 } },
      }),
    ).toBe("46 credits");
  });
});

describe("the context window", () => {
  const CONTEXT = ["context-remaining", "context-used", "context-window-size"];

  test("is all free before Codex knows its size", () => {
    expect(footer(CONTEXT, { usage: { context: {} } })).toBe("Context 100% left · Context 0% used");
  });

  test("is what is left of the share Codex says is used", () => {
    const usage = {
      context: { context_window_size: 950_000, used_tokens: 400, used_percentage: 37 },
    };
    expect(footer(CONTEXT, { usage })).toBe("Context 63% left · Context 37% used · 950K window");
  });

  test("is blank while the thread's counts are still on their way", () => {
    // A window size with no percentage is how the snapshot shows Codex waiting.
    const usage = { context: { context_window_size: 272_000 } };
    expect(footer([...CONTEXT, "total-input-tokens", "total-output-tokens"], { usage })).toBe(
      "272K window",
    );
  });

  test("keeps a percentage inside 0 to 100", () => {
    expect([leftAt(140), leftAt(-3)]).toEqual(["Context 0% left", "Context 100% left"]);
  });
});

describe("the thread's tokens", () => {
  const TOKENS = ["used-tokens", "total-input-tokens", "total-output-tokens"];

  test("count input that was not cached, plus output, as used", () => {
    expect(footer(TOKENS, { usage: totals(1_234_567, 1_000_000, 45_678) })).toBe(
      "280K used · 1.23M in · 45.7K out",
    );
  });

  test("are zero in and out before the first report, and no tokens used is left out", () => {
    expect(footer(TOKENS, { usage: { context: {} } })).toBe("0 in · 0 out");
    expect(footer(TOKENS, { usage: totals(0, 0, 0) })).toBe("0 in · 0 out");
    expect(footer(TOKENS, { usage: totals(500, 500, 0) })).toBe("500 in · 0 out");
  });
});

describe("a rate limit's window", () => {
  const LIMITS = ["five-hour-limit", "weekly-limit"];

  test("is named by its length, within 5%", () => {
    expect(
      [5 * HOUR, 299, 316, DAY, 7 * DAY, 30 * DAY, 365 * DAY, 2 * HOUR, -1].map((minutes) =>
        windowLabel(minutes),
      ),
    ).toEqual(["5h", "5h", null, "daily", "weekly", "monthly", "annual", null, null]);
    expect(windowLabel(null)).toBeNull();
  });

  test("shows what is left, a tie rounding to even", () => {
    expect(
      footer(LIMITS, { primary: window(37.5, 5 * HOUR), secondary: window(12, 7 * DAY) }),
    ).toBe("5h 62% left · weekly 88% left");
    expect(footer(["five-hour-limit"], { primary: window(130, 5 * HOUR) })).toBe("5h 0% left");
  });

  test("uses the second window's fallback name for a length with none (upstream's test)", () => {
    expect(footer(["weekly-limit"], { secondary: window(50, 2 * HOUR) })).toBe(
      "secondary usage 50% left",
    );
    expect(footer(["five-hour-limit"], { primary: window(50, null) })).toBe("usage 50% left");
  });

  test("prefers the window that matches the item, whichever slot it is in (upstream's test)", () => {
    expect(footer(LIMITS, { primary: window(94, 7 * DAY), secondary: window(40, 5 * HOUR) })).toBe(
      "5h 60% left · weekly 6% left",
    );
  });

  test("shows a monthly second window where the first is weekly (upstream's test)", () => {
    expect(footer(LIMITS, { primary: window(94, 7 * DAY), secondary: window(35, 30 * DAY) })).toBe(
      "monthly 65% left · weekly 6% left",
    );
  });

  test("leaves the five-hour item out of a weekly-only limit (upstream's test)", () => {
    expect(footer(LIMITS, { primary: window(9, 7 * DAY) })).toBe("weekly 91% left");
  });

  test("leaves the weekly item out of a single monthly window (upstream's test)", () => {
    expect(footer(LIMITS, { primary: window(35, 30 * DAY) })).toBe("monthly 65% left");
  });

  test("gives a lone second window to the weekly item only (upstream's test)", () => {
    expect(footer(LIMITS, { secondary: window(35, 30 * DAY) })).toBe("monthly 65% left");
    expect(footer(["five-hour-limit"], { secondary: window(35, 30 * DAY) })).toBe("");
  });

  test("reads only the codex limit, and nothing without one", () => {
    const state = {
      account: { rate_limits: [{ limit_id: "other", primary_limit: window(10, 5 * HOUR) }] },
      config: { statusline_items: LIMITS },
    };
    expect(redrawFooter(state, MACHINE, { useColors: false })).toBeNull();
  });
});
