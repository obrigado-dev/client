/**
 * The footer Codex is handed: its tree format, the checks Codex makes on one, and our line in it.
 *
 * A Codex status line provider answers each read with a UI tree, JSON that Codex lays out as its
 * footer. Codex is strict about it. A tree with a field it does not know, a colour it does not
 * name, a link that is not a plain web address, or more text than it allows is not drawn smaller:
 * the read fails, the footer says "Status line failed", and Codex stops asking until the developer
 * picks the provider again in `/statusline`. So nothing leaves this client that has not passed the
 * same checks here first (`validTree`), and the same checks are made on a tree another provider
 * hands us before it goes anywhere near ours (`codex-chain.ts`).
 *
 * The rules are Codex 0.171.0's, read from `codex-rs/tui/src/ui_tree.rs` and `ui_tree/decode.rs`
 * at `rust-v0.171.0` and checked against the running program.
 */

/** A colour Codex names: its theme's, a terminal's, one of its own footer roles, or `#RRGGBB`. */
type TreeColor = string;

interface TextProps {
  readonly color?: TreeColor;
  readonly weight?: "normal" | "bold";
  readonly italic?: boolean;
  readonly underline?: boolean;
}

/** One element of a tree. A string is literal text. */
export type UiNode =
  | string
  | { readonly type: "text"; readonly props?: TextProps; readonly children: readonly UiNode[] }
  | {
      readonly type: "link";
      readonly props: { readonly href: string };
      readonly children: readonly UiNode[];
    }
  | {
      readonly type: "row";
      readonly props: { readonly gap: number; readonly wrap?: "wrap" | "nowrap" };
      readonly children: readonly UiNode[];
    }
  | { readonly type: "bold" | "italic" | "underline"; readonly children: readonly UiNode[] };

/** Codex's limits on one tree. */
const MAX_JSON_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_NODES = 256;
const MAX_DEPTH = 16;
const MAX_HREF_BYTES = 8 * 1024;
const MAX_GAP = Number.MAX_SAFE_INTEGER;

const NAMED_COLORS = new Set([
  "primary",
  "surface",
  "accent",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "status-model",
  "status-path",
  "status-branch",
  "status-state",
  "status-usage",
  "status-limit",
  "status-metadata",
  "status-mode",
  "status-thread",
  "status-progress",
]);

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// oxlint-disable-next-line no-control-regex -- control characters are exactly what is being looked for
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * Whether Codex will take `href` as a link's address.
 *
 * Its rule (`web_destination` in `terminal_hyperlinks.rs`): at most 8 KiB, no control character,
 * and a URL that parses with an `http` or `https` scheme and a host.
 */
export function validHref(href: string): boolean {
  if (utf8Bytes(href) > MAX_HREF_BYTES || CONTROL.test(href)) return false;
  try {
    const url = new URL(href);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validColor(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && (NAMED_COLORS.has(value) || /^#[0-9A-Fa-f]{6}$/u.test(value));
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "boolean";
}

function validTextProps(props: unknown): boolean {
  if (props === undefined) return true;
  if (!isRecord(props) || !onlyKeys(props, ["color", "weight", "italic", "underline"])) {
    return false;
  }
  const weight = props["weight"];
  return (
    validColor(props["color"]) &&
    (weight === undefined || weight === null || weight === "normal" || weight === "bold") &&
    optionalBoolean(props["italic"]) &&
    optionalBoolean(props["underline"])
  );
}

function validLinkProps(props: unknown): boolean {
  if (!isRecord(props) || !onlyKeys(props, ["href", "title"])) return false;
  const title = props["title"];
  const href = props["href"];
  return (
    typeof href === "string" &&
    validHref(href) &&
    (title === undefined || title === null || typeof title === "string")
  );
}

function validRowProps(props: unknown): boolean {
  if (!isRecord(props) || !onlyKeys(props, ["gap", "background", "wrap"])) return false;
  const gap = props["gap"];
  const wrap = props["wrap"];
  return (
    typeof gap === "number" &&
    Number.isInteger(gap) &&
    gap >= 0 &&
    gap <= MAX_GAP &&
    validColor(props["background"]) &&
    (wrap === undefined || wrap === "wrap" || wrap === "nowrap")
  );
}

/** Whether one element, its children aside, is one Codex reads. */
function validElement(node: Record<string, unknown>): boolean {
  if (!Array.isArray(node["children"])) return false;
  switch (node["type"]) {
    case "text":
      return onlyKeys(node, ["type", "props", "children"]) && validTextProps(node["props"]);
    case "link":
      return onlyKeys(node, ["type", "props", "children"]) && validLinkProps(node["props"]);
    case "row":
      return onlyKeys(node, ["type", "props", "children"]) && validRowProps(node["props"]);
    case "bold":
    case "italic":
    case "underline":
      return onlyKeys(node, ["type", "children"]);
    default:
      return false;
  }
}

/**
 * Whether Codex will draw `tree`, by its own rules: every element one it knows with only the
 * fields it knows, at most 256 elements, 16 levels below the root, 16 KiB of text and 64 KiB of
 * JSON. `null` is a tree too, and means an empty footer.
 *
 * Walked with a list rather than by recursion, so a tree made deep on purpose is refused at its
 * seventeenth level and not at the bottom of this process's stack.
 */
export function validTree(tree: unknown): tree is UiNode | null {
  if (tree === null) return true;
  let nodes = 0;
  let text = 0;
  const pending: { node: unknown; depth: number }[] = [{ node: tree, depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const { node, depth } = next;
    if (depth > MAX_DEPTH) return false;
    nodes += 1;
    if (nodes > MAX_NODES) return false;
    if (typeof node === "string") {
      text += utf8Bytes(node);
      if (text > MAX_TEXT_BYTES) return false;
      continue;
    }
    if (!isRecord(node) || !validElement(node)) return false;
    for (const child of node["children"] as unknown[]) {
      // A null child is allowed, counts for nothing, and is skipped, as Codex skips it.
      if (child !== null) pending.push({ node: child, depth: depth + 1 });
    }
  }
  try {
    return utf8Bytes(JSON.stringify(tree)) <= MAX_JSON_BYTES;
  } catch {
    return false;
  }
}

/** Text as it may go in a leaf: one line, with nothing a terminal would act on. */
export function leafText(text: string): string {
  return text.replaceAll(new RegExp(CONTROL.source, "gu"), " ");
}

/** One run of a line, as `obrigado statusline --json` writes it. */
interface LineSpan {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly color?: string;
  readonly link?: boolean;
}

/** One line from the renderer: a sponsored line, or a notice of Obrigado's own (A30). */
export interface RenderedLine {
  /** The disclosure, or null where the developer turned it off (A34). */
  readonly label: string | null;
  readonly url: string;
  readonly spans: readonly LineSpan[];
  /** The line's own colour, for a run that names none. `default` is the host's foreground. */
  readonly style: string;
  readonly effect: string;
}

/** The four colours a creative may wear, which Codex names as a terminal does. */
const SPAN_COLORS = new Set(["cyan", "blue", "green", "magenta"]);

function spanFrom(value: unknown): LineSpan | null {
  if (!isRecord(value)) return null;
  const text = value["text"];
  if (typeof text !== "string" || text.length === 0) return null;
  const color = value["color"];
  return {
    text,
    ...(value["bold"] === true ? { bold: true } : {}),
    ...(value["italic"] === true ? { italic: true } : {}),
    ...(typeof color === "string" && SPAN_COLORS.has(color) ? { color } : {}),
    ...(value["link"] === true ? { link: true } : {}),
  };
}

/**
 * One `--json` line from the renderer, or null for anything that is not a whole line.
 *
 * The same reading `@obrigado/surface` gives the hosts that draw their own UI: copy and URL or
 * nothing, the label null only when the renderer says so, and a line with no runs drawn as one
 * link over its copy. Kept here rather than imported because the client does not depend on that
 * package: the renderer is on the other side of this parse, in the same binary.
 */
export function parseRenderedLine(line: string): RenderedLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { label, copy, url, spans, style, effect } = parsed;
  if (typeof copy !== "string" || copy.length === 0) return null;
  if (typeof url !== "string" || url.length === 0) return null;
  const runs = Array.isArray(spans)
    ? spans.map((span) => spanFrom(span)).filter((span) => span !== null)
    : [];
  return {
    label: typeof label === "string" && label.length > 0 ? label : null,
    url,
    spans: runs.length > 0 ? runs : [{ text: copy, link: true }],
    style: typeof style === "string" && SPAN_COLORS.has(style) ? style : "default",
    effect: effect === "italic" ? "italic" : "none",
  };
}

/** One run as a tree element: plain text where it has no styling of its own. */
function spanNode(span: LineSpan, line: RenderedLine): UiNode {
  const text = leafText(span.text);
  const color = span.color ?? (line.style === "default" ? undefined : line.style);
  const italic = span.italic === true || line.effect === "italic";
  if (color === undefined && span.bold !== true && !italic) return text;
  return {
    type: "text",
    props: {
      ...(color === undefined ? {} : { color }),
      ...(span.bold === true ? { weight: "bold" as const } : {}),
      ...(italic ? { italic: true } : {}),
    },
    children: [text],
  };
}

/**
 * Our line as one element of the footer: the label, then the copy.
 *
 * The label is a bare string before the link and outside it (§3), so it takes no colour of the
 * advertiser's and cannot be clicked. The runs the renderer marked as the link go in one `link`
 * element each time they are side by side; Codex draws that as a real terminal hyperlink,
 * underlined. A URL Codex would refuse draws the copy with no link, since a refused link is a
 * refused footer. What Codex's tree cannot draw, reverse video, strike and dim, is left off, as
 * every host leaves off what it cannot draw.
 *
 * One inline `text` element holds all of it. Codex trims the spaces at the edges of a row's
 * children, so a label and copy laid side by side in a row would lose the spaces of ` · `; inside
 * one run of text they are kept.
 */
export function lineNode(line: RenderedLine): UiNode {
  const linkable = validHref(line.url);
  const children: UiNode[] = [];
  if (line.label !== null) children.push(`${leafText(line.label)} · `);

  let linked: UiNode[] = [];
  const closeLink = (): void => {
    if (linked.length === 0) return;
    children.push({ type: "link", props: { href: line.url }, children: linked });
    linked = [];
  };
  for (const span of line.spans) {
    const node = spanNode(span, line);
    if (span.link === true && linkable) {
      linked.push(node);
    } else {
      closeLink();
      children.push(node);
    }
  }
  closeLink();
  return { type: "text", children };
}

/**
 * The whole footer: the developer's, then ours.
 *
 * A wrapping row, so ours sits on the same line where the terminal is wide enough and on the next
 * where it is not, and theirs is never the one that moves. Codex shows three lines of footer and
 * cuts the rest, so in a narrow terminal with a long footer of the developer's it is ours that is
 * cut, which is the right one.
 *
 * Checked before it is returned. Ours is dropped where the two together would be refused, and
 * theirs alone is returned as it is: a tree of theirs that Codex would refuse is one their own
 * provider would have been refused for, and is the caller's to check first.
 */
export function footerTree(theirs: UiNode | null, ours: UiNode | null): UiNode | null {
  if (ours === null) return theirs;
  const both: UiNode =
    theirs === null
      ? ours
      : { type: "row", props: { gap: 2, wrap: "wrap" }, children: [theirs, ours] };
  return validTree(both) ? both : theirs;
}
