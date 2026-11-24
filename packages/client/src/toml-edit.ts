/**
 * Small edits to a TOML file somebody else owns, made on its text.
 *
 * Codex keeps its settings in `~/.codex/config.toml`, a file a developer writes by hand: comments,
 * blank lines, their own order. Parsing it and writing it back would keep the values and lose all
 * of that, so the edits here are made on the lines themselves: one key set or removed in one
 * table, one table added or removed, and every other byte left where it was.
 *
 * A line editor does not understand TOML, and this one does not pretend to. It finds a `[table]`
 * header by reading lines, so a header-shaped line inside a multi-line string would fool it, and it
 * replaces a key's first line, so a value that runs over several lines would be cut in half. Those
 * are not handled; they are caught. `sameExcept` parses the text before and after and holds the
 * result to exactly the change that was asked for, and the caller writes nothing unless it does.
 * Anything this editor gets wrong therefore ends as a refusal that names the lines to add by hand,
 * never as a file Codex cannot read.
 */

/** A table's name as its parts: `[mcp_servers.obrigado]` is `["mcp_servers", "obrigado"]`. */
export type TablePath = readonly string[];

export class TomlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlEditError";
  }
}

/** A key as TOML writes it: bare where that is allowed, quoted otherwise. */
function keyText(key: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
}

function headerText(path: TablePath): string {
  return `[${path.map((part) => keyText(part)).join(".")}]`;
}

/**
 * The parts of a dotted key or a header's name, or null when it is not one this editor reads.
 *
 * Bare keys, `"basic"` strings and `'literal'` strings, separated by dots, with spaces allowed
 * around each. A basic string is read as JSON, which agrees with TOML on every escape a table name
 * is likely to hold.
 */
function dottedParts(text: string): string[] | null {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    const part = leadingPart(rest);
    if (part === null) return null;
    parts.push(part.value);
    rest = rest.slice(part.length).trimStart();
    if (rest.length === 0) break;
    if (!rest.startsWith(".")) return null;
    rest = rest.slice(1).trimStart();
    if (rest.length === 0) return null;
  }
  return parts.length === 0 ? null : parts;
}

/** The key `text` starts with, and how many characters of it that took. */
function leadingPart(text: string): { value: string; length: number } | null {
  const bare = /^[A-Za-z0-9_-]+/u.exec(text);
  if (bare !== null) return { value: bare[0], length: bare[0].length };
  const literal = /^'[^']*'/u.exec(text);
  if (literal !== null) return { value: literal[0].slice(1, -1), length: literal[0].length };
  const basic = /^"(?:[^"\\]|\\.)*"/u.exec(text);
  if (basic === null) return null;
  try {
    return { value: JSON.parse(basic[0]) as string, length: basic[0].length };
  } catch {
    return null;
  }
}

interface Header {
  /** The line the header is on. */
  readonly line: number;
  readonly path: readonly string[];
}

/** Every `[table]` and `[[array of tables]]` header, in order. */
function headers(lines: readonly string[]): Header[] {
  const found: Header[] = [];
  for (const [line, text] of lines.entries()) {
    const match = /^\s*\[\[?([^[\]]+)\]\]?\s*(?:#.*)?$/u.exec(text);
    if (match === null) continue;
    const path = dottedParts(match[1] ?? "");
    if (path !== null) found.push({ line, path });
  }
  return found;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

/** Whether `path` is `prefix` or a table beneath it. */
function isUnder(path: readonly string[], prefix: readonly string[]): boolean {
  return path.length >= prefix.length && prefix.every((part, index) => part === path[index]);
}

interface Span {
  /** The header's line. */
  readonly start: number;
  /** One past the table's last line: the next header's line, or the end of the file. */
  readonly end: number;
}

/** Where a table's own lines are, or null when the file has no header for it. */
function tableSpan(lines: readonly string[], path: TablePath): Span | null {
  const all = headers(lines);
  const index = all.findIndex((header) => samePath(header.path, path));
  const header = all[index];
  if (header === undefined) return null;
  return { start: header.line, end: all[index + 1]?.line ?? lines.length };
}

function isBlankOrComment(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}

/** The line in a table that sets `key`, or -1. Its first line, where the value runs on. */
function keyLine(lines: readonly string[], span: Span, key: string): number {
  for (let line = span.start + 1; line < span.end; line += 1) {
    const text = lines[line] ?? "";
    const equals = text.indexOf("=");
    if (equals === -1 || isBlankOrComment(text)) continue;
    const parts = dottedParts(text.slice(0, equals));
    if (parts !== null && parts.length === 1 && parts[0] === key) return line;
  }
  return -1;
}

/**
 * Whether the lines before the first header set `name` themselves, as a dotted key or as an inline
 * table.
 *
 * `tui.status_line = […]` at the top of the file, or `tui = { … }`, defines the table without a
 * header. A `[tui]` header added below either is a second definition, which TOML forbids, so the
 * edit is refused before it is made rather than caught after.
 */
function definedInline(lines: readonly string[], name: string): boolean {
  const firstHeader = headers(lines)[0]?.line ?? lines.length;
  for (let line = 0; line < firstHeader; line += 1) {
    const text = lines[line] ?? "";
    const equals = text.indexOf("=");
    if (equals === -1 || isBlankOrComment(text)) continue;
    const parts = dottedParts(text.slice(0, equals));
    if (parts !== null && parts[0] === name) return true;
  }
  return false;
}

/** The text as lines, and the line ending it uses, so a CRLF file stays one. */
function split(text: string): { lines: string[]; newline: string } {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.split(/\r?\n/u), newline };
}

function join(lines: readonly string[], newline: string): string {
  return lines.join(newline);
}

/** New lines at the end of the file, after one blank line, leaving it ending in a newline. */
function append(lines: string[], added: readonly string[]): string[] {
  const kept = [...lines];
  while (kept.length > 0 && (kept.at(-1) ?? "").trim().length === 0) kept.pop();
  return [...kept, ...(kept.length === 0 ? [] : [""]), ...added, ""];
}

/**
 * Set one key in one table to a value written as TOML.
 *
 * Where the table has the key, its line is replaced and keeps its indentation. Where it has the
 * table and not the key, the line goes after the table's last setting, above any blank lines and
 * comments that lead into the next table. Where it has neither, the table is added at the end.
 */
export function setTomlKey(text: string, table: TablePath, key: string, literal: string): string {
  const { lines, newline } = split(text);
  const entry = `${keyText(key)} = ${literal}`;
  const span = tableSpan(lines, table);

  if (span === null) {
    const root = table[0];
    if (root !== undefined && definedInline(lines, root)) {
      throw new TomlEditError(
        `\`${root}\` is set without a \`[${root}]\` table, which this cannot edit safely`,
      );
    }
    return join(append(lines, [headerText(table), entry]), newline);
  }

  const existing = keyLine(lines, span, key);
  if (existing !== -1) {
    const indent = /^\s*/u.exec(lines[existing] ?? "")?.[0] ?? "";
    lines[existing] = `${indent}${entry}`;
    return join(lines, newline);
  }

  let after = span.start;
  for (let line = span.start + 1; line < span.end; line += 1) {
    if (!isBlankOrComment(lines[line] ?? "")) after = line;
  }
  lines.splice(after + 1, 0, entry);
  return join(lines, newline);
}

/**
 * Remove one key from one table, and the table's header with it where nothing else is left.
 *
 * A table this file's owner wrote is never emptied by this: the header goes only when the table
 * holds no other setting and no comment, which is a table an earlier `setTomlKey` added. The text
 * comes back unchanged when the key is not there.
 */
export function removeTomlKey(text: string, table: TablePath, key: string): string {
  const { lines, newline } = split(text);
  const span = tableSpan(lines, table);
  if (span === null) return text;
  const existing = keyLine(lines, span, key);
  if (existing === -1) return text;

  lines.splice(existing, 1);
  const end = span.end - 1;
  const empty = lines.slice(span.start + 1, end).every((line) => line.trim().length === 0);
  const hasChildren = headers(lines).some(
    (header) => header.path.length > table.length && isUnder(header.path, table),
  );
  if (empty && !hasChildren) {
    lines.splice(span.start, end - span.start);
    // The blank line that led into the header goes with it, where there was one.
    if (span.start > 0 && (lines[span.start - 1] ?? "").trim().length === 0) {
      lines.splice(span.start - 1, 1);
    }
    if (lines.at(-1) !== "") lines.push("");
  }
  return join(lines, newline);
}

/**
 * Write a whole table: in place of the one already there, its sub-tables included, or at the end.
 *
 * For a table that is ours from its header to its last line, such as our own MCP server's entry.
 * `body` is its settings, one per line, already written as TOML.
 */
export function setTomlTable(text: string, table: TablePath, body: readonly string[]): string {
  const cleared = removeTomlTable(text, table);
  const { lines, newline } = split(cleared);
  return join(append(lines, [headerText(table), ...body]), newline);
}

/** Remove a table and every table beneath it. Unchanged when the file has neither. */
export function removeTomlTable(text: string, table: TablePath): string {
  const { lines, newline } = split(text);
  const all = headers(lines);
  const doomed: Span[] = [];
  for (const [index, header] of all.entries()) {
    if (!isUnder(header.path, table)) continue;
    doomed.push({ start: header.line, end: all[index + 1]?.line ?? lines.length });
  }
  if (doomed.length === 0) return text;

  for (const span of doomed.toReversed()) {
    // The table's trailing blank lines go with it. A comment that a blank line sets apart from
    // the table's settings leads into the next table, and stays.
    let tail = span.end;
    while (tail > span.start + 1 && isBlankOrComment(lines[tail - 1] ?? "")) tail -= 1;
    const firstBlank = lines.findIndex(
      (line, index) => index >= tail && index < span.end && line.trim().length === 0,
    );
    const comment =
      firstBlank === -1
        ? -1
        : lines.findIndex(
            (line, index) => index > firstBlank && index < span.end && line.trim().startsWith("#"),
          );
    lines.splice(span.start, (comment === -1 ? span.end : comment) - span.start);
  }
  while (lines.length > 1 && lines.at(-1) === "" && lines.at(-2) === "") lines.pop();
  if (lines.length === 1 && lines[0] === "") return "";
  if (lines.at(-1) !== "") lines.push("");
  return join(lines, newline);
}

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(text: string): Tree {
  return Bun.TOML.parse(text) as Tree;
}

/** A parsed file with one path set, on a copy. Tables along the way are made as needed. */
export function withPath(tree: Tree, path: readonly string[], value: unknown): Tree {
  const [head, ...rest] = path;
  if (head === undefined) return tree;
  if (rest.length === 0) return { ...tree, [head]: value };
  const child = tree[head];
  return { ...tree, [head]: withPath(isTree(child) ? child : {}, rest, value) };
}

/** A parsed file with one path removed, on a copy, and any table that empties with it. */
export function withoutPath(tree: Tree, path: readonly string[]): Tree {
  const [head, ...rest] = path;
  if (head === undefined || !(head in tree)) return tree;
  const next = { ...tree };
  if (rest.length === 0) {
    delete next[head];
    return next;
  }
  const child = tree[head];
  if (!isTree(child)) return tree;
  const pruned = withoutPath(child, rest);
  if (Object.keys(pruned).length === 0) delete next[head];
  else next[head] = pruned;
  return next;
}

/** Tables with nothing in them, dropped: `[tui]` with no settings says what no `[tui]` says. */
function withoutEmptyTables(value: unknown): unknown {
  if (!isTree(value)) return value;
  const next: Tree = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = withoutEmptyTables(child);
    if (isTree(pruned) && Object.keys(pruned).length === 0) continue;
    next[key] = pruned;
  }
  return next;
}

/**
 * Whether `after` parses to exactly `expected(parse(before))`.
 *
 * The check that makes a line editor safe to use on a file it does not understand: the edit is
 * held to the change it was asked for and nothing else. False for text that does not parse, so a
 * file the editor broke is never written. Empty tables are not compared, since leaving a header
 * behind or taking one away changes nothing Codex reads.
 */
export function sameExcept(before: string, after: string, expected: (tree: Tree) => Tree): boolean {
  try {
    return Bun.deepEquals(
      withoutEmptyTables(parse(after)),
      withoutEmptyTables(expected(parse(before))),
      true,
    );
  } catch {
    return false;
  }
}

/** The file as values, or null when it is not TOML this client can read. */
export function parseToml(text: string): Tree | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/** A string as a TOML basic string. JSON's escapes are TOML's, for every character a path holds. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}
