/**
 * Everything the extension renders, with none of the editor in it.
 *
 * `extension.ts` imports `vscode`, which only exists inside a running editor, so nothing
 * there can be tested. This module is the part worth testing: two renderings of the same
 * creative — status bar text and hover markdown — each into a target with its own injection
 * hazard and its own escaping rules.
 *
 * The rule they share: advertiser text is DATA in both. It becomes an escaped markdown run or
 * a stripped status string, and never a construct the host will interpret.
 */

export interface SponsoredSpan {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  // On the wire and deliberately not rendered here. The status bar has one colour for the
  // whole item and markdown has none, so a per-run palette has nowhere to land in an editor.
  // Kept because this type describes what ARRIVES, not what this host happens to use.
  readonly highlight?: boolean;
  readonly color?: "cyan" | "blue" | "green" | "magenta";
  readonly link?: boolean;
}

interface SponsoredBrand {
  readonly name: string;
  /** `data:image/png;base64,…`, built server-side from validated bytes. Never a URL. */
  readonly logo: string | null;
}

export interface Sponsored {
  readonly label: string;
  readonly copy: string;
  readonly url: string;
  readonly spans: readonly SponsoredSpan[];
  readonly style: string;
  readonly effect: string;
  readonly brand: SponsoredBrand | null;
}

/** Said once, rendered in the hover. */
const FOOTER = "70% of revenue funds the packages you depend on.";

/**
 * The mark, as a Codicon.
 *
 * The status bar's `text` understands `$(name)` and nothing else — no colour per run, no
 * weight, no underline — so this is the whole of what the glyph prototype can be here. It is
 * deliberately NOT one of the `~spin` variants: a spinning glyph in a status bar reads as
 * work in progress, and the animated version of this was already rejected in OpenCode for
 * looking like a loading timer.
 */
const GLYPH = "$(sparkle)";

/**
 * Advertiser text, made inert for a markdown hover.
 *
 * The hazard here is quieter than HTML injection and starts as a rendering bug: a creative
 * reading `NEON DA BEST~~~` renders as strikethrough, `**free**` renders bold nobody bought,
 * and a link construct in copy renders a LINK TO SOMEWHERE WE DID NOT SIGN — which walks
 * straight past the redirect that records the click and sanitises the destination.
 *
 * So every construct goes, not the subset that looks dangerous. The backslash is replaced
 * first; doing it later would escape the escapes.
 */
export function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(/[*_[\]()#+\-!~`>|{}.]/gu, (ch) => `\\${ch}`);
}

/**
 * Status bar text: glyph, label, copy — one string, in that order.
 *
 * One string and not two items. Two adjacent `StatusBarItem`s would allow the copy to carry
 * the creative's colour while the disclosure stayed neutral, which is tempting and wrong:
 * any extension whose priority falls between theirs would land BETWEEN the label and the ad
 * it labels. §3 wants no state in which the advertisement is visible and the disclosure is
 * not, and adjacency that another publisher can break is not that guarantee.
 */
export function statusText(ad: Sponsored): string {
  return `${GLYPH} ${stripCodicons(ad.label)} · ${stripCodicons(ad.copy)}`;
}

/**
 * `$(` is an icon in status bar text, so advertiser copy cannot be allowed to contain it.
 *
 * `$(error)` in a creative would otherwise paint the editor's own error icon into the status
 * bar — an advertiser drawing the host's chrome. Breaking the token is enough; the text stays
 * readable, which matters because this runs on copy nobody has reviewed for this hazard.
 */
export function stripCodicons(value: string): string {
  return value.replaceAll("$(", "$ (");
}

/**
 * The hover, which is the only rich surface here that costs no click.
 *
 * The status bar item can hold plain text and one Codicon. A hover happens where the eye
 * already is and renders real markdown, so bold, italic and the link survive here even though
 * they cannot in the item's own text. That is the whole of what this host can express.
 *
 * Colour does NOT survive, and is not faked. Markdown has no colour, the hover widget's
 * background is a theme token we do not control, and the alternative would be HTML in a
 * trusted string built partly from advertiser input.
 */
export function tooltipMarkdown(ad: Sponsored): string {
  const copy = ad.spans.map((span) => emphasise(span, ad)).join("");
  return [
    ...logoLine(ad.brand),
    `**${escapeMarkdown(ad.label)}**`,
    "",
    `[${copy}](${markdownUrl(ad.url)})`,
    "",
    `_${escapeMarkdown(FOOTER)}_`,
  ].join("\n");
}

/**
 * The brand mark, if there is one, as a markdown image.
 *
 * Verified empirically rather than assumed: a `data:` URI renders here, an `https:` URL is
 * fetched and rendered, and raw `<img>` HTML is stripped because `supportHtml` is off. Only
 * the first of those is acceptable — a remote URL would make every hover reach the
 * advertiser's origin from inside a developer's editor, handing them an IP address and an
 * activity signal nobody sold them.
 *
 * So this refuses anything that is not a PNG data URI, and the refusal is here rather than
 * only at the server because this is the last point before it reaches a renderer. The alt
 * text is the brand NAME, so a mark that fails to decode still says who is paying.
 */
function logoLine(brand: SponsoredBrand | null): readonly string[] {
  if (brand === null || brand.logo === null) return [];
  if (!brand.logo.startsWith(LOGO_PREFIX)) return [];
  // Only the payload alphabet, and nothing that could close the parenthesis and start
  // something else. A URI that fails this is dropped, not repaired.
  const payload = brand.logo.slice(LOGO_PREFIX.length);
  if (payload.length === 0 || !/^[A-Za-z0-9+/=]+$/u.test(payload)) return [];
  return [`![${escapeMarkdown(brand.name)}](${brand.logo})`, ""];
}

const LOGO_PREFIX = "data:image/png;base64,";

/** A run's emphasis, the subset of the terminal's styling that markdown can carry. */
function emphasise(span: SponsoredSpan, ad: Sponsored): string {
  const text = escapeMarkdown(span.text);
  const italic = span.italic === true || ad.effect === "italic";
  return `${span.bold === true ? "**" : ""}${italic ? "_" : ""}${text}${italic ? "_" : ""}${
    span.bold === true ? "**" : ""
  }`;
}

/**
 * A URL safe to sit inside a markdown link's parentheses.
 *
 * `encodeURI` leaves parentheses alone, and a single `)` anywhere in the token would end the
 * link early and spill the rest as text. Signed `/c/:token` URLs are base64url today, so this
 * has nothing to fix yet — which is exactly when it is cheap to make certain.
 */
function markdownUrl(url: string): string {
  return encodeURI(url).replaceAll("(", "%28").replaceAll(")", "%29");
}
