import { describe, expect, test } from "bun:test";

import {
  footerTree,
  leafText,
  lineNode,
  parseRenderedLine,
  validHref,
  validTree,
} from "../src/codex-tree.ts";
import type { RenderedLine, UiNode } from "../src/codex-tree.ts";

const URL = "https://obrigado.dev/c/abc";

function line(overrides: Partial<RenderedLine> = {}): RenderedLine {
  return {
    label: "oss-sponsor",
    url: URL,
    spans: [{ text: "Acme: ship faster", link: true }],
    style: "default",
    effect: "none",
    ...overrides,
  };
}

/** A row of `count` leaves: `count + 1` elements. */
const wide = (count: number): UiNode => ({
  type: "row",
  props: { gap: 0 },
  children: Array.from({ length: count }, () => "x"),
});

/** A leaf under `levels` elements, one inside the next. */
const deep = (levels: number): UiNode => {
  let node: UiNode = "x";
  for (let level = 0; level < levels; level += 1) node = { type: "bold", children: [node] };
  return node;
};

describe("a tree Codex will draw", () => {
  test("the shapes it documents pass", () => {
    const tree: UiNode = {
      type: "row",
      props: { gap: 1, wrap: "wrap" },
      children: [
        { type: "text", props: { color: "status-model", weight: "bold" }, children: ["gpt"] },
        "·",
        { type: "link", props: { href: URL }, children: [{ type: "italic", children: ["x"] }] },
      ],
    };
    expect(validTree(tree)).toBe(true);
    expect(validTree(null)).toBe(true);
    expect(validTree("plain")).toBe(true);
    expect(validTree({ type: "text", props: { color: "#A1b2C3" }, children: [null, "x"] })).toBe(
      true,
    );
  });

  test("a field or a value it does not know fails the whole tree, as it does in Codex", () => {
    expect(validTree({ type: "text", children: ["x"], extra: 1 })).toBe(false);
    expect(validTree({ type: "text", props: { strike: true }, children: ["x"] })).toBe(false);
    expect(validTree({ type: "text", props: { color: "orange" }, children: ["x"] })).toBe(false);
    expect(validTree({ type: "text", props: { color: "#fff" }, children: ["x"] })).toBe(false);
    expect(validTree({ type: "row", props: { gap: -1 }, children: [] })).toBe(false);
    expect(validTree({ type: "row", props: { gap: 1.5 }, children: [] })).toBe(false);
    expect(validTree({ type: "row", props: { gap: 1, wrap: "sometimes" }, children: [] })).toBe(
      false,
    );
    expect(validTree({ type: "row", children: [] })).toBe(false);
    expect(validTree({ type: "box", children: [] })).toBe(false);
    expect(validTree({ type: "text" })).toBe(false);
    expect(validTree(7)).toBe(false);
    expect(validTree(["x"])).toBe(false);
  });

  test("a link is a plain web address or the tree fails", () => {
    expect(validHref(URL)).toBe(true);
    expect(validHref("http://localhost:8787/c/x")).toBe(true);
    expect(validHref("javascript:alert(1)")).toBe(false);
    expect(validHref("file:///etc/passwd")).toBe(false);
    expect(validHref("/c/abc")).toBe(false);
    expect(validHref(`https://obrigado.dev/c/a\u001B]8;;`)).toBe(false);
    expect(validHref(`https://obrigado.dev/${"a".repeat(9000)}`)).toBe(false);
    expect(validTree({ type: "link", props: { href: "nope" }, children: ["x"] })).toBe(false);
  });

  test("its limits are held: 256 elements, 16 levels, 16 KiB of text", () => {
    expect(validTree(wide(255))).toBe(true);
    expect(validTree(wide(256))).toBe(false);

    expect(validTree(deep(16))).toBe(true);
    expect(validTree(deep(17))).toBe(false);
    // Deep on purpose: refused at the limit, not at the bottom of the stack.
    expect(validTree(deep(100_000))).toBe(false);

    expect(validTree("é".repeat(8192))).toBe(true);
    expect(validTree("é".repeat(8193))).toBe(false);
  });
});

describe("a line from the renderer", () => {
  test("is read the way the hosts that draw their own UI read it", () => {
    const parsed = parseRenderedLine(
      JSON.stringify({
        label: "oss-sponsor",
        copy: "Acme: ship faster",
        url: URL,
        spans: [
          { text: "Acme", bold: true, color: "cyan", link: true },
          { text: ": ship faster", link: true, strike: true, dim: true, highlight: true },
        ],
        style: "green",
        effect: "italic",
        brand: { name: "Acme", logo: null, icon: null },
      }),
    );
    expect(parsed).toEqual({
      label: "oss-sponsor",
      url: URL,
      spans: [
        { text: "Acme", bold: true, color: "cyan", link: true },
        { text: ": ship faster", link: true },
      ],
      style: "green",
      effect: "italic",
    });
  });

  test("a line with no runs is one link over its copy", () => {
    expect(
      parseRenderedLine(JSON.stringify({ label: "x", copy: "hello", url: URL }))?.spans,
    ).toEqual([{ text: "hello", link: true }]);
  });

  test("a label that is off stays off, and a colour nobody may wear is dropped", () => {
    const parsed = parseRenderedLine(
      JSON.stringify({
        label: null,
        copy: "c",
        url: URL,
        style: "red",
        spans: [{ text: "c", color: "yellow" }],
      }),
    );
    expect(parsed?.label).toBeNull();
    expect(parsed?.style).toBe("default");
    expect(parsed?.spans).toEqual([{ text: "c" }]);
  });

  test("anything that is not a whole line is nothing", () => {
    expect(parseRenderedLine("")).toBeNull();
    expect(parseRenderedLine("oss-sponsor · plain text")).toBeNull();
    expect(parseRenderedLine(JSON.stringify({ copy: "c" }))).toBeNull();
    expect(parseRenderedLine(JSON.stringify({ url: URL }))).toBeNull();
    expect(parseRenderedLine("[]")).toBeNull();
  });
});

describe("our line in the footer", () => {
  test("the label is bare text outside the link, and the copy is the link", () => {
    expect(lineNode(line())).toEqual({
      type: "text",
      children: [
        "oss-sponsor · ",
        { type: "link", props: { href: URL }, children: ["Acme: ship faster"] },
      ],
    });
  });

  test("runs keep their styling, and the line's colour is for a run that names none", () => {
    const node = lineNode(
      line({
        style: "green",
        spans: [
          { text: "Acme", bold: true, color: "cyan", link: true },
          { text: " ships", link: true },
          { text: " today", italic: true },
        ],
      }),
    );
    expect(node).toEqual({
      type: "text",
      children: [
        "oss-sponsor · ",
        {
          type: "link",
          props: { href: URL },
          children: [
            { type: "text", props: { color: "cyan", weight: "bold" }, children: ["Acme"] },
            { type: "text", props: { color: "green" }, children: [" ships"] },
          ],
        },
        { type: "text", props: { color: "green", italic: true }, children: [" today"] },
      ],
    });
    expect(validTree(node)).toBe(true);
  });

  test("linked runs apart from each other are each a link to the same place", () => {
    const node = lineNode(
      line({
        spans: [{ text: "Acme", link: true }, { text: " · " }, { text: "acme.dev", link: true }],
      }),
    );
    expect(node).toEqual({
      type: "text",
      children: [
        "oss-sponsor · ",
        { type: "link", props: { href: URL }, children: ["Acme"] },
        " · ",
        { type: "link", props: { href: URL }, children: ["acme.dev"] },
      ],
    });
  });

  test("with the label off, the copy is drawn alone", () => {
    expect(lineNode(line({ label: null }))).toEqual({
      type: "text",
      children: [{ type: "link", props: { href: URL }, children: ["Acme: ship faster"] }],
    });
  });

  test("a URL Codex would refuse draws the copy with no link, not a footer that fails", () => {
    const node = lineNode(line({ url: "javascript:alert(1)" }));
    expect(node).toEqual({ type: "text", children: ["oss-sponsor · ", "Acme: ship faster"] });
    expect(validTree(node)).toBe(true);
  });

  test("a newline or an escape in the copy cannot break the footer's line", () => {
    expect(leafText("a\nb\u001B[31mc\u009Bd")).toBe("a b [31mc d");
    const node = lineNode(line({ spans: [{ text: "two\nlines", link: true }] }));
    expect(JSON.stringify(node)).not.toContain("\\n");
  });

  test("an italic line is italic in every run", () => {
    expect(lineNode(line({ effect: "italic" }))).toEqual({
      type: "text",
      children: [
        "oss-sponsor · ",
        {
          type: "link",
          props: { href: URL },
          children: [{ type: "text", props: { italic: true }, children: ["Acme: ship faster"] }],
        },
      ],
    });
  });
});

describe("the whole footer", () => {
  const theirs: UiNode = {
    type: "row",
    props: { gap: 1, wrap: "wrap" },
    children: ["gpt", "·", "~/code"],
  };

  test("is theirs, then ours, in a row that wraps ours first", () => {
    const ours = lineNode(line());
    expect(footerTree(theirs, ours)).toEqual({
      type: "row",
      props: { gap: 2, wrap: "wrap" },
      children: [theirs, ours],
    });
  });

  test("is theirs alone where there is no line, and ours alone where they have none", () => {
    expect(footerTree(theirs, null)).toBe(theirs);
    expect(footerTree(null, "ours")).toBe("ours");
    expect(footerTree(null, null)).toBeNull();
  });

  test("ours is dropped where the two together would be refused", () => {
    const full: UiNode = {
      type: "row",
      props: { gap: 0 },
      children: Array.from({ length: 254 }, () => "x"),
    };
    expect(validTree(full)).toBe(true);
    expect(footerTree(full, lineNode(line()))).toBe(full);
  });
});
