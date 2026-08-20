import { describe, expect, test } from "bun:test";

import type { BatchItem, WireSpan } from "@obrigado/shared";

import { renderCopy } from "../src/render.ts";

const ESC = "\u001B";
const CLICKABLE = { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "iTerm.app" };
const PLAIN_TERMINAL = { TERM: "xterm-256color" };

const item = (overrides: Partial<BatchItem> = {}): BatchItem =>
  ({
    impression_id: "11111111-1111-1111-1111-111111111111",
    nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
    body: "Postgres, but you never think about it — neon.tech",
    click_url: "https://obrigado.dev/c/token",
    style: "default",
    effect: "none",
    spans: [],
    rev_micros: 3000,
    ...overrides,
  }) as BatchItem;

const spans = (...list: WireSpan[]): WireSpan[] => list;

describe("per-span attributes", () => {
  test("styles individual runs independently", () => {
    const out = renderCopy(
      item({
        spans: spans(
          { text: "Postgres", color: "cyan" },
          { text: ", but you never " },
          { text: "think", italic: true },
        ),
      }),
      { env: CLICKABLE },
    );

    expect(out).toContain(`${ESC}[36mPostgres${ESC}[39m`);
    expect(out).toContain(`${ESC}[3mthink${ESC}[23m`);
    expect(out).toContain(", but you never ");
  });

  test("a single letter can be styled", () => {
    const out = renderCopy(item({ spans: spans({ text: "n", bold: true }, { text: "eon" }) }), {
      env: CLICKABLE,
    });
    expect(out).toContain(`${ESC}[1mn${ESC}[22m`);
    expect(out).toContain("eon");
  });

  test("attributes combine on one run", () => {
    const out = renderCopy(
      item({ spans: spans({ text: "x", bold: true, italic: true, color: "green" }) }),
      { env: CLICKABLE },
    );
    expect(out).toContain(`${ESC}[1m`);
    expect(out).toContain(`${ESC}[3m`);
    expect(out).toContain(`${ESC}[32m`);
  });

  test("highlight is REVERSE video, not a background colour", () => {
    // Reverse swaps the reader's own foreground and background, so it cannot
    // render unreadably against a theme we know nothing about.
    const out = renderCopy(item({ spans: spans({ text: "new", highlight: true }) }), {
      env: CLICKABLE,
    });
    expect(out).toContain(`${ESC}[7mnew${ESC}[27m`);
  });

  test("every attribute resets only itself", () => {
    // A span emitting ESC[0m would clear styling belonging to the rest of the
    // line, and whatever the agent applied to the row.
    const out = renderCopy(
      item({ spans: spans({ text: "a", bold: true, color: "cyan" }, { text: "b" }) }),
      { env: CLICKABLE },
    );
    expect(out).not.toContain(`${ESC}[0m`);
    expect(out).toContain(`${ESC}[22m`);
    expect(out).toContain(`${ESC}[39m`);
  });
});

describe("the single tracking link", () => {
  test("links only the marked runs", () => {
    const out = renderCopy(
      item({
        spans: spans({ text: "Postgres — " }, { text: "neon.tech", bold: true, link: true }),
      }),
      { env: CLICKABLE },
    );

    expect(out.startsWith("Postgres — ")).toBe(true);
    expect(out).toContain(`${ESC}]8;;https://obrigado.dev/c/token`);
    expect(out.split(`${ESC}]8;;`)).toHaveLength(3);
  });

  test("consecutive link runs share ONE hyperlink sequence", () => {
    // One OSC 8 per contiguous run, not one per span — otherwise a styled link
    // would emit several links to the same URL.
    const out = renderCopy(
      item({
        spans: spans(
          { text: "neon", bold: true, link: true },
          { text: ".tech", link: true },
          { text: " today" },
        ),
      }),
      { env: CLICKABLE },
    );
    expect(out.split(`${ESC}]8;;`)).toHaveLength(3);
    expect(out.endsWith(" today")).toBe(true);
  });

  test("underline marks exactly the clickable run", () => {
    const out = renderCopy(
      item({ spans: spans({ text: "plain " }, { text: "link", link: true }) }),
      { env: CLICKABLE },
    );
    expect(out.split(`${ESC}[4m`)).toHaveLength(2);
    expect(out.indexOf(`${ESC}[4m`)).toBeGreaterThan(out.indexOf("plain"));
  });

  test("no spans means the whole body is the link", () => {
    const out = renderCopy(item({ spans: [] }), { env: CLICKABLE });
    expect(out).toContain(`${ESC}]8;;`);
    expect(out).toContain("Postgres, but you never think about it — neon.tech");
  });

  test("a terminal without OSC 8 gets no link and no underline", () => {
    // Underline means clickable. Claiming the affordance without the link would
    // be using it as an attention-grab.
    const out = renderCopy(item({ spans: spans({ text: "neon.tech", link: true }) }), {
      env: PLAIN_TERMINAL,
    });
    expect(out).not.toContain(`${ESC}]8;;`);
    expect(out).not.toContain(`${ESC}[4m`);
    expect(out).toContain("neon.tech");
  });
});

describe("line-level style wraps the spans", () => {
  test("base colour and effect are outermost", () => {
    const out = renderCopy(
      item({ style: "cyan", effect: "italic", spans: spans({ text: "copy", bold: true }) }),
      { env: CLICKABLE },
    );
    expect(out.startsWith(`${ESC}[36m${ESC}[3m`)).toBe(true);
    expect(out.endsWith(`${ESC}[23m${ESC}[39m`)).toBe(true);
  });

  test("the developer's colour preference disables all styling but keeps the link", () => {
    const out = renderCopy(
      item({
        style: "cyan",
        effect: "italic",
        spans: spans({ text: "a", bold: true, color: "magenta" }, { text: "b", link: true }),
      }),
      { env: CLICKABLE, color: "off" },
    );
    expect(out).not.toContain(`${ESC}[1m`);
    expect(out).not.toContain(`${ESC}[35m`);
    // Clickability is not a styling preference.
    expect(out).toContain(`${ESC}]8;;`);
  });
});

describe("sanitisation happens per span, before styling", () => {
  test("escape bytes inside a span cannot reach the terminal", () => {
    const out = renderCopy(item({ spans: spans({ text: `a${ESC}[2Kb`, bold: true }) }), {
      env: CLICKABLE,
    });
    expect(out).not.toContain(`${ESC}[2K`);
    expect(out).toContain("a[2Kb");
  });

  test("a span that is entirely control characters is dropped", () => {
    const out = renderCopy(item({ spans: spans({ text: "keep" }, { text: "" }) }), {
      env: CLICKABLE,
    });
    expect(out).toBe("keep");
  });

  test("copy that sanitises to nothing renders nothing", () => {
    expect(renderCopy(item({ spans: spans({ text: "" }) }), { env: CLICKABLE })).toBe("");
  });
});
