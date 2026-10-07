/**
 * The row the mod draws, built from stand-ins for Claude Code's elements.
 *
 * The constructors here build plain objects, so the tree can be read back and the disclosure
 * rules asserted on it: the label first, unstyled, outside the link; the palette on the runs;
 * one link for consecutive linked runs.
 */
import { describe, expect, test } from "bun:test";

import { sponsoredRow } from "../hooks/line.ts";
import type { BoxProps, LinkProps, RowElements, SvgProps, TextProps } from "../hooks/line.ts";
import type { Sponsored } from "../hooks/surface.ts";

type Node =
  | { readonly type: "Text"; readonly props: TextProps<Node> }
  | { readonly type: "Link"; readonly props: LinkProps<Node> }
  | { readonly type: "Box"; readonly props: BoxProps<Node> }
  | { readonly type: "Svg"; readonly props: SvgProps };

/** The terminal's elements: no `Svg`. */
const elements: RowElements<Node> = {
  Text: (props) => ({ type: "Text", props }),
  Link: (props) => ({ type: "Link", props }),
  Box: (props) => ({ type: "Box", props }),
};

/** The app's, which can draw a mark. */
const app: RowElements<Node> = { ...elements, Svg: (props) => ({ type: "Svg", props }) };

/** A PNG's first 24 bytes — signature and IHDR's size — as a data URI, which is all the mark reads. */
function pngUri(width: number, height: number): string {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return `data:image/png;base64,${btoa(String.fromCodePoint(...bytes))}`;
}

const ICON = pngUri(64, 64);

const URL = "https://obrigado.dev/c/token";

function ad(overrides: Partial<Sponsored> = {}): Sponsored {
  return {
    label: "oss-sponsor",
    copy: "Fast Postgres for your stack. acme.dev",
    url: URL,
    spans: [
      { text: "Fast Postgres", bold: true, link: true },
      { text: " for your stack. ", link: true },
      { text: "acme.dev", color: "cyan" },
    ],
    style: "default",
    effect: "none",
    brand: null,
    ...overrides,
  };
}

function row(line: Sponsored): TextProps<Node> {
  const root = sponsoredRow(line, elements);
  if (root.type !== "Text") throw new Error("the row is not a Text");
  return root.props;
}

function branded(icon: string): Sponsored {
  return ad({ brand: { name: "Acme", logo: null, icon } });
}

describe("the disclosure", () => {
  test("comes first, as plain text outside every link", () => {
    const [first, ...rest] = row(ad()).children;

    expect(first).toBe("oss-sponsor · ");
    expect(rest.every((child) => typeof child !== "string")).toBe(true);
  });

  test("is never styled: the row itself carries no colour or emphasis", () => {
    expect(row(ad({ style: "magenta", effect: "italic" }))).toEqual({
      wrap: "truncate-end",
      children: expect.any(Array),
    });
  });

  test("is left out, with no separator, when the developer turned it off", () => {
    expect(row(ad({ label: null })).children[0]).toMatchObject({ type: "Link" });
  });
});

describe("the link", () => {
  test("is one link over consecutive linked runs, to the click URL", () => {
    const links = row(ad()).children.filter(
      (child): child is Extract<Node, { type: "Link" }> =>
        typeof child !== "string" && child.type === "Link",
    );

    expect(links).toHaveLength(1);
    expect(links[0]?.props.href).toBe(URL);
    expect(links[0]?.props.children).toHaveLength(2);
  });

  test("underlines exactly the linked text", () => {
    const [, link, plain] = row(ad()).children;

    expect(link).toMatchObject({
      props: { children: [{ props: { underline: true } }, { props: { underline: true } }] },
    });
    expect(plain).toMatchObject({ type: "Text" });
    expect(plain).not.toMatchObject({ props: { underline: true } });
  });
});

describe("the palette", () => {
  test("a run's own colour wins over the line's slot", () => {
    const [, , plain] = row(ad({ style: "green" })).children;

    expect(plain).toMatchObject({ props: { color: "cyan" } });
  });

  test("the line's slot colours the runs that name none", () => {
    const [, link] = row(ad({ style: "green" })).children;

    expect(link).toMatchObject({
      props: { children: [{ props: { color: "green" } }, { props: { color: "green" } }] },
    });
  });

  test("italic effect, bold and highlight carry over in the engine's vocabulary", () => {
    const line = ad({
      effect: "italic",
      spans: [{ text: "Acme", bold: true, highlight: true }],
    });

    expect(row(line).children[1]).toEqual({
      type: "Text",
      props: { bold: true, italic: true, inverse: true, children: ["Acme"] },
    });
  });
});

describe("the mark", () => {
  test("sits between the disclosure and the copy, named for the brand, linking nowhere", () => {
    const drawn = sponsoredRow(branded(ICON), app);

    expect(drawn).toMatchObject({ type: "Box", props: { flexDirection: "row" } });
    if (drawn.type !== "Box") throw new Error("not a Box");
    const [label, logo, copy] = drawn.props.children;
    expect(label).toEqual({ type: "Text", props: { children: ["oss-sponsor · "] } });
    expect(logo).toMatchObject({ type: "Svg", props: { alt: "Acme" } });
    expect(logo).toMatchObject({ props: { source: expect.stringContaining(`href="${ICON}"`) } });
    expect(logo).toMatchObject({ props: { width: 16, height: 16 } });
    expect(copy).toMatchObject({ type: "Text", props: { wrap: "truncate-end" } });
  });

  test("leads the row on its own when the developer turned the disclosure off", () => {
    const drawn = sponsoredRow(
      ad({ label: null, brand: { name: "Acme", logo: null, icon: ICON } }),
      app,
    );

    if (drawn.type !== "Box") throw new Error("not a Box");
    expect(drawn.props.children[0]).toMatchObject({ type: "Svg" });
  });

  test("is left out where the surface has no Svg, and the row is the plain line", () => {
    expect(sponsoredRow(branded(ICON), elements)).toMatchObject({ type: "Text" });
  });

  test("is the square icon: a wordmark alone draws no mark", () => {
    const wordmarkOnly = ad({ brand: { name: "Acme", logo: pngUri(160, 24), icon: null } });
    expect(sponsoredRow(wordmarkOnly, app)).toMatchObject({ type: "Text" });
  });

  test("keeps its own proportions at the height of the line", () => {
    const drawn = sponsoredRow(branded(pngUri(64, 32)), app);

    if (drawn.type !== "Box") throw new Error("not a Box");
    expect(drawn.props.children[1]).toMatchObject({
      type: "Svg",
      props: { width: 32, height: 16 },
    });
  });

  test("is left out for anything but a PNG data URI that cannot break out of its attribute", () => {
    for (const logo of [
      'data:image/png;base64,AAAA" onload="x',
      "data:image/svg+xml;base64,AAAA",
      "https://example.com/logo.png",
      `data:image/png;base64,${"A".repeat(6000)}`,
    ]) {
      expect(sponsoredRow(branded(logo), app)).toMatchObject({ type: "Text" });
    }
  });
});
