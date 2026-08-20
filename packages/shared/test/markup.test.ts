import { describe, expect, test } from "bun:test";

import {
  lineClasses,
  spanClasses,
  withDefaultLink,
  MAX_EMPHASIS_CHARS,
  MAX_EMPHASIS_RATIO,
  MAX_HIGHLIGHT_LENGTH,
  MAX_VISIBLE_LENGTH,
  parseMarkup,
  plainText,
} from "../src/markup.ts";

const ok = (source: string) => {
  const result = parseMarkup(source);
  expect(result.problems).toEqual([]);
  return result;
};

describe("plain copy", () => {
  test("passes through as one span", () => {
    const { spans, plain } = ok("Postgres, but you never think about it");
    expect(spans).toEqual([{ text: "Postgres, but you never think about it" }]);
    expect(plain).toBe("Postgres, but you never think about it");
  });

  test("em dashes, emoji and punctuation are not markup", () => {
    const { plain } = ok("Ship faster 🚀 — 100% coverage, £0 setup");
    expect(plain).toBe("Ship faster 🚀 — 100% coverage, £0 setup");
  });
});

describe("emphasis", () => {
  test("bold applies to a run", () => {
    const { spans } = ok("try **neon** today");
    expect(spans).toEqual([{ text: "try " }, { text: "neon", bold: true }, { text: " today" }]);
  });

  test("italic applies to a run", () => {
    const { spans } = ok("try _neon_ today");
    expect(spans[1]).toEqual({ text: "neon", italic: true });
  });

  test("highlight applies to a run", () => {
    const { spans } = ok("try `neon` today");
    expect(spans[1]).toEqual({ text: "neon", highlight: true });
  });

  test("styles nest", () => {
    const { spans } = ok("a **_b_** c");
    expect(spans[1]).toEqual({ text: "b", bold: true, italic: true });
  });

  test("individual letters can be styled", () => {
    const { spans } = ok("**n**eon");
    expect(spans[0]).toEqual({ text: "n", bold: true });
    expect(spans[1]).toEqual({ text: "eon" });
  });
});

describe("colour", () => {
  test("colours a run from the palette", () => {
    const { spans } = ok("{cyan:Type-safe} SQL");
    expect(spans[0]).toEqual({ text: "Type-safe", color: "cyan" });
    expect(spans[1]).toEqual({ text: " SQL" });
  });

  test("rejects a colour outside the palette", () => {
    // Red and yellow mean error and warning in a terminal.
    for (const name of ["red", "yellow", "white"]) {
      const { problems } = parseMarkup(`{${name}:danger} ahead`);
      expect(problems.join(" ")).toContain("not an available colour");
    }
  });

  test("a brace that is not a colour marker is literal text", () => {
    const { plain } = ok("use {} for an empty object");
    expect(plain).toBe("use {} for an empty object");
  });
});

describe("the single tracking link", () => {
  test("marks a run as the link", () => {
    const { spans } = ok("Postgres — [neon.tech]");
    expect(spans[1]).toEqual({ text: "neon.tech", link: true });
  });

  test("a link can carry other styles", () => {
    const { spans } = ok("[**neon.tech**]");
    expect(spans[0]).toEqual({ text: "neon.tech", bold: true, link: true });
  });

  test("REFUSES a second link", () => {
    // /c/:token issues one token per impression, so two links would make
    // "which part was clicked" unanswerable.
    const { problems } = parseMarkup("[one] and [two]");
    expect(problems.join(" ")).toContain("only one link is allowed");
  });

  test("an unmatched closing bracket is literal", () => {
    const { plain } = ok("array] notation");
    expect(plain).toBe("array] notation");
  });
});

describe("§3 prominence, as arithmetic", () => {
  test("refuses bold covering a whole LONG line", () => {
    const { problems } = parseMarkup(
      `**${"everything is bold here and then some more".slice(0, 42)}**`,
    );
    expect(problems.join(" ")).toContain("at most");
  });

  test("allows a short brand-only creative to be fully emphasised", () => {
    // Nine bold characters do not drown a nine-character `sponsored` label, so
    // the cap is proportional OR absolute, whichever is more permissive.
    const { spans, problems } = parseMarkup("[**neon.tech**]");
    expect(problems).toEqual([]);
    expect(spans[0]).toEqual({ text: "neon.tech", bold: true, link: true });
  });

  test("refuses emphasis beyond the cap on a long line", () => {
    const { problems } = parseMarkup(`**${"a".repeat(40)}**${"b".repeat(20)}`);
    expect(problems.join(" ")).toContain("at most");
  });

  test("allows emphasis within the cap", () => {
    const { spans } = ok("Postgres, but you never think about it — **neon**");
    expect(spans.some((s) => s.bold === true)).toBe(true);
  });

  test("italic is not capped — it differentiates rather than amplifies", () => {
    // Italic distinguishes the sponsored line from the developer's own status
    // text, which helps the disclosure; bold competes with it.
    const { problems } = parseMarkup("_the whole line in italic is fine_");
    expect(problems).toEqual([]);
  });

  test("caps highlight length so it cannot become a banner", () => {
    const long = "x".repeat(MAX_HIGHLIGHT_LENGTH + 1);
    const { problems } = parseMarkup(`\`${long}\`${"y".repeat(60)}`);
    expect(problems.join(" ")).toContain("at most");
  });

  test("the caps are the documented ones", () => {
    expect(MAX_EMPHASIS_RATIO).toBe(0.5);
    expect(MAX_EMPHASIS_CHARS).toBe(16);
  });
});

describe("length is measured in VISIBLE characters", () => {
  test("markup does not count toward the budget", () => {
    // 80 visible characters plus markers would fail a naive raw-length check.
    const visible = "a".repeat(MAX_VISIBLE_LENGTH - 4);
    const { problems, plain } = parseMarkup(`**abcd**${visible}`);
    expect([...plain].length).toBe(MAX_VISIBLE_LENGTH);
    expect(problems.join(" ")).not.toContain("visible characters");
  });

  test("rejects copy over the visible budget", () => {
    const { problems } = parseMarkup("a".repeat(MAX_VISIBLE_LENGTH + 1));
    expect(problems.join(" ")).toContain("status line budget");
  });
});

describe("robustness", () => {
  test("reports unclosed markup rather than guessing", () => {
    expect(parseMarkup("**never closed").problems.join(" ")).toContain("unclosed");
    expect(parseMarkup("[dangling").problems.join(" ")).toContain("unclosed");
  });

  test("escapes emit a literal marker", () => {
    const { plain } = ok("2 \\* 3 and \\[brackets\\]");
    expect(plain).toBe("2 * 3 and [brackets]");
  });

  test("control characters are reported, not passed through", () => {
    const result = parseMarkup("a[2Kb");
    expect(result.problems.join(" ")).toContain("control characters");
    expect(result.plain).not.toContain("");
  });

  test("never throws on adversarial input", () => {
    for (const source of [
      "",
      "*",
      "**",
      "***",
      "[",
      "]",
      "[]",
      "{",
      "}",
      "{cyan:",
      "`",
      "\\",
      "**_`[{cyan:",
      "]]]]]",
      "a".repeat(500),
      "**".repeat(100),
    ]) {
      expect(() => parseMarkup(source)).not.toThrow();
    }
  });
});

describe("plainText", () => {
  test("strips markup for length checks and accessible fallbacks", () => {
    expect(plainText("{cyan:Type-safe} SQL for `TS` — [**kysely.dev**]")).toBe(
      "Type-safe SQL for TS — kysely.dev",
    );
  });
});

describe("withDefaultLink — [...] narrows, it does not enable", () => {
  test("plain copy with no marker becomes entirely clickable", () => {
    // The regression this guards: once markup existed, plain copy parsed to a
    // single span with no `link` flag, so an ad with a click_url rendered with
    // nothing clickable at all. Before markup, plain copy was fully clickable.
    const { spans } = parseMarkup("NEON DA BEST~~~");
    expect(spans.some((span) => span.link === true)).toBe(false);

    const linked = withDefaultLink(spans);
    expect(linked).toEqual([{ text: "NEON DA BEST~~~", link: true }]);
  });

  test("every run becomes clickable, styling preserved", () => {
    const { spans } = parseMarkup("{cyan:Type-safe} SQL for **TS**");
    const linked = withDefaultLink(spans);

    expect(linked.every((span) => span.link === true)).toBe(true);
    expect(linked[0]).toMatchObject({ text: "Type-safe", color: "cyan" });
    expect(linked.at(-1)).toMatchObject({ text: "TS", bold: true });
  });

  test("an explicit marker is left exactly as authored", () => {
    const { spans } = parseMarkup("Postgres — [neon.tech]");
    const linked = withDefaultLink(spans);

    expect(linked[0]).toEqual({ text: "Postgres — " });
    expect(linked[1]).toEqual({ text: "neon.tech", link: true });
    // Narrowed, not widened.
    expect(linked.filter((span) => span.link === true)).toHaveLength(1);
  });

  test("empty input stays empty", () => {
    expect(withDefaultLink([])).toEqual([]);
  });
});

describe("shared preview classes", () => {
  test("maps span markup to the shared CSS vocabulary", () => {
    expect(spanClasses({ text: "copy", bold: true, italic: true, color: "cyan" })).toBe(
      "is-bold is-italic slot-cyan",
    );
    expect(spanClasses({ text: "copy", highlight: true })).toBe("is-highlight");
    expect(spanClasses({ text: "copy" })).toBe("");
  });

  test("maps creative-wide style and effect without no-op classes", () => {
    expect(lineClasses("magenta", "italic")).toBe("slot-magenta is-italic");
    expect(lineClasses("default", "none")).toBe("");
  });
});
