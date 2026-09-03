/**
 * What a host that draws its own UI needs from the renderer, and nothing else.
 *
 * INVARIANT 13: there is one renderer, and every host serialises from it. A host package —
 * the OpenCode plugin, the VS Code extension — runs `obrigado statusline --json` and composes
 * the parts it is handed with its own primitives. It never fetches, counts or formats an ad.
 * That boundary is what keeps "always labeled" a property rather than a convention, and it is
 * why host packages import nothing from `@obrigado/shared`: the wire contract, the money and
 * the rotation are the renderer's business.
 *
 * What the hosts DID each carry was a copy of the same three things — the shape of one `--json`
 * line, the checks that decide whether a line is complete enough to draw, and the splitting of
 * a configured command into an argv. Three copies drift: the palette had reached five spellings,
 * and every copy of the argv split broke on a path with a space in it. This package is those
 * three things, once, with no dependencies and no I/O. It speaks no HTTP and reads no file, so
 * depending on it changes nothing about what a host is allowed to do.
 *
 * The Pi extension does not depend on it, deliberately: that file is COPIED into a developer's
 * extensions directory and must stand alone. It keeps its own copy of `splitCommand`, and a test
 * in its package holds the two to the same behaviour.
 */

/**
 * The four colours a creative may wear. Never red or yellow: in a terminal those mean error
 * and warning, and an ad wearing either is impersonating a build failure. This is the one
 * copy the hosts see; `@obrigado/shared`'s contract is the other, and a test in the client
 * package holds the two together.
 */
export const SPAN_COLORS = ["cyan", "blue", "green", "magenta"] as const;
export type SpanColor = (typeof SPAN_COLORS)[number];

/** Line-level colour slot; `default` means the host's own foreground. */
export const LINE_STYLES = ["default", ...SPAN_COLORS] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

/** Line-level effect. Nothing louder than italic is offered, so nothing louder is drawn. */
export const LINE_EFFECTS = ["none", "italic"] as const;
export type LineEffect = (typeof LINE_EFFECTS)[number];

function isLineStyle(value: unknown): value is LineStyle {
  return typeof value === "string" && (LINE_STYLES as readonly string[]).includes(value);
}

function isLineEffect(value: unknown): value is LineEffect {
  return typeof value === "string" && (LINE_EFFECTS as readonly string[]).includes(value);
}

/** A run of styled text, as the renderer serialises it. */
export interface SponsoredSpan {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** Reverse video in a terminal; a host with no such thing ignores it. */
  readonly highlight?: boolean;
  /** One of the four slots an advertiser may choose. */
  readonly color?: SpanColor;
  /** Part of the single tracking link whose URL is `Sponsored.url`. */
  readonly link?: boolean;
}

/** Who is paying, as they name themselves. */
export interface SponsoredBrand {
  readonly name: string;
  /** A `data:image/png;base64,…` URI built server-side from validated bytes, or null. Never a URL. */
  readonly logo: string | null;
}

/** One `--json` line from `obrigado statusline`. */
export interface Sponsored {
  /** The disclosure. A host renders it before the copy, always, and never styles it. */
  readonly label: string;
  /** The plain copy: the accessible fallback, and the form that belongs in a log. */
  readonly copy: string;
  /** The click redirect, `https://obrigado.dev/c/<token>`. */
  readonly url: string;
  readonly spans: readonly SponsoredSpan[];
  readonly style: LineStyle;
  readonly effect: LineEffect;
  readonly brand: SponsoredBrand | null;
}

/**
 * One line of `--json` output, or null for anything that is not a complete sponsored line.
 *
 * Label, copy and URL, or nothing: a creative without its label is an undisclosed
 * advertisement, and one without its URL is an impression nobody can act on. Styling is
 * optional on the wire — an older renderer that sends none still renders, as one unstyled link
 * over the whole line. A brand without a name is not a brand; the alt text for a logo IS the
 * name, so a malformed one is dropped rather than rendered half-way.
 */
export function parseSponsored(line: string): Sponsored | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { label, copy, url, spans, style, effect, brand } = parsed as Partial<Sponsored>;
  if (typeof label !== "string" || typeof copy !== "string" || typeof url !== "string") {
    return null;
  }
  if (label.length === 0 || copy.length === 0 || url.length === 0) return null;

  return {
    label,
    copy,
    url,
    spans: Array.isArray(spans) && spans.length > 0 ? spans : [{ text: copy, link: true }],
    // A slot or effect this copy does not know is drawn as none: a newer renderer's colour
    // must degrade to the host's foreground, never to a string the host cannot parse.
    style: isLineStyle(style) ? style : "default",
    effect: isLineEffect(effect) ? effect : "none",
    brand:
      brand !== null && brand !== undefined && typeof brand.name === "string"
        ? { name: brand.name, logo: typeof brand.logo === "string" ? brand.logo : null }
        : null,
  };
}

/**
 * A configured command, split the way a shell would split it — quotes and all.
 *
 * `OBRIGADO_STATUSLINE_COMMAND` exists so a host can run a source checkout, and a checkout
 * lives at a path. Splitting on spaces broke the moment that path contained one: `bun
 * "/Users/Jane Doe/obrigado/cli.ts" statusline` became four arguments and the spawn failed
 * silently. Double quotes, single quotes and backslash escapes are honoured; nothing else is
 * interpreted — no variables, no globs, no operators — because this is a command, not a script.
 */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && quote === '"' && index + 1 < text.length) {
        index += 1;
        current += text[index] ?? "";
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inToken = true;
    } else if (character === "\\" && index + 1 < text.length) {
      index += 1;
      current += text[index] ?? "";
      inToken = true;
    } else if (/\s/u.test(character)) {
      if (inToken) out.push(current);
      current = "";
      inToken = false;
    } else {
      current += character;
      inToken = true;
    }
  }
  if (inToken) out.push(current);
  return out;
}

/**
 * The argv a host spawns to get its line.
 *
 * `obrigado` from PATH is the installed case. An override — a setting, an environment
 * variable — replaces the executable and its leading arguments and keeps everything after:
 * the host names itself so the impression attributes to it, and asks for `--json` because it
 * draws with its own primitives rather than printing an ANSI string.
 */
export function statuslineArgv(
  agent: string,
  override?: string | undefined,
  options: { readonly json?: boolean } = {},
): string[] {
  const configured = override?.trim() ?? "";
  const base = configured.length > 0 ? splitCommand(configured) : ["obrigado", "statusline"];
  return [...base, "--agent", agent, ...(options.json === false ? [] : ["--json"])];
}
