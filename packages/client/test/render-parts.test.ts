import { describe, expect, test } from "bun:test";

import type { BatchItem } from "@obrigado/shared";

import { copyParts } from "../src/render.ts";

const ESC = "";

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

describe("copyParts — one render, serialised for a host that draws its own UI", () => {
  test("carries the palette and emphasis rather than escape codes", () => {
    const parts = copyParts(
      item({
        style: "cyan",
        effect: "italic",
        spans: [
          { text: "Branch your database", bold: true, link: true },
          { text: " — neon.tech", color: "magenta", link: true },
        ],
      }),
    );

    expect(parts.style).toBe("cyan");
    expect(parts.effect).toBe("italic");
    expect(parts.spans[0]).toMatchObject({ bold: true, link: true });
    expect(parts.spans[1]).toMatchObject({ color: "magenta" });

    // Not one escape byte anywhere. That is the whole point of this serialisation:
    // OpenCode renders literally or strips, and either would ruin the line.
    expect(JSON.stringify(parts)).not.toContain(ESC);
  });

  test("an unmarked creative becomes one link over the whole line", () => {
    // Matches renderCopy's fallback exactly. If these two ever disagree, a creative
    // without markup is clickable in one host and not the other.
    expect(copyParts(item({ body: "plain copy", spans: [] })).spans).toEqual([
      { text: "plain copy", link: true },
    ]);
  });

  test("sanitises span text, and drops spans that sanitise away to nothing", () => {
    const parts = copyParts(
      item({
        spans: [
          { text: `safe${ESC}[31m`, link: true },
          // Nothing but control bytes, so nothing survives and there is no empty run
          // left behind to occupy a slot in the line.
          { text: `${ESC}`, link: true },
        ],
      }),
    );

    expect(parts.spans).toHaveLength(1);
    // The escape INTRODUCER goes; the literal characters after it are just text, and
    // are kept rather than silently eating part of the advertiser's copy.
    expect(parts.spans[0]?.text).toBe("safe[31m");
  });

  test("the label is never included — the caller adds it, outside the link", () => {
    // A host that received the disclosure as a span could style it with the
    // advertiser's palette, or make it clickable. Neither is allowed (§3).
    expect(JSON.stringify(copyParts(item()))).not.toContain("sponsored");
  });
});
