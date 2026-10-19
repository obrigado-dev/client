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
import type { BatchItem, WireSpan } from "@obrigado/shared";

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

export { copyParts } from "./copy-parts.ts";
export { SPONSOR_LABEL } from "./disclosure.ts";
