/**
 * The effects added for advertisers in A52: strike, dim, the gradient, and the status symbols
 * an ad may not borrow. Each is checked for what it draws and for what an older client gets.
 */
import { describe, expect, test } from "bun:test";

import { BatchItemSchema } from "../src/contract.ts";
import { GRADIENT_COLORS, lineSpans, withGradient } from "../src/line.ts";
import { MAX_SPANS, parseMarkup, spanClasses } from "../src/markup.ts";
import { isStatusSymbol } from "../src/status-symbols.ts";

describe("strike and dim", () => {
  test("~~ strikes a run through", () => {
    const { spans, problems } = parseMarkup("Now ~~$20~~ $10");
    expect(problems).toEqual([]);
    expect(spans).toEqual([{ text: "Now " }, { text: "$20", strike: true }, { text: " $10" }]);
  });

  test("a single tilde is a tilde, and so is a ~~ nothing closes", () => {
    expect(parseMarkup("~5 minutes").plain).toBe("~5 minutes");
    // Copy written before strike existed must read as it always did.
    const { spans, problems } = parseMarkup("NEON DA BEST~~~");
    expect(problems).toEqual([]);
    expect(spans).toEqual([{ text: "NEON DA BEST~~~" }]);
  });

  test("{dim:…} dims a run, and composes with a colour either way round", () => {
    expect(parseMarkup("{dim:from} $9").spans).toEqual([
      { text: "from", dim: true },
      { text: " $9" },
    ]);
    expect(parseMarkup("{dim:{cyan:x}}").spans).toEqual([{ text: "x", dim: true, color: "cyan" }]);
    expect(parseMarkup("{cyan:{dim:x}}").spans).toEqual([{ text: "x", dim: true, color: "cyan" }]);
  });

  test("dim cannot nest in dim", () => {
    expect(parseMarkup("{dim:{dim:x}}").problems).toContain("dim cannot be nested");
  });

  test("neither counts against the emphasis allowance: both are quieter, not louder", () => {
    const long = "x".repeat(60);
    expect(parseMarkup(`~~${long}~~`).problems).toEqual([]);
    expect(parseMarkup(`{dim:${long}}`).problems).toEqual([]);
  });

  test("the web draws them with their own classes", () => {
    expect(spanClasses({ text: "a", strike: true, dim: true })).toBe("is-strike is-dim");
  });

  test("a client older than them strips the flags and draws the run plain", () => {
    // The old client's span schema, as shipped: no `strike`, no `dim`.
    const item = BatchItemSchema.parse({
      impression_id: crypto.randomUUID(),
      nonce: "AAAA",
      body: "Now $20 $10",
      click_url: "https://obrigado.dev/c/token",
      spans: [{ text: "$20", strike: true, dim: true, link: true }],
      rev_micros: 1000,
    });
    expect(item.spans[0]?.text).toBe("$20");
  });
});

describe("status symbols", () => {
  test("ticks, crosses, warnings, dots and spinners are refused", () => {
    for (const symbol of ["✓", "✔", "✅", "✗", "❌", "⚠", "⛔", "🔴", "🟢", "⏺", "⎿", "⠋"]) {
      expect(isStatusSymbol(symbol)).toBe(true);
      expect(parseMarkup(`Ship ${symbol} now`).problems.join(" ")).toContain("status indicator");
    }
  });

  test("arrows, stars and ordinary emoji are not", () => {
    for (const symbol of ["→", "★", "✦", "♥", "🚀"]) {
      expect(parseMarkup(`Ship ${symbol} now`).problems).toEqual([]);
    }
  });

  test("one problem per symbol, however often it appears", () => {
    expect(parseMarkup("✓ a ✓ b ✓").problems).toHaveLength(1);
  });
});

describe("the gradient", () => {
  test("splits the line into bands through the palette's cool end, in order", () => {
    const spans = withGradient([{ text: "abcdefghi" }]);
    expect(spans.map((span) => span.color)).toEqual([...GRADIENT_COLORS]);
    expect(spans.map((span) => span.text).join("")).toBe("abcdefghi");
  });

  test("a run the author coloured keeps its colour", () => {
    const spans = withGradient([{ text: "abc" }, { text: "def", color: "green" }, { text: "ghi" }]);
    expect(spans.find((span) => span.text === "def")?.color).toBe("green");
  });

  test("other styling survives the split", () => {
    const spans = withGradient([{ text: "abcdef", bold: true, link: true }]);
    expect(spans.every((span) => span.bold === true && span.link === true)).toBe(true);
  });

  test("a line that would need more runs than the wire allows is left unbanded", () => {
    const many = Array.from({ length: MAX_SPANS }, (_, index) => ({ text: `w${index}` }));
    expect(withGradient(many)).toEqual(many);
  });

  test("lineSpans applies it, and the default link, for the gradient effect only", () => {
    expect(lineSpans("abc", "none")).toEqual([{ text: "abc", link: true }]);
    expect(lineSpans("abc", "gradient").map((span) => span.color)).toEqual([...GRADIENT_COLORS]);
  });
});
