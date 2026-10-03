/**
 * The sponsored line as a tree of Claude Code's own elements.
 *
 * Apart from the hooks module so it can be tested without Claude Code: it takes the element
 * constructors `$.ui.resolve(e)` hands a render hook and returns whatever they build, so a test
 * passes constructors that build plain objects and reads the tree back.
 *
 * The rules are the OpenCode plugin's, because they are the same rules: the disclosure first,
 * unstyled and outside the link; the advertiser's palette on the runs and nowhere else;
 * underline exactly where the text is a link.
 */
import type { Sponsored, SponsoredSpan } from "./surface.ts";

/** The `Text` props this row uses, a subset of the engine's allowlist. */
export interface TextProps<Node> {
  readonly color?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
  readonly wrap?: "truncate-end";
  readonly children: readonly (Node | string)[];
}

/** `Link` is inline: its children are the text it draws. */
export interface LinkProps<Node> {
  readonly href: string;
  readonly children: readonly (Node | string)[];
}

/** A row of the row's parts, when there is a mark to set between them. */
export interface BoxProps<Node> {
  readonly flexDirection: "row" | "column";
  readonly alignItems?: "center";
  readonly children: readonly Node[];
}

/** The app's vector leaf, drawn as an image with scripts stripped. */
export interface SvgProps {
  readonly source: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

export interface RowElements<Node> {
  readonly Text: (props: TextProps<Node>) => Node;
  readonly Link: (props: LinkProps<Node>) => Node;
  readonly Box: (props: BoxProps<Node>) => Node;
  /** Absent where the surface cannot draw one, and then the row has no mark. */
  readonly Svg?: ((props: SvgProps) => Node) | undefined;
}

/**
 * The only mark drawn: a PNG data URI, as `@obrigado/shared`'s contract sends it and at no more
 * than the 6,000 characters it allows. Nothing but base64 can then reach the SVG's markup, so
 * the attribute it sits in cannot be closed early.
 */
const MARK = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u;
const MARK_MAX = 6000;

/** The mark's height, in CSS pixels: the height of the row's type. */
const MARK_PX = 16;

/**
 * The mark's width at `MARK_PX` high, from the PNG's own header.
 *
 * The icon slot is square in practice — the server converts every upload and favicon to a square
 * — but nothing here should depend on that holding: a mark drawn into the wrong box is a
 * squashed logo in somebody's editor. Its width and height are bytes 16 to 23 of the file, which
 * are the first 32 characters of base64 after the prefix.
 */
function markWidth(dataUri: string): number {
  const head = fromBase64(dataUri.slice(dataUri.indexOf(",") + 1).slice(0, 32));
  // The top byte multiplied rather than shifted, so a width past 2^31 stays positive.
  const read = (at: number): number =>
    (head[at] ?? 0) * 0x1000000 +
    ((head[at + 1] ?? 0) << 16) +
    ((head[at + 2] ?? 0) << 8) +
    (head[at + 3] ?? 0);
  const [width, height] = [read(16), read(20)];
  if (width === 0 || height === 0) return MARK_PX;
  return Math.min(MARK_PX * 4, Math.max(1, Math.round((MARK_PX * width) / height)));
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 to bytes, by hand: a hooks module is promised the web's APIs, not which ones. */
function fromBase64(text: string): number[] {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const digit = BASE64.indexOf(char);
    if (digit === -1) break;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return bytes;
}

/**
 * The brand's square mark, or null.
 *
 * The icon, not the logo: the logo slot holds a wordmark strip sized for a hover, and a line of
 * type wants a mark beside it. Wrapped in an SVG because the app's only picture element is
 * `Svg`, and an SVG drawn as an image may carry a `data:` raster inside it. The alt is the brand's
 * name, so a mark that does not draw still says who is paying, as the VS Code extension's does.
 */
function mark<Node>(ad: Sponsored, elements: RowElements<Node>): Node | null {
  const { brand } = ad;
  const icon = brand?.icon;
  if (elements.Svg === undefined || brand === null || typeof icon !== "string") return null;
  if (icon.length > MARK_MAX || !MARK.test(icon)) return null;
  const width = markWidth(icon);
  return elements.Svg({
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${MARK_PX}" ` +
      `viewBox="0 0 ${width} ${MARK_PX}"><image href="${icon}" width="${width}" ` +
      `height="${MARK_PX}"/></svg>`,
    alt: brand.name,
    width,
    height: MARK_PX,
  });
}

type RunStyle = Omit<TextProps<never>, "children" | "wrap">;

/**
 * One run's attributes, in the engine's vocabulary.
 *
 * `highlight` is reverse video rather than a background colour, for the reason the OpenCode
 * plugin gives: reverse swaps the reader's own colours, so it cannot render unreadably against
 * a theme nobody here can see. The engine calls it `inverse`, as Ink does.
 */
function runStyle(span: SponsoredSpan, ad: Sponsored): RunStyle {
  const color = span.color ?? (ad.style === "default" ? undefined : ad.style);
  return {
    ...(color === undefined ? {} : { color }),
    ...(span.bold === true ? { bold: true } : {}),
    ...(span.italic === true || ad.effect === "italic" ? { italic: true } : {}),
    ...(span.highlight === true ? { inverse: true } : {}),
    ...(span.link === true ? { underline: true } : {}),
  };
}

/**
 * The row: one line, truncated rather than wrapped, so it never takes a second row of the band
 * that other mods share. With a mark, the disclosure, the mark and the copy in that order: the
 * label still comes first and still sits outside the link, and the mark is not a link either.
 *
 * Consecutive link runs become ONE `Link`, as the terminal renderer wraps them in one OSC 8. It
 * matters more here than there: where a terminal cannot draw OSC 8, the engine draws a link's
 * text and then its URL, and a link per run would print the URL once per run.
 */
export function sponsoredRow<Node>(ad: Sponsored, elements: RowElements<Node>): Node {
  const label = ad.label === null ? null : `${ad.label} · `;
  const logo = mark(ad, elements);
  // The copy's own text: the label leads it when there is no mark to put between them.
  const children: (Node | string)[] = logo === null && label !== null ? [label] : [];
  if (logo !== null) children.push(" ");

  let linked: Node[] = [];
  const closeLink = (): void => {
    if (linked.length === 0) return;
    children.push(elements.Link({ href: ad.url, children: linked }));
    linked = [];
  };

  for (const span of ad.spans) {
    const run = elements.Text({ ...runStyle(span, ad), children: [span.text] });
    if (span.link === true) {
      linked.push(run);
    } else {
      closeLink();
      children.push(run);
    }
  }
  closeLink();

  const copy = elements.Text({ wrap: "truncate-end", children });
  if (logo === null) return copy;
  return elements.Box({
    flexDirection: "row",
    alignItems: "center",
    children: label === null ? [logo, copy] : [elements.Text({ children: [label] }), logo, copy],
  });
}
