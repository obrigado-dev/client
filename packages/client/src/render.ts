/**
 * Composing the sponsored line from typed spans.
 *
 * The client renders spans; it never parses markup. Authoring syntax is parsed
 * and validated once, server-side, so untrusted markup cannot reach a terminal
 * renderer — the same reasoning that makes creative copy control-character-free
 * at three layers.
 *
 * Order is load-bearing and getting it wrong is silent:
 *
 *   1. Sanitise every span's text FIRST. Styling before sanitising would strip
 *      our own escape codes back out.
 *   2. Per-span attributes wrap that span's text, innermost.
 *   3. The link wraps the contiguous run of link spans, so one OSC 8 sequence
 *      covers them all rather than one per span.
 *   4. The creative's line-level colour and effect wrap everything, outermost,
 *      so a span's reset cannot cancel them for the rest of the line.
 *
 * The `sponsored` label is added by the caller and never styled, so the
 * disclosure cannot be made quieter than the advertisement (§3).
 */
import type { BatchBrand, BatchItem, WireSpan } from "@obrigado/shared";

import { hyperlink, stripControlCharacters, supportsHyperlinks } from "./link.ts";
import { applyEffect, applyStyle, spanAttributes, underline } from "./style.ts";
import type { CreativeEffect, CreativeStyle } from "./style.ts";

export interface RenderOptions {
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly color?: "auto" | "off";
}

/** Split spans into runs, grouping consecutive link spans into one. */
function groupRuns(spans: readonly WireSpan[]): Array<{ link: boolean; spans: WireSpan[] }> {
  const runs: Array<{ link: boolean; spans: WireSpan[] }> = [];
  for (const span of spans) {
    const isLink = span.link === true;
    const tail = runs.at(-1);
    if (tail !== undefined && tail.link === isLink) tail.spans.push(span);
    else runs.push({ link: isLink, spans: [span] });
  }
  return runs;
}

/**
 * Render one creative's copy: sanitised, per-span styled, and clickable in whole
 * or part. Returns copy only — the caller prefixes the label.
 */
export function renderCopy(item: BatchItem, options: RenderOptions = {}): string {
  const env = options.env ?? process.env;
  const preference = options.color ?? "auto";
  const clickable = supportsHyperlinks(env);

  // No spans means plain copy — the path a creative without markup takes.
  const spans: readonly WireSpan[] =
    item.spans.length > 0 ? item.spans : [{ text: item.body, link: true }];

  const rendered = groupRuns(spans)
    .map((run) => {
      const inner = run.spans
        .map((span) => {
          const safe = stripControlCharacters(span.text);
          if (safe.length === 0) return "";
          return spanAttributes(safe, span, env, preference);
        })
        .join("");

      if (inner.length === 0) return "";
      // Underline marks clickability truthfully: applied exactly when the text
      // really is a link, never as an advertiser-selectable flourish.
      return run.link && clickable ? hyperlink(underline(inner), item.click_url, env) : inner;
    })
    .join("");

  if (rendered.length === 0) return "";

  const withEffect = applyEffect(rendered, item.effect as CreativeEffect, env, preference);
  return applyStyle(withEffect, item.style as CreativeStyle, env, preference);
}

/**
 * The same creative, as PARTS rather than an escape-sequence string.
 *
 * A host that draws its own UI cannot use `renderCopy`'s output: handing OpenCode's TUI
 * pre-escaped bytes forces it to render them literally or strip them, which is exactly the
 * pair of failures that disqualified Codex. So it gets the spans and composes them with its
 * own primitives.
 *
 * This lives beside `renderCopy` on purpose. They are two serialisations of one render, and
 * the decisions that must not drift between them — sanitise before anything else, fall back
 * to one link over the whole line when a creative has no markup, drop spans that sanitise
 * away to nothing — are made here once, for both.
 *
 * What is NOT included is the `sponsored` label: the caller adds it, outside the link, so a
 * host cannot accidentally style the disclosure with the advertiser's palette or make it
 * clickable.
 */
export interface SponsoredParts {
  readonly spans: readonly WireSpan[];
  /** Line-level colour slot; `default` means the host's own foreground. */
  readonly style: string;
  /** Line-level effect; `none` or `italic`. */
  readonly effect: string;
  /**
   * Who is paying, for hosts that can show it.
   *
   * Passed straight through rather than rendered: a wordmark is a terminal font, a logo is a
   * data URI in a markdown hover, and neither is a decision this module can make for them.
   * It travels here so no host has to invent a brand — the OpenCode wordmark used to read
   * the trailing domain out of the copy, which is how the wrong company's name ends up in
   * somebody's editor.
   */
  readonly brand: BatchBrand | null;
}

export function copyParts(item: BatchItem): SponsoredParts {
  const source: readonly WireSpan[] =
    item.spans.length > 0 ? item.spans : [{ text: item.body, link: true }];

  const spans = source
    .map((span) => Object.assign(span, { text: stripControlCharacters(span.text) }))
    .filter((span) => span.text.length > 0);

  return { spans, style: item.style, effect: item.effect, brand: item.brand };
}
