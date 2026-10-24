/**
 * Characters a terminal or an agent uses to say how something went.
 *
 * An ad is a line of text beside the developer's own tools, and the cheapest way for one to
 * borrow their authority is a glyph they already read as a result: a tick that says the build
 * passed, a cross or a warning sign that says it did not, a coloured dot in a status bar, a
 * spinner that says something is running, or the `⏺` and `⎿` Claude Code draws its own
 * transcript with. The palette leaves out red and yellow for the same reason (`style.ts`).
 *
 * Everything else is allowed, arrows and stars included: `→` points at the link and `★` is
 * nobody's status.
 */
const STATUS_SYMBOLS: ReadonlySet<string> = new Set([
  ..."✓✔✅☑✗✘❌❎☒⚠⛔🚫❗❕‼⁉❓❔",
  ..."🔴🟠🟡🟢🔵🟣🟤⚫⚪●◉⦿⬤",
  ..."⏺⎿✱✳⏳⌛⟳↻🔄",
]);

/** Braille patterns, which every terminal spinner is drawn from. */
const isSpinnerFrame = (code: number): boolean => code >= 0x28_00 && code <= 0x28_ff;

/** Whether a character reads as a status indicator: see `STATUS_SYMBOLS`. */
export function isStatusSymbol(character: string): boolean {
  return STATUS_SYMBOLS.has(character) || isSpinnerFrame(character.codePointAt(0) ?? 0);
}
