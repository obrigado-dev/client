import type { BatchBrand, BatchItem, WireSpan } from "@obrigado/shared";

import { stripControlCharacters } from "./text.ts";

/**
 * The same creative, as PARTS rather than an escape-sequence string.
 *
 * A host that draws its own UI cannot use `renderCopy`'s output: handing OpenCode's TUI
 * pre-escaped bytes forces it to render them literally or strip them, which is exactly the
 * pair of failures that disqualified Codex. So it gets the spans and composes them with its
 * own primitives.
 *
 * The terminal renderer and browser runtime share this serializer. The
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

  // A copy, never `Object.assign` onto the wire span: that wrote the sanitised text back
  // into the cached batch, which only stayed harmless while the batch happened to be
  // persisted before this ran.
  const spans: WireSpan[] = [];
  for (const span of source) {
    const text = stripControlCharacters(span.text);
    if (text.length > 0) spans.push({ ...span, text });
  }

  return { spans, style: item.style, effect: item.effect, brand: item.brand };
}
