/**
 * What a creative is drawn with, from its markup and its effect.
 *
 * Apart from `markup.ts` because that file is the parser, and this is what happens to the
 * parse afterwards: the default link, and effects that are drawn as runs.
 */
import { MAX_SPANS, parseMarkup, withDefaultLink } from "./markup.ts";
import type { Span, SpanColor } from "./markup.ts";

/** The colours a gradient runs through, in order: the cool end of the palette. */
export const GRADIENT_COLORS: readonly SpanColor[] = ["cyan", "blue", "magenta"];

const colorOf = (band: number): SpanColor => GRADIENT_COLORS[band] ?? "cyan";

/**
 * The gradient effect, as spans: the line split into bands that run through `GRADIENT_COLORS`.
 *
 * Bands rather than a colour per character, because a terminal has four colour slots here, not
 * a ramp, and because the wire allows 48 runs. A run the author coloured keeps its own colour.
 *
 * Done on the server, before the wire, so a client that has never heard of gradients still
 * draws one: it already knows how to colour a run. A line that would need more than the wire's
 * 48 runs is returned unbanded rather than cut.
 */
export function withGradient(spans: readonly Span[]): Span[] {
  const total = spans.reduce((sum, span) => sum + [...span.text].length, 0);
  if (total === 0) return [...spans];
  const bandOf = (position: number): number =>
    Math.min(Math.floor((position * GRADIENT_COLORS.length) / total), GRADIENT_COLORS.length - 1);

  const banded: Span[] = [];
  let position = 0;
  for (const span of spans) {
    const characters = [...span.text];
    if (span.color !== undefined) {
      banded.push(span);
      position += characters.length;
      continue;
    }
    let run = "";
    let band = bandOf(position);
    for (const character of characters) {
      const next = bandOf(position);
      if (next !== band && run !== "") {
        banded.push({ ...span, text: run, color: colorOf(band) });
        run = "";
      }
      band = next;
      run += character;
      position += 1;
    }
    if (run !== "") banded.push({ ...span, text: run, color: colorOf(band) });
  }
  return banded.length > MAX_SPANS ? [...spans] : banded;
}

/**
 * The runs a creative is drawn with: its markup, the whole line linked when no part of it is,
 * and its effect where the effect is drawn as runs. What the server sends and every preview
 * draws, from one function, so a preview cannot show something the wire will not.
 */
export function lineSpans(body: string, effect: string): Span[] {
  const spans = withDefaultLink(parseMarkup(body).spans);
  return effect === "gradient" ? withGradient(spans) : spans;
}
