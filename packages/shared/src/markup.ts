/**
 * Inline markup for creative copy.
 *
 * An advertiser authors a short markup string; this parses it into a flat list
 * of typed spans. The SERVER parses at ingest and at serve time; the CLIENT
 * receives spans and never parses markup, so untrusted authoring syntax never
 * reaches a terminal renderer.
 *
 *   Postgres, but you never think about it — [**neon.tech**]
 *   {cyan:Type-safe} SQL for `TypeScript` — [kysely.dev]
 *
 * | Syntax          | Meaning                                             |
 * |-----------------|-----------------------------------------------------|
 * | `**text**`      | bold                                                |
 * | `_text_`        | italic                                              |
 * | `` `text` ``    | highlight (reverse video — uses the reader's colours)|
 * | `[text]`        | the tracking link; at most one per creative         |
 * | `{cyan:text}`   | colour, from the creative palette                   |
 * | `~~text~~`      | struck through, for a price that went down          |
 * | `{dim:text}`    | dimmed, for the part that matters less              |
 * | `\*`            | a literal marker character                          |
 *
 * ## Why the limits exist
 *
 * §3 requires the `sponsored` label never be less prominent than the ad. Bold
 * and highlight are allowed on *spans* because emphasising a word inside an
 * otherwise plain line is emphasis; applying them to the whole line is
 * amplification, and the disclosure loses. So emphasis is capped as a
 * PROPORTION of the copy rather than banned outright — which is the rule §3
 * actually implies, expressed in a way a parser can enforce.
 *
 * Highlight is reverse video rather than a background colour on purpose: it
 * inverts the reader's own foreground and background, so it cannot render
 * unreadably against a theme we know nothing about.
 *
 * At most ONE link, because `/c/:token` issues one token per impression. More
 * than one link would still bill correctly but would make "which part did they
 * click" unanswerable, and a click report nobody can interpret is worse than no
 * click report.
 */

import { isStatusSymbol } from "./status-symbols.ts";

/** Colours a span may use — the creative palette, minus the no-op. */
export const SPAN_COLORS = ["cyan", "blue", "green", "magenta"] as const;
export type SpanColor = (typeof SPAN_COLORS)[number];

/**
 * One styled run. The optional fields admit `undefined` so the wire's own spans, which zod
 * types that way, are spans too, and a renderer takes either without a conversion.
 */
export interface Span {
  readonly text: string;
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly highlight?: boolean | undefined;
  readonly color?: SpanColor | undefined;
  /**
   * Struck through and dimmed. Both make a run QUIETER, never louder, so neither counts
   * against the emphasis allowance below. Optional on the wire: a client older than them
   * drops the flag and draws the run plain, which is the right way for them to degrade.
   */
  readonly strike?: boolean | undefined;
  readonly dim?: boolean | undefined;
  /** Part of the single tracking link. */
  readonly link?: boolean | undefined;
}

/** The status-line budget, measured in VISIBLE characters — markup is free. */
export const MAX_VISIBLE_LENGTH = 80;

/** Emphasis (bold or highlight) may cover at most this share of the copy… */
export const MAX_EMPHASIS_RATIO = 0.5;

/**
 * …or this many characters, whichever is MORE permissive.
 *
 * A proportion alone refuses `[**neon.tech**]`, which is a legitimate creative:
 * a nine-character brand, entirely bold, does not drown a nine-character
 * `sponsored` label. The absolute floor is set near the label's own length so
 * short brand-only copy can be fully emphasised while forty characters of bold
 * prose still cannot.
 */
export const MAX_EMPHASIS_CHARS = 16;

/** A highlight longer than this stops being a highlight and becomes a banner. */
export const MAX_HIGHLIGHT_LENGTH = 16;

/** The most runs a line may have: the wire's `spans` bound. */
export const MAX_SPANS = 48;
const MAX_DEPTH = 3;

export interface ParseResult {
  readonly spans: readonly Span[];
  /** Visible text with all markup removed — what a reader actually sees. */
  readonly plain: string;
  readonly problems: readonly string[];
}

interface Active {
  bold: boolean;
  italic: boolean;
  highlight: boolean;
  strike: boolean;
  dim: boolean;
  link: boolean;
  color: SpanColor | undefined;
}

/**
 * Whether a character can move or erase what is drawn around it.
 *
 * Two families. C0/C1 control characters, which a terminal executes — `ESC [ 2K` erases the
 * line the `sponsored` label was just written on. And the Unicode bidirectional controls,
 * which a terminal RENDERS: an RLO or an isolate inside the copy reorders the row visually,
 * so the label can be made to read after the copy, or inside it, without a single control
 * byte. The `\p{Cc}` check every layer used to make caught the first family only. Zero-width
 * joiners are deliberately not here — emoji sequences need them and they reorder nothing.
 */
export function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  // Bidi: ALM, LRM/RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI.
  return (
    code === 0x06_1c ||
    code === 0x20_0e ||
    code === 0x20_0f ||
    (code >= 0x20_2a && code <= 0x20_2e) ||
    (code >= 0x20_66 && code <= 0x20_69)
  );
}

/** True when any character in `text` is one `isControlCharacter` names. */
export function hasControlCharacters(text: string): boolean {
  for (const character of text) if (isControlCharacter(character)) return true;
  return false;
}

function isControl(character: string): boolean {
  return isControlCharacter(character);
}

/**
 * Parse markup into spans.
 *
 * Never throws and never returns partial nonsense: on malformed input it
 * reports problems and returns the copy it could make sense of, so a caller can
 * choose between rejecting (the API does) and rendering something safe.
 */
/** Toggleable attributes and the marker that opens or closes each. */
const TOGGLES = [
  { marker: "**", key: "bold" },
  { marker: "_", key: "italic" },
  { marker: "`", key: "highlight" },
  { marker: "~~", key: "strike" },
] as const;

type ToggleKey = (typeof TOGGLES)[number]["key"];

function matchToggle(source: string, index: number): (typeof TOGGLES)[number] | undefined {
  return TOGGLES.find((entry) => source.startsWith(entry.marker, index));
}

/**
 * A single-pass parser over the markup.
 *
 * A class rather than one long function so each marker's handling reads on its
 * own — this code decides how an advertisement is drawn in someone's terminal,
 * and "what does this branch do" should never require holding 100 lines in mind.
 */
class Parser {
  readonly #source: string;
  readonly #spans: Span[] = [];
  readonly #problems: string[] = [];
  readonly #openers: string[] = [];
  /** The open `{…:` groups, innermost last: a `}` closes the latest. */
  readonly #braces: Array<"color" | "dim"> = [];
  readonly #statusSymbols = new Set<string>();
  readonly #active: Active = {
    bold: false,
    italic: false,
    highlight: false,
    strike: false,
    dim: false,
    link: false,
    color: undefined,
  };

  #buffer = "";
  #linkCount = 0;
  #index = 0;

  constructor(source: string) {
    this.#source = source;
  }

  run(): ParseResult {
    while (this.#index < this.#source.length) this.#step();
    this.#flush();
    this.#finalise();

    const plain = this.#spans.map((span) => span.text).join("");
    return {
      spans: this.#spans,
      plain,
      problems: [
        ...this.#problems,
        ...[...this.#statusSymbols].map(
          (symbol) =>
            `"${symbol}" reads as a status indicator (a result, a warning or something running), ` +
            "and an ad must not look like the developer's own tools — try → or ★",
        ),
        ...proportionProblems(this.#spans, plain),
      ],
    };
  }

  #step(): void {
    // By code point, so a symbol outside the BMP is one character to the checks below.
    const character = String.fromCodePoint(this.#source.codePointAt(this.#index) ?? 0);

    if (character === "\\") return this.#escape();
    if (isControl(character)) {
      this.#problems.push("copy must not contain control characters");
      this.#index += 1;
      return;
    }

    const toggle = matchToggle(this.#source, this.#index);
    if (toggle !== undefined && this.#opensOrCloses(toggle.key, toggle.marker)) {
      this.#flush();
      this.#toggle(toggle.key, toggle.marker);
      this.#index += toggle.marker.length;
      return;
    }

    if (character === "[") return this.#openLink();
    if (character === "]") return this.#closeLink();
    if (character === "{") return this.#openBrace();
    if (character === "}" && this.#braces.length > 0) return this.#closeBrace();

    if (isStatusSymbol(character)) this.#statusSymbols.add(character);
    this.#buffer += character;
    this.#index += character.length;
  }

  /** An escape makes the next character literal. */
  #escape(): void {
    const next = this.#source[this.#index + 1];
    if (next !== undefined && !isControl(next)) this.#buffer += next;
    this.#index += next === undefined ? 1 : 2;
  }

  /**
   * Whether a marker here is markup rather than text.
   *
   * Every marker is, except a strike that nothing closes. `~~` came after copy already existed,
   * and copy like `NEON DA BEST~~~` was never written as markup: read as an opener it would
   * have struck the rest of the line out, or been refused as unclosed.
   */
  #opensOrCloses(key: ToggleKey, marker: string): boolean {
    if (key !== "strike" || this.#active.strike) return true;
    return this.#source.includes(marker, this.#index + marker.length);
  }

  #toggle(key: ToggleKey, marker: string): void {
    if (this.#active[key]) {
      this.#active[key] = false;
      this.#openers.pop();
      return;
    }
    if (this.#openers.length >= MAX_DEPTH) {
      this.#problems.push(`markup nested more than ${MAX_DEPTH} deep`);
      return;
    }
    this.#active[key] = true;
    this.#openers.push(marker);
  }

  #openLink(): void {
    this.#flush();
    if (this.#active.link) {
      this.#problems.push("link markers cannot be nested");
    } else {
      this.#linkCount += 1;
      this.#active.link = true;
      this.#openers.push("[");
    }
    this.#index += 1;
  }

  #closeLink(): void {
    this.#flush();
    if (this.#active.link) {
      this.#active.link = false;
      this.#openers.pop();
    } else {
      this.#buffer += "]";
    }
    this.#index += 1;
  }

  /** `{cyan:…}` and the other colours, or `{dim:…}`. Anything else is a literal brace. */
  #openBrace(): void {
    const colon = this.#source.indexOf(":", this.#index);
    const name = colon === -1 ? "" : this.#source.slice(this.#index + 1, colon);
    const isColor = (SPAN_COLORS as readonly string[]).includes(name);

    if (colon === -1 || (!isColor && name !== "dim")) {
      if (name.length > 0 && !name.includes(" ")) {
        this.#problems.push(
          `"${name}" is not an available colour — choose from ${SPAN_COLORS.join(", ")}, or dim`,
        );
      }
      this.#buffer += "{";
      this.#index += 1;
      return;
    }

    this.#flush();
    const kind = isColor ? "color" : "dim";
    if (this.#braces.includes(kind)) {
      this.#problems.push(isColor ? "colour markers cannot be nested" : "dim cannot be nested");
    } else if (this.#openers.length >= MAX_DEPTH) {
      this.#problems.push(`markup nested more than ${MAX_DEPTH} deep`);
    } else {
      if (isColor) this.#active.color = name as SpanColor;
      else this.#active.dim = true;
      this.#braces.push(kind);
      this.#openers.push("{");
    }
    this.#index = colon + 1;
  }

  #closeBrace(): void {
    this.#flush();
    if (this.#braces.pop() === "color") this.#active.color = undefined;
    else this.#active.dim = false;
    this.#openers.pop();
    this.#index += 1;
  }

  #flush(): void {
    if (this.#buffer.length === 0 || this.#spans.length >= MAX_SPANS) {
      this.#buffer = "";
      return;
    }
    this.#spans.push({
      text: this.#buffer,
      ...(this.#active.bold ? { bold: true } : {}),
      ...(this.#active.italic ? { italic: true } : {}),
      ...(this.#active.highlight ? { highlight: true } : {}),
      ...(this.#active.strike ? { strike: true } : {}),
      ...(this.#active.dim ? { dim: true } : {}),
      ...(this.#active.link ? { link: true } : {}),
      ...(this.#active.color === undefined ? {} : { color: this.#active.color }),
    });
    this.#buffer = "";
  }

  #finalise(): void {
    if (this.#openers.length > 0) {
      this.#problems.push(`unclosed markup: ${this.#openers.join(" ")}`);
    }
    if (this.#linkCount > 1) {
      this.#problems.push(
        "only one link is allowed — a click reports one token per impression, so a second link " +
          "would make it impossible to say which part was clicked",
      );
    }
    if (this.#spans.length >= MAX_SPANS) {
      this.#problems.push(`copy has more than ${MAX_SPANS} styled runs`);
    }
  }
}

/**
 * Parse markup into spans.
 *
 * Never throws and never returns partial nonsense: on malformed input it reports
 * problems and returns the copy it could make sense of, so a caller can choose
 * between rejecting (the API does) and rendering something safe (the client).
 */
export function parseMarkup(source: string): ParseResult {
  return new Parser(source).run();
}

/**
 * The §3 prominence rules, as arithmetic.
 *
 * Emphasising a word is emphasis; emphasising everything is amplification, and
 * the `sponsored` label loses. Expressing it as a proportion is what makes it
 * enforceable rather than a matter of taste.
 */
function proportionProblems(spans: readonly Span[], plain: string): string[] {
  const problems: string[] = [];
  const visible = [...plain].length;
  if (visible === 0) return problems;

  const emphasised = spans
    .filter((span) => span.bold === true || span.highlight === true)
    .reduce((total, span) => total + [...span.text].length, 0);

  const highlighted = spans
    .filter((span) => span.highlight === true)
    .reduce((total, span) => total + [...span.text].length, 0);

  const allowance = Math.max(MAX_EMPHASIS_CHARS, Math.floor(visible * MAX_EMPHASIS_RATIO));
  if (emphasised > allowance) {
    problems.push(
      `bold and highlight may cover at most ${allowance} of ${visible} characters here ` +
        `(got ${emphasised}). The \`sponsored\` label has to stay at least as prominent as the ` +
        "ad (§3) — emphasise the part that matters, not the whole line.",
    );
  }

  if (highlighted > MAX_HIGHLIGHT_LENGTH) {
    problems.push(
      `a highlight may span at most ${MAX_HIGHLIGHT_LENGTH} characters (got ${highlighted}) — ` +
        "beyond that it reads as a banner rather than a highlight",
    );
  }

  if (visible > MAX_VISIBLE_LENGTH) {
    problems.push(
      `copy is ${visible} visible characters; the status line budget is ${MAX_VISIBLE_LENGTH} ` +
        "(markup itself does not count)",
    );
  }

  return problems;
}

/**
 * Mark the whole copy as the link when the author marked no part of it.
 *
 * `[...]` NARROWS what is clickable; it does not enable clickability. A creative
 * has a `click_url` either way, and an advertisement nobody can click is simply
 * broken — so plain copy with no marker is entirely clickable, which is also how
 * it behaved before inline markup existed.
 *
 * Applied server-side so the wire says exactly which runs are clickable. A
 * client should not have to re-derive it, and the next client (the Phase 7 VS
 * Code extension) gets it right without knowing the rule.
 */
export function withDefaultLink(spans: readonly Span[]): Span[] {
  if (spans.some((span) => span.link === true)) return [...spans];
  return spans.map((span) => ({ ...span, link: true }));
}

/** Visible text only, for length checks and accessible fallbacks. */
export function plainText(source: string): string {
  return parseMarkup(source).plain;
}

/**
 * The CSS classes a span renders with, in the shared design layer's vocabulary.
 *
 * Lives here rather than beside either renderer because there are two of them: `/ads` on the
 * public site shows live copy, and the review queue shows the same copy before it is approved.
 * Those two must not disagree — a moderator approving something that ships looking different
 * is the review being wrong rather than merely inconsistent — and the way they would come to
 * disagree is by each keeping its own copy of this mapping.
 *
 * `.slot-*`, `.is-bold`, `.is-italic`, `.is-highlight`, `.is-strike` and `.is-dim` are defined once, in
 * `styles/base.css`, which both tiers serve.
 */
export function spanClasses(span: Span): string {
  return [
    span.bold === true ? "is-bold" : "",
    span.italic === true ? "is-italic" : "",
    span.highlight === true ? "is-highlight" : "",
    span.strike === true ? "is-strike" : "",
    span.dim === true ? "is-dim" : "",
    span.color === undefined ? "" : `slot-${span.color}`,
  ]
    .filter((rule) => rule.length > 0)
    .join(" ");
}

/**
 * The classes for the line as a whole: the slot the advertiser picked, and the effect.
 *
 * `style` and `effect` are the creative's own columns rather than markup, so they are passed
 * as strings — `"default"` and `"none"` are the no-ops and contribute nothing.
 */
export function lineClasses(style: string, effect: string): string {
  return [style === "default" ? "" : `slot-${style}`, effect === "italic" ? "is-italic" : ""]
    .filter((rule) => rule.length > 0)
    .join(" ");
}
