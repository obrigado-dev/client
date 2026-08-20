/**
 * Clickable status-line text via OSC 8 terminal hyperlinks.
 *
 * §11 and §12 specify the click *data* path — `click_events`, `GET /c/:token`,
 * `creatives.click_url` — but never how a click happens in a terminal. This is
 * that missing half: OSC 8 is the documented mechanism, and Claude Code passes
 * the escape sequence through to the terminal.
 *
 *   ESC ] 8 ; ; URL BEL  text  ESC ] 8 ; ; BEL
 *
 * Cmd+click on macOS, Ctrl+click elsewhere.
 *
 * The hard constraint: a terminal that does NOT support OSC 8 renders the
 * escape bytes as visible garbage in the developer's status line. That is worse
 * than an unclickable ad, so support is opt-in by detection, never assumed.
 */

/**
 * Terminals with known OSC 8 support.
 *
 * An allow-list, not a deny-list: an unknown terminal gets plain text. Being
 * wrong in that direction costs a click; being wrong the other way puts
 * `\e]8;;https://…` in someone's terminal and gets the tool uninstalled.
 */
const SUPPORTED_TERM_PROGRAMS = new Set([
  "iTerm.app",
  "WezTerm",
  "ghostty",
  "vscode",
  "Hyper",
  "rio",
  "Tabby",
  "wayst",
  "foot",
]);

interface LinkEnvironmentVars {
  readonly TERM_PROGRAM?: string | undefined;
  readonly TERM?: string | undefined;
  readonly KITTY_WINDOW_ID?: string | undefined;
  readonly WT_SESSION?: string | undefined;
  readonly VTE_VERSION?: string | undefined;
  readonly KONSOLE_VERSION?: string | undefined;
  readonly DOMTERM?: string | undefined;
  readonly OBRIGADO_HYPERLINKS?: string | undefined;
}

/** Accepts `process.env` (which carries an index signature) or a test literal. */
export type LinkEnvironment = LinkEnvironmentVars & Record<string, string | undefined>;

/** Whether to emit OSC 8 sequences in this environment. */
export function supportsHyperlinks(env: LinkEnvironment = process.env): boolean {
  // An explicit override wins in both directions — useful for a terminal we
  // have not heard of, and for turning it off if a rendering bug appears.
  const override = env.OBRIGADO_HYPERLINKS;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;

  // A dumb or absent terminal never gets escape sequences.
  if (env.TERM === "dumb" || env.TERM === undefined) return false;

  if (env.TERM_PROGRAM !== undefined && SUPPORTED_TERM_PROGRAMS.has(env.TERM_PROGRAM)) return true;

  // kitty, Windows Terminal, DomTerm and Konsole announce themselves this way.
  if (env.KITTY_WINDOW_ID !== undefined) return true;
  if (env.WT_SESSION !== undefined) return true;
  if (env.DOMTERM !== undefined) return true;
  if (env.KONSOLE_VERSION !== undefined) return true;

  // VTE (GNOME Terminal, Tilix) gained OSC 8 in 0.50.
  const vte = env.VTE_VERSION;
  if (vte !== undefined && /^\d+$/u.test(vte) && Number(vte) >= 5000) return true;

  return false;
}

const ESC = "\u001B";
const BEL = "\u0007";

/**
 * Strip control characters from text destined for the terminal.
 *
 * The last line of defence for §3's "always labeled". `ESC [ 2K` erases the
 * line and `ESC [ 1G` returns the cursor to column one, so ad copy containing
 * them would delete the `sponsored` label written immediately before it. The
 * server rejects such copy at ingest and the database has a CHECK, but the
 * client must not write bytes to a developer's terminal on the strength of a
 * server response being well-behaved.
 *
 * Stripped rather than rejected HERE, unlike at ingest: by this point the only
 * options are "render something safe" or "render nothing", and silently losing
 * the developer's status line is the worse of the two.
 */
export function stripControlCharacters(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    out += character;
  }
  return out;
}

/**
 * Wrap `text` in an OSC 8 hyperlink, or return it unchanged when the terminal
 * cannot render one.
 *
 * The URL is validated to an http(s) scheme first. A status line is a place a
 * developer will Cmd+click without inspecting, so a `javascript:` or `file:`
 * target must be unrepresentable here, not merely unlikely — the server applies
 * the same allow-list in `sanitizeRedirect`.
 */
export function hyperlink(text: string, url: string, env: LinkEnvironment = process.env): string {
  if (!supportsHyperlinks(env)) return text;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return text;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return text;

  // A URL containing the terminator bytes could break out of the sequence and
  // inject arbitrary escape codes into the developer's terminal.
  const safeUrl = parsed.toString();
  if (safeUrl.includes(BEL) || safeUrl.includes(ESC)) return text;

  return `${ESC}]8;;${safeUrl}${BEL}${text}${ESC}]8;;${BEL}`;
}
