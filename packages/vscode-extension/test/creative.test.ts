import { describe, expect, test } from "bun:test";

import {
  escapeMarkdown,
  statusText,
  stripCodicons,
  tooltipMarkdown,
  type Sponsored,
  type SponsoredSpan,
} from "../src/creative.ts";

function ad(over: Partial<Sponsored> = {}): Sponsored {
  const copy = over.copy ?? "Ship it faster — example.com";
  return {
    label: "sponsored",
    copy,
    url: "https://obrigado.dev/c/abc123.sig",
    spans: [{ text: copy, link: true } satisfies SponsoredSpan],
    style: "default",
    effect: "none",
    brand: null,
    ...over,
  };
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

describe("status bar text", () => {
  test("the glyph precedes a label that precedes the copy", () => {
    expect(statusText(ad())).toBe("$(sparkle) sponsored · Ship it faster — example.com");
  });

  test("a creative cannot paint the editor's own icons", () => {
    // `$(name)` is an icon in status bar text, so this is an advertiser drawing host chrome
    // — an ad that renders the error icon reads as the EDITOR saying something is wrong.
    const line = statusText(ad({ copy: "$(error) your build is broken $(sync~spin)" }));
    // Exactly one live icon token survives, and it is the one we placed.
    expect(line.match(/\$\(/gu)).toEqual(["$("]);
    expect(line).toContain("$ (error)");
    expect(line).toContain("$ (sync~spin)");
  });

  test("the glyph itself still survives that stripping", () => {
    // Only advertiser-supplied parts are stripped; the one icon we place is ours.
    expect(statusText(ad())).toContain("$(sparkle)");
  });

  test("a label carrying an icon token is stripped too", () => {
    expect(statusText(ad({ label: "$(megaphone)ad" }))).toContain("$ (megaphone)ad");
  });

  test("stripping keeps the text readable rather than deleting it", () => {
    expect(stripCodicons("save 50% $(zap) today")).toBe("save 50% $ (zap) today");
  });
});

describe("hover markdown", () => {
  test("label, copy as a link, and the split", () => {
    const md = tooltipMarkdown(ad());
    expect(md).toContain("**sponsored**");
    expect(md).toContain("[Ship it faster — example\\.com](https://obrigado.dev/c/abc123.sig)");
    expect(md).toContain("70% of revenue funds the packages you depend on");
  });

  test("bold and italic runs survive, because markdown can carry them", () => {
    const md = tooltipMarkdown(
      ad({
        spans: [
          { text: "half price", bold: true },
          { text: " today", italic: true },
        ],
      }),
    );
    expect(md).toContain("**half price**");
    expect(md).toContain("_ today_");
  });

  test("a line-wide italic effect applies to every run", () => {
    const md = tooltipMarkdown(ad({ spans: [{ text: "quiet" }], effect: "italic" }));
    expect(md).toContain("_quiet_");
  });

  test("§3 — a creative cannot smuggle its own link past the redirect", () => {
    // The one that actually costs money: an unescaped `[text](url)` in copy renders as a
    // second, live link to wherever the advertiser wants, bypassing the signed /c/ redirect
    // that records the click and sanitises the destination.
    const md = tooltipMarkdown(ad({ copy: "[click here](https://evil.example)" }));
    expect(md).not.toContain("](https://evil.example)");
    expect(md).toContain("\\[click here\\]");
  });

  test("markdown formatting in copy renders as the characters it is", () => {
    // `NEON DA BEST~~~` is a real seeded creative, and unescaped it renders struck through.
    const md = tooltipMarkdown(ad({ copy: "**FREE** ~~~NEON~~~" }));
    expect(md).toContain("\\*\\*FREE\\*\\*");
    expect(md).toContain("\\~\\~\\~NEON\\~\\~\\~");
  });

  test("backslashes are escaped first, not last", () => {
    // Escaping `*` before `\` would produce `\\*` — an escaped backslash followed by a live
    // asterisk, which is the bug this ordering exists to avoid.
    expect(escapeMarkdown("a\\*b")).toBe("a\\\\\\*b");
  });

  test("a URL with parentheses cannot end the link early", () => {
    const md = tooltipMarkdown(ad({ url: "https://obrigado.dev/c/a(b)c" }));
    expect(md).toContain("%28b%29c");
    expect(md).not.toContain("(b)c");
  });
});

describe("the brand logo in the hover", () => {
  test("a png data uri renders as an image, with the brand name as alt text", () => {
    const md = tooltipMarkdown(ad({ brand: { name: "Kysely", logo: PNG } }));
    expect(md).toContain(`![Kysely](${PNG})`);
  });

  test("no brand and no logo both render nothing extra", () => {
    expect(tooltipMarkdown(ad({ brand: null }))).not.toContain("![");
    expect(tooltipMarkdown(ad({ brand: { name: "Kysely", logo: null } }))).not.toContain("![");
  });

  test("a remote logo is refused, however valid it looks", () => {
    // The whole reason logos travel as bytes. An https URL here would make every hover
    // fetch the advertiser's origin from inside the editor — an IP address and an activity
    // signal nobody sold them. Verified renderable in this host, and refused anyway.
    const md = tooltipMarkdown(
      ad({ brand: { name: "Kysely", logo: "https://cdn.example/l.png" } }),
    );
    expect(md).not.toContain("![");
    expect(md).not.toContain("cdn.example");
  });

  test("a non-png data uri is refused", () => {
    for (const logo of [
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/png,notbase64",
    ]) {
      expect(tooltipMarkdown(ad({ brand: { name: "X", logo } }))).not.toContain("![");
    }
  });

  test("a payload carrying markdown syntax cannot escape the image", () => {
    // The one shape that would matter: a `)` in the payload ends the image early and lets
    // whatever follows render as markdown. Base64 has no `)`, so anything containing one is
    // not a payload we produced — drop it rather than try to repair it.
    const md = tooltipMarkdown(
      ad({
        brand: { name: "X", logo: "data:image/png;base64,AAA) [gotcha](https://evil.example)" },
      }),
    );
    expect(md).not.toContain("![");
    expect(md).not.toContain("evil.example");
  });

  test("the brand name in alt text is escaped like any other advertiser string", () => {
    // Alt text sits inside `![…]`, so an unescaped `]` closes it and the rest becomes live
    // markdown. The name is advertiser-supplied and gets the same treatment as the copy.
    const md = tooltipMarkdown(ad({ brand: { name: "A[b](c)", logo: PNG } }));
    expect(md).toContain(`![A\\[b\\]\\(c\\)](${PNG})`);
  });
});
