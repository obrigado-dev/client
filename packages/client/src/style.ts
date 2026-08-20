/**
 * Creative styling — a fixed palette, chosen by the advertiser, overridden by
 * the developer.
 *
 * Three rules shape everything here, and they follow from §3's "always labeled":
 *
 * 1. **The advertiser picks a slot, never a colour.** They choose from an enum;
 *    they cannot send raw ANSI. Free-form styling is how ad copy impersonates
 *    system output — see the control-character rejection in the wire contract.
 *
 * 2. **The palette contains no alert colours.** Red and yellow are excluded on
 *    purpose: in a terminal they mean error and warning. An ad rendered in red
 *    is impersonating a build failure, which is the same attack as injecting
 *    escape bytes, just through a channel we sanctioned. Bold, reverse, blink
 *    and background colours are excluded for the same family of reasons — they
 *    would make the copy louder than the `sponsored` label that discloses it.
 *
 * 3. **The basic 8 colour slots, never 256-colour or truecolor.** This is what
 *    makes "respect the developer's existing setup" real rather than a claim:
 *    `ESC[36m` renders in *their* cyan, as their terminal theme defines it. A
 *    hardcoded hex would override the palette they chose.
 *
 * The developer wins over all of it: `NO_COLOR`, a terminal that cannot do
 * colour, or `color: "off"` in `~/.obrigado/config.json` produces plain text.
 */

/** Text effects an advertiser may select. */
export const CREATIVE_EFFECTS = ["none", "italic"] as const;

export type CreativeEffect = (typeof CREATIVE_EFFECTS)[number];

export function isCreativeEffect(value: string): value is CreativeEffect {
  return (CREATIVE_EFFECTS as readonly string[]).includes(value);
}

/** Foreground slots an advertiser may select. */
export const CREATIVE_STYLES = ["default", "cyan", "blue", "green", "magenta"] as const;

export type CreativeStyle = (typeof CREATIVE_STYLES)[number];

export function isCreativeStyle(value: string): value is CreativeStyle {
  return (CREATIVE_STYLES as readonly string[]).includes(value);
}

const ESC = "\u001B";
const RESET_FOREGROUND = `${ESC}[39m`;
const ITALIC = `${ESC}[3m`;
const RESET_ITALIC = `${ESC}[23m`;
const UNDERLINE = `${ESC}[4m`;
const RESET_UNDERLINE = `${ESC}[24m`;

/**
 * Basic-slot foreground codes. 30–37 rather than 90–97 (bright) or 38;5;N
 * (256-colour): the basic slots are the ones a terminal theme remaps.
 */
const FOREGROUND: Record<Exclude<CreativeStyle, "default">, string> = {
  cyan: `${ESC}[36m`,
  blue: `${ESC}[34m`,
  green: `${ESC}[32m`,
  magenta: `${ESC}[35m`,
};

interface ColorEnvironment {
  readonly NO_COLOR?: string | undefined;
  readonly FORCE_COLOR?: string | undefined;
  readonly TERM?: string | undefined;
  readonly COLORTERM?: string | undefined;
  readonly TERM_PROGRAM?: string | undefined;
}

type AnyEnvironment = ColorEnvironment & Record<string, string | undefined>;

/**
 * Whether to emit colour at all.
 *
 * Deliberately does NOT check `process.stdout.isTTY`. That is the usual gate and
 * it is wrong here: Claude Code "captures your script's output instead of
 * connecting it directly to the terminal", so stdout is a pipe on every render
 * and a TTY check would disable colour permanently.
 */
export function supportsColor(
  env: AnyEnvironment = process.env,
  preference: "auto" | "off" = "auto",
): boolean {
  // The developer's explicit choice, in ~/.obrigado/config.json.
  if (preference === "off") return false;

  // https://no-color.org — any non-empty value disables colour.
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;

  const forceColor = env.FORCE_COLOR;
  if (forceColor !== undefined && forceColor !== "" && forceColor !== "0") return true;

  const term = env.TERM;
  if (term === undefined || term === "dumb") return false;

  return (
    env.COLORTERM !== undefined ||
    env.TERM_PROGRAM !== undefined ||
    /color|256|xterm|screen|tmux|rxvt|vt100|ansi|alacritty|kitty|ghostty/u.test(term)
  );
}

/**
 * Apply a creative's style to already-sanitised copy.
 *
 * Emits only a foreground slot and a foreground reset — never a full `ESC[0m`,
 * which would also clear any styling Claude Code applied to the row and could
 * leave the rest of the status line looking different from how the developer
 * configured it. Resetting exactly what we set is the difference between
 * styling our line and editing theirs.
 */
export function applyStyle(
  copy: string,
  style: CreativeStyle,
  env: AnyEnvironment = process.env,
  preference: "auto" | "off" = "auto",
): string {
  if (style === "default") return copy;
  if (!supportsColor(env, preference)) return copy;

  return `${FOREGROUND[style]}${copy}${RESET_FOREGROUND}`;
}

/**
 * Apply an effect. Italic only — see `CREATIVE_EFFECTS` for why not bold.
 *
 * Gated on the same capability check as colour. A terminal that ignores `ESC[3m`
 * is harmless; one that renders it as reverse video is not, which is why this
 * rides the conservative allow-list rather than assuming support.
 */
export function applyEffect(
  copy: string,
  effect: CreativeEffect,
  env: AnyEnvironment = process.env,
  preference: "auto" | "off" = "auto",
): string {
  if (effect !== "italic") return copy;
  if (!supportsColor(env, preference)) return copy;

  return `${ITALIC}${copy}${RESET_ITALIC}`;
}

const BOLD = `${ESC}[1m`;
const RESET_BOLD = `${ESC}[22m`;
const REVERSE = `${ESC}[7m`;
const RESET_REVERSE = `${ESC}[27m`;

export interface SpanAttributes {
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly highlight?: boolean | undefined;
  readonly color?: "cyan" | "blue" | "green" | "magenta" | undefined;
}

/**
 * Apply one span's attributes to its text.
 *
 * Bold IS available per-span, where it is not available line-wide. The markup
 * validator caps how much of the copy may be emphasised, which is the §3
 * prominence rule stated as arithmetic: emphasising a word is emphasis, and
 * emphasising the whole line is amplification that drowns the `sponsored` label.
 *
 * Highlight is REVERSE VIDEO, not a background colour. Reverse swaps the
 * reader's own foreground and background, so it cannot render unreadably
 * against a theme we know nothing about; a hardcoded background can and does.
 *
 * Every attribute resets only itself (`[22m`, `[23m`, `[27m`, `[39m`) so a span
 * cannot clear styling that belongs to the rest of the line.
 */
export function spanAttributes(
  text: string,
  span: SpanAttributes,
  env: AnyEnvironment = process.env,
  preference: "auto" | "off" = "auto",
): string {
  if (!supportsColor(env, preference)) return text;

  let out = text;
  if (span.color !== undefined) out = `${FOREGROUND[span.color]}${out}${RESET_FOREGROUND}`;
  if (span.highlight === true) out = `${REVERSE}${out}${RESET_REVERSE}`;
  if (span.italic === true) out = `${ITALIC}${out}${RESET_ITALIC}`;
  if (span.bold === true) out = `${BOLD}${out}${RESET_BOLD}`;
  return out;
}

/**
 * Underline, as a truthful affordance for clickability.
 *
 * Deliberately NOT an advertiser choice. Underline means "this is a link" — so
 * it is applied exactly when the text really is one, and never otherwise. An
 * advertiser who could underline non-clickable copy would be using a link
 * affordance as an attention-grab, which is the same category of problem as
 * rendering an ad in error-red.
 */
export function underline(text: string): string {
  return `${UNDERLINE}${text}${RESET_UNDERLINE}`;
}
