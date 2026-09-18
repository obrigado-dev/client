import { describe, expect, test } from "bun:test";

import {
  lineClasses,
  spanClasses,
  withDefaultLink,
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
  /* Each marker, and the runs it produces — asserted as the whole span list, because where a
     style STOPS matters as much as where it starts. Nesting composes rather than replaces, and
     a marker may wrap a single letter. */
  test("each marker styles exactly its run", () => {
    const cases = [
      ["try **neon** today", [{ text: "try " }, { text: "neon", bold: true }, { text: " today" }]],
      ["try _neon_ today", [{ text: "try " }, { text: "neon", italic: true }, { text: " today" }]],
      [
        "try `neon` today",
        [{ text: "try " }, { text: "neon", highlight: true }, { text: " today" }],
      ],
      ["a **_b_** c", [{ text: "a " }, { text: "b", bold: true, italic: true }, { text: " c" }]],
      ["**n**eon", [{ text: "n", bold: true }, { text: "eon" }]],
    ] as const;

    for (const [source, spans] of cases) {
      expect(ok(source).spans).toEqual([...spans]);
    }
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
  /*
   * How much of a line may shout, by example.
   *
   * The cap is proportional OR absolute, whichever is more permissive — so a long line may not
   * be bold throughout, while a short brand-only creative may be (nine bold characters do not
   * drown a nine-character `sponsored` label; `"a link can carry other styles"` above is that
   * case, and it passes `ok`). A highlight is capped separately so it cannot become a banner.
   */
  test("emphasis is refused past the cap and allowed within it", () => {
    const cases = [
      // Bold covering a whole long line.
      [`**${"everything is bold here and then some more".slice(0, 42)}**`, "at most"],
      // Emphasis beyond the cap, with unemphasised text after it.
      [`**${"a".repeat(40)}**${"b".repeat(20)}`, "at most"],
      // A highlight long enough to read as a banner.
      [`\`${"x".repeat(MAX_HIGHLIGHT_LENGTH + 1)}\`${"y".repeat(60)}`, "at most"],
      // Within the cap.
      ["Postgres, but you never think about it — **neon**", null],
    ] as const;

    for (const [source, problem] of cases) {
      const { spans, problems } = parseMarkup(source);
      if (problem === null) {
        expect(problems).toEqual([]);
        expect(spans.some((span) => span.bold === true)).toBe(true);
      } else {
        expect(problems.join(" ")).toContain(problem);
      }
    }
  });

  test("italic is not capped — it differentiates rather than amplifies", () => {
    // Italic distinguishes the sponsored line from the developer's own status
    // text, which helps the disclosure; bold competes with it.
    const { problems } = parseMarkup("_the whole line in italic is fine_");
    expect(problems).toEqual([]);
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
