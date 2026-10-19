/** Text sanitising shared by the terminal and browser renderers. No platform I/O. */
import { isControlCharacter } from "@obrigado/shared";

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
  return [...text].filter((character) => !isControlCharacter(character)).join("");
}
