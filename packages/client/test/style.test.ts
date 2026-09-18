import { describe, expect, test } from "bun:test";

import {
  CreativeEffectSchema as WireEffect,
  CreativeStyleSchema as WireStyle,
} from "@obrigado/shared";

import {
  applyStyle,
  CREATIVE_EFFECTS,
  CREATIVE_STYLES,
  isCreativeEffect,
  isCreativeStyle,
  supportsColor,
} from "../src/style.ts";
import type { CreativeStyle } from "../src/style.ts";

const ESC = "\u001B";
const env = (vars: Record<string, string | undefined>) => vars;
const colorful = env({ TERM: "xterm-256color", COLORTERM: "truecolor" });

describe("the palette", () => {
  /*
   * What an advertiser may ask for, value by value — and it is the refusals that carry the
   * rules, because the lists themselves are pinned to the wire contract below.
   *
   * **No alert colours.** In a terminal, red means error and yellow means warning. An ad
   * wearing either is impersonating a build failure — the same attack as injecting escape
   * bytes, reached through a channel we would have sanctioned.
   *
   * **Nothing that outshouts the label.** Bold, reverse, blink and background colours would
   * each make the copy louder than the `sponsored` label that discloses it. Italic is the one
   * effect allowed: it DIFFERENTIATES the line from the developer's own status text, which
   * helps the disclosure, where bold AMPLIFIES the copy and competes with it.
   *
   * **Underline is not advertiser-selectable.** It means "clickable", and the renderer applies
   * it exactly when the text really is a link, so an advertiser cannot borrow the affordance
   * as an attention-grab.
   */
  test("only the quiet slots and effects are selectable", () => {
    const values = [
      ["italic", false, true],
      ["none", false, true],
      // Alert colours.
      ["red", false, false],
      ["yellow", false, false],
      ["orange", false, false],
      ["bright-red", false, false],
      // Louder than the label.
      ["bold", false, false],
      ["reverse", false, false],
      ["blink", false, false],
      ["bg-cyan", false, false],
      ["inverse", false, false],
      ["strikethrough", false, false],
      // The renderer's own affordance, never the advertiser's.
      ["underline", false, false],
    ] as const;

    for (const [value, style, effect] of values) {
      expect(`${value} style=${isCreativeStyle(value)}`).toBe(`${value} style=${style}`);
      expect(`${value} effect=${isCreativeEffect(value)}`).toBe(`${value} effect=${effect}`);
    }
  });

  test("is the wire contract's palette, exactly", () => {
    // `render.ts` casts the wire's style string to this module's union. If the two lists
    // ever drifted, `applyStyle` would print the literal string `undefined` into the
    // developer's terminal — so the lists are pinned to each other here.
    expect([...CREATIVE_STYLES]).toEqual([...WireStyle.options]);
    expect([...CREATIVE_EFFECTS]).toEqual([...WireEffect.options]);
  });

  test("the surface package names the same colours", async () => {
    // The host packages may not import `@obrigado/shared` (INVARIANT 13). What they share
    // instead is `@obrigado/surface`, which carries the one copy of the colours a span may
    // ask for. A source scan is the cheapest way to keep that copy honest: a colour added
    // to the contract and not to the surface renders as nothing in every host, silently.
    const sources = await Promise.all(
      ["../../surface/src/index.ts"].map((relative) =>
        Bun.file(new URL(relative, import.meta.url)).text(),
      ),
    );
    const colours = WireStyle.options.filter((style) => style !== "default");
    expect(colours.length).toBeGreaterThan(0);
    for (const source of sources) {
      for (const colour of colours) expect(source).toContain(`"${colour}"`);
      expect(source).toContain('"italic"');
    }
  });
});

describe("applyStyle", () => {
  test("uses the BASIC colour slots, which the developer's theme remaps", () => {
    // 36 not 96 (bright) and not 38;5;N (256-colour): the basic slots are the
    // ones a terminal theme redefines, so "cyan" means *their* cyan.
    expect(applyStyle("copy", "cyan", colorful)).toBe(`${ESC}[36mcopy${ESC}[39m`);
    expect(applyStyle("copy", "blue", colorful)).toBe(`${ESC}[34mcopy${ESC}[39m`);
    expect(applyStyle("copy", "green", colorful)).toBe(`${ESC}[32mcopy${ESC}[39m`);
    expect(applyStyle("copy", "magenta", colorful)).toBe(`${ESC}[35mcopy${ESC}[39m`);
  });

  test("resets only the foreground, never the whole line", () => {
    // ESC[0m would also clear styling Claude Code applied to the row, so the
    // rest of the developer's status line could render differently than they
    // configured it. Resetting exactly what we set is the whole difference
    // between styling our line and editing theirs.
    const styled = applyStyle("copy", "cyan", colorful);
    expect(styled).toContain(`${ESC}[39m`);
    expect(styled).not.toContain(`${ESC}[0m`);
  });

  test("'default' emits nothing at all", () => {
    expect(applyStyle("copy", "default", colorful)).toBe("copy");
  });
});

describe("the developer's setup wins", () => {
  test("NO_COLOR disables colour, whatever the advertiser chose", () => {
    // https://no-color.org — any non-empty value.
    expect(applyStyle("copy", "cyan", { ...colorful, NO_COLOR: "1" })).toBe("copy");
    expect(applyStyle("copy", "magenta", { ...colorful, NO_COLOR: "anything" })).toBe("copy");
  });

  test("an explicit `color: off` preference disables it", () => {
    expect(applyStyle("copy", "cyan", colorful, "off")).toBe("copy");
  });

  test("a terminal that cannot do colour gets none", () => {
    expect(applyStyle("copy", "cyan", env({ TERM: "dumb" }))).toBe("copy");
    expect(applyStyle("copy", "cyan", env({}))).toBe("copy");
  });

  test("NO_COLOR beats FORCE_COLOR", () => {
    expect(supportsColor({ ...colorful, NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
  });

  test("an empty NO_COLOR is not a request to disable", () => {
    // The convention is presence with a non-empty value.
    expect(supportsColor({ ...colorful, NO_COLOR: "" })).toBe(true);
  });
});

describe("capability detection", () => {
  test("does NOT depend on stdout being a TTY", () => {
    // Claude Code "captures your script's output instead of connecting it
    // directly to the terminal", so stdout is a pipe on every render. A TTY
    // check — the usual heuristic — would disable colour permanently.
    expect(supportsColor(colorful)).toBe(true);
    expect(process.stdout.isTTY).not.toBe(true);
  });

  test("recognises common terminals", () => {
    expect(supportsColor(env({ TERM: "xterm-256color" }))).toBe(true);
    expect(supportsColor(env({ TERM: "screen" }))).toBe(true);
    expect(supportsColor(env({ TERM: "vt100", TERM_PROGRAM: "iTerm.app" }))).toBe(true);
  });

  test("FORCE_COLOR=0 is not a request to force colour", () => {
    expect(supportsColor(env({ TERM: "dumb", FORCE_COLOR: "0" }))).toBe(false);
  });
});

describe("the label is never styled", () => {
  test("styling applies to the copy only, so the disclosure cannot be dimmed", () => {
    // The rendered line is `sponsored · <styled copy>`; the label is outside.
    const style: CreativeStyle = "cyan";
    const line = `sponsored · ${applyStyle("buy things", style, colorful)}`;

    expect(line.startsWith("sponsored · ")).toBe(true);
    expect(line.indexOf(ESC)).toBeGreaterThan(line.indexOf("sponsored"));
  });
});
