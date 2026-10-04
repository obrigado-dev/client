/**
 * The install's summary: one line per host, then one for the backups.
 *
 * Lined up so the outcomes read as a column, with the host first because that is what a reader
 * scans for. Paths are shortened to `~` on the way out: the full home directory in every line
 * was most of the width and none of the information.
 */
import { homedir } from "node:os";

import { BACKUP_DIR, CLAUDE_SETTINGS_PATH } from "../config.ts";
import type { InstallOutcome } from "../statusline.ts";
import type { InstallRow } from "./adapters.ts";

const MARKS: Record<InstallRow["mark"], string> = { done: "✓", skipped: "–", failed: "✗" };

/** `path` with the home directory written as `~`. */
export function tilde(path: string, home = homedir()): string {
  return home.length > 0 && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** What happened first, what went wrong next, what was left alone last. */
const ORDER: Record<InstallRow["mark"], number> = { done: 0, failed: 1, skipped: 2 };

export function printInstallRows(rows: readonly InstallRow[], say = console.log): void {
  if (rows.length === 0) return;
  const width = Math.max(...rows.map((row) => row.host.length));
  for (const row of rows.toSorted((a, b) => ORDER[a.mark] - ORDER[b.mark])) {
    say(`  ${MARKS[row.mark]} ${row.host.padEnd(width)}  ${row.detail}`);
    for (const note of row.notes ?? []) say(`    ${" ".repeat(width)}  ${note}`);
  }
  if (rows.some((row) => row.backedUp === true)) {
    say(`\n  Backups of anything changed: ${tilde(BACKUP_DIR)}`);
  }
}

/** A command, cut to what fits beside a row. */
function clip(text: string, room = 60): string {
  return text.length > room ? `${text.slice(0, room - 1)}…` : text;
}

/** Claude Code's line in the summary, and what has to be said beneath it. */
export function claudeRow(
  outcome: InstallOutcome,
  chained: string | undefined,
  previous: unknown,
): InstallRow {
  const where = tilde(CLAUDE_SETTINGS_PATH);
  if (outcome.status === "refused") {
    return {
      mark: "failed",
      host: "Claude Code",
      detail: `you already have a status line in ${where}, left as it was`,
      notes: [
        clip(JSON.stringify(outcome.existing)),
        "--chain keeps yours above ours; --replace takes the slot (uninstall puts yours back)",
      ],
    };
  }
  const saved = previous !== null && previous !== undefined && outcome.status === "installed";
  const notes =
    chained === undefined
      ? saved
        ? ["your old status line is saved; uninstall puts it back"]
        : []
      : [`yours still renders above ours: ${clip(chained)}`];
  return {
    mark: "done",
    host: "Claude Code",
    detail: `status line · ${where}${outcome.status === "already-installed" ? " · already there" : ""}`,
    ...(notes.length === 0 ? {} : { notes }),
    backedUp: outcome.status === "installed" && outcome.backup !== null,
  };
}

/** A host whose install threw: the line says so, with the reason. */
export function failedRow(host: string, error: unknown): InstallRow {
  return {
    mark: "failed",
    host,
    detail: `failed: ${error instanceof Error ? error.message : String(error)}`,
  };
}
