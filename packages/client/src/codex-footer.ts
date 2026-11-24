/**
 * The developer's own Codex footer, drawn again.
 *
 * A Codex status line provider does not add to the footer, it replaces it: once one is selected,
 * Codex stops drawing the items the developer chose in `/statusline` and draws the provider's
 * tree in their place. So before our line can go under theirs, theirs has to be put back. Codex
 * hands a provider a snapshot of the thread on every read, with the developer's item list in it
 * (`config.statusline_items`), and this module turns that snapshot into the footer Codex would
 * have drawn from it: the same items, in the same order, with the same text and separator.
 *
 * Everything here mirrors Codex 0.171.0, read from `codex-rs/tui/src` at `rust-v0.171.0` and
 * checked against the running program wherever it could be run without a model (which leaves out
 * token counts, rate limits and thread cost; those follow the source and its own tests):
 *
 *   - which text an item shows: `status_line_value_for_item` in `chatwidget/status_surfaces.rs`
 *     (here `codex-footer-items.ts`, with the counting items in `codex-footer-usage.ts`, their
 *     number formats in `codex-footer-format.ts`, and what comes from this machine instead of
 *     the snapshot in `codex-footer-local.ts`);
 *   - what the snapshot carries of the state that text is made from: `chatwidget/statusline_state.rs`
 *     and its `usage.rs` and `account.rs`;
 *   - how items are joined and coloured: `status_line_from_segments` and `StatusLineAccent` in
 *     `bottom_pane/status_line_style.rs`;
 *   - how a tree is laid out, which decides the shape returned: `ui_tree/render.rs` and its
 *     `prepare.rs` and `text.rs`.
 *
 * Three items cannot be drawn at all and are left out (`UNREDRAWABLE_ITEMS`). A few more are drawn
 * from an inference, because the snapshot carries what Codex decided and not always the state it
 * decided from. Each is marked "Inferred" where it is made, so the list is easy to find again when
 * Codex changes.
 *
 * What a tree cannot say, and the built-in footer does:
 *
 *   - The separator, and every item when theme colours are off, are drawn in Codex's secondary
 *     text colour (the terminal's foreground blended 60% toward its background). A tree has no
 *     such colour and no dim, so those are left uncoloured and come out in the terminal's
 *     foreground: the same where Codex cannot learn the terminal's colours (inside tmux, say),
 *     brighter elsewhere.
 *   - A thread's name is drawn in a colour picked for that thread from the theme (`thread_color`).
 *     The nearest a tree has is `status-thread`.
 *   - The built-in footer softens a theme colour and corrects it for contrast before using it. A
 *     tree's `status-*` colours are the theme's as they are, so a hue differs slightly.
 *   - A line too long for the terminal wraps between items here, and anywhere a word ends there.
 *
 * Nothing here reads a file, the clock or the environment: what the snapshot does not carry
 * comes in as `FooterMachine`.
 */
import type { FooterItemId, FooterItemSource } from "./codex-footer-items.ts";
import { FOOTER_ITEMS, isFooterItemId } from "./codex-footer-items.ts";
import type { FooterMachine } from "./codex-footer-local.ts";
import type { View } from "./codex-footer-state.ts";
import { at } from "./codex-footer-state.ts";
import type { UiNode } from "./codex-tree.ts";

export type { FooterItemId, FooterItemSource } from "./codex-footer-items.ts";
export type { FooterMachine } from "./codex-footer-local.ts";
export type { UiNode } from "./codex-tree.ts";

/** The items Codex draws when `tui.status_line` is not set: `DEFAULT_STATUS_LINE_ITEMS`. */
export const DEFAULT_ITEMS: readonly string[] = [
  "model-with-reasoning",
  "current-dir",
  "thread-name",
];

/**
 * What stands between two items. Upstream's `STATUS_LINE_SEPARATOR` is this with a space either
 * side; here the spaces are the row's gap, since a tree drops a leaf's own leading and trailing
 * spaces.
 */
const FOOTER_SEPARATOR = "·";

/**
 * The most this module puts in a tree, well inside Codex's limits (256 nodes, 16 KiB of text,
 * depth 16, 64 KiB of JSON) so that whatever is drawn beside it has room. The built-in footer has
 * no such limits, but it shows three terminal lines at most, so what is cut was never on screen.
 * A footer here is one row of items and separators, at most three levels deep.
 */
const FOOTER_MAX_ITEMS = 64;
export const FOOTER_MAX_NODES = FOOTER_MAX_ITEMS * 3;
export const FOOTER_MAX_TEXT_BYTES = 8 * 1024;

const ITEM_IDS = Object.keys(FOOTER_ITEMS).filter((id) => isFooterItemId(id));

function sourcesOf(ids: readonly FooterItemId[]): Record<FooterItemId, FooterItemSource> {
  const sources: Partial<Record<FooterItemId, FooterItemSource>> = {};
  for (const id of ids) sources[id] = FOOTER_ITEMS[id].source;
  return sources as Record<FooterItemId, FooterItemSource>;
}

/** Where each of the 33 items' text comes from. */
export const FOOTER_ITEM_SOURCES: Readonly<Record<FooterItemId, FooterItemSource>> =
  sourcesOf(ITEM_IDS);

/**
 * Item ids whose value cannot be reproduced from the snapshot plus cheap local facts. Each has
 * its reason beside it in `codex-footer-items.ts`. `redrawFooter` leaves them out, as Codex leaves
 * out an item with no value, so a footer that had one loses it under any provider.
 */
export const UNREDRAWABLE_ITEMS: readonly string[] = ITEM_IDS.filter(
  (id) => FOOTER_ITEMS[id].source === "unredrawable",
);

// oxlint-disable-next-line no-control-regex -- control characters are exactly what is being removed
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu;

/**
 * An item's text as a leaf Codex draws the way its own footer does.
 *
 * `status_line_from_segments` drops control characters from each item, and so does this: in a
 * tree a newline would break the line and an escape would be read as a terminal sequence. A tree
 * also squeezes a run of spaces to one and drops them at a leaf's ends, where the built-in
 * footer keeps every space (a thread named with two spaces shows two, checked against Codex
 * 0.171.0), so each space a tree would drop is written as a no-break space, which it draws as a
 * blank cell.
 */
function footerLeaf(value: string): string {
  return value
    .toWellFormed()
    .replaceAll(CONTROL, "")
    .replaceAll(/(?<=^| ) | $/gu, " ");
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The longest prefix that fits in `limit` bytes of UTF-8, cut between characters. */
function utf8Prefix(value: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    bytes += utf8Length(character);
    if (bytes > limit) return value.slice(0, end);
    end += character.length;
  }
  return value;
}

const SEPARATOR_BYTES = utf8Length(FOOTER_SEPARATOR);

/** An item's value, with a `machine` that throws counted as a fact that is not there. */
function valueOf(id: FooterItemId, view: View): string | null {
  try {
    return FOOTER_ITEMS[id].value(view);
  } catch {
    return null;
  }
}

/**
 * The developer's footer as Codex 0.171.0 draws it, or null when nothing has a value yet.
 *
 * `state` is the snapshot as it arrived (`params._meta["com.openai/codex-statusline-state"]`) and
 * is trusted for nothing: a field that is missing or of the wrong type costs the items that
 * needed it and no more. The items are the snapshot's own list, which already holds the defaults
 * for a developer who set none, and an id this version does not know is skipped, as Codex skips
 * one it cannot parse. An item with no value is skipped as well, separator and all.
 *
 * The tree is one row: the items, a `·` between each two, a gap of one column, wrapping where the
 * terminal is too narrow. That is the built-in footer's ` · ` to the character, checked against
 * Codex 0.171.0. With `useColors` (the developer's `tui.status_line_use_colors`, on unless they
 * turned it off) each item is in the colour role upstream gives it; without, each is a plain
 * string. The separator is plain either way.
 */
export function redrawFooter(
  state: unknown,
  machine: FooterMachine,
  options: { readonly useColors: boolean },
): UiNode | null {
  const configured = at(state, "config", "statusline_items");
  const ids: readonly unknown[] = Array.isArray(configured) ? configured : DEFAULT_ITEMS;
  const view: View = { state, machine };

  const children: UiNode[] = [];
  let bytesLeft = FOOTER_MAX_TEXT_BYTES;
  let items = 0;
  for (const id of ids) {
    // Room for this item's text, after the separator that would come before it.
    const room = bytesLeft - (items > 0 ? SEPARATOR_BYTES : 0);
    if (items === FOOTER_MAX_ITEMS || room <= 0) break;
    if (!isFooterItemId(id)) continue;
    const value = valueOf(id, view);
    if (value === null) continue;

    if (items > 0) children.push(FOOTER_SEPARATOR);
    const leaf = utf8Prefix(footerLeaf(value), room);
    bytesLeft = room - utf8Length(leaf);
    children.push(
      options.useColors
        ? { type: "text", props: { color: FOOTER_ITEMS[id].color }, children: [leaf] }
        : leaf,
    );
    items += 1;
  }

  if (items === 0) return null;
  return { type: "row", props: { gap: 1, wrap: "wrap" }, children };
}
