/**
 * Retrieval capture (§14 Phase 6).
 *
 * §14 asks to "capture which docs/packages the agent actually retrieved in-session". A status
 * line cannot see that — its payload carries `cwd` and `transcript_path` and nothing about
 * what was read, and reading the transcript is not an option because it is the developer's
 * conversation. See A18.
 *
 * What works is a documented `PostToolUse` hook: it receives the path the agent just read, so
 * this module resolves that path to a package **locally** and queues only the package id.
 *
 * ## The privacy rule, which is stricter here than anywhere else
 *
 * A file path is more identifying than the dependency set §10.4 already treats as sensitive.
 * `/Users/amir/Code/acme-internal/billing/rates.ts` names a person, a company, and a feature.
 * So a path never leaves the machine, and a path that does not resolve to a package is
 * dropped entirely rather than reported as "something in the project" — because "the project"
 * is the private part.
 */
import { appendFile, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import { OBRIGADO_DIR } from "./config.ts";

/** Where retrieval sits until the next status-line render ships it. */
const RETRIEVAL_PATH = join(OBRIGADO_DIR, "retrieval.jsonl");

/**
 * Where the queue lives. Injectable, like the beacon queue's `QueueLocation`, so a test can
 * point at a temporary file rather than at the developer's real one — which the tests used
 * to write into and delete on every run.
 */
export interface RetrievalLocation {
  readonly retrievalPath?: string | undefined;
}

const pathOf = (location: RetrievalLocation): string => location.retrievalPath ?? RETRIEVAL_PATH;

/**
 * Past this size the queue is started again from empty.
 *
 * "The queue is drained on every render" holds only while a status line is rendering. A
 * developer who installed the retrieval hook and not a working status line would otherwise
 * grow this file for as long as their agent read files — the outcome the cap on parsing
 * below promises to prevent and, on its own, does not.
 */
const MAX_FILE_BYTES = 256 * 1024;

/**
 * How many entries are kept.
 *
 * A session can read thousands of files. The queue is drained on every render, so this only
 * bounds a pathological burst between two renders — and a file that grows without limit in
 * `~/.obrigado` is a bug a developer would rightly resent.
 */
export const MAX_QUEUED = 2000;

/**
 * Resolve a file path to the package that owns it.
 *
 * Returns null for anything that is not inside a recognised package directory — including the
 * developer's own source, which is the case that matters most. Their code is not a package,
 * and reporting it as one would be reporting the private part of their repository.
 *
 * Deliberately string-based rather than a resolver: this runs on a hook per tool call, and
 * spawning a module resolution for each would put real latency in the agent's loop.
 */
export function packageOfPath(path: string): string | null {
  const parts = path.split(sep);

  // node_modules/<name> or node_modules/@scope/<name>
  const nodeModules = parts.lastIndexOf("node_modules");
  if (nodeModules !== -1 && nodeModules + 1 < parts.length) {
    const first = parts[nodeModules + 1];
    if (first === undefined || first.length === 0) return null;
    if (first.startsWith("@")) {
      const second = parts[nodeModules + 2];
      return second === undefined ? null : `npm:${first}/${second}`.toLowerCase();
    }
    return `npm:${first}`.toLowerCase();
  }

  // Cargo's registry layout: .../registry/src/<index>/<name>-<version>/...
  const registrySrc = parts.indexOf("registry");
  if (registrySrc !== -1 && parts[registrySrc + 1] === "src") {
    const crate = parts[registrySrc + 3];
    if (crate !== undefined) {
      // `serde-1.0.203` → `serde`. The last hyphen-number group is the version.
      const name = crate.replace(/-\d[\d.\-\w]*$/u, "");
      if (name.length > 0) return `cargo:${name}`.toLowerCase();
    }
  }

  // Python's site-packages / dist-packages.
  for (const marker of ["site-packages", "dist-packages"]) {
    const index = parts.lastIndexOf(marker);
    if (index !== -1 && index + 1 < parts.length) {
      const first = parts[index + 1];
      if (first === undefined || first.length === 0) continue;
      // Skip metadata directories: `requests-2.31.0.dist-info` is not the package.
      if (first.endsWith(".dist-info") || first.endsWith(".egg-info")) continue;
      return `pypi:${first.replace(/\.py$/u, "")}`.toLowerCase();
    }
  }

  // Go's module cache: .../pkg/mod/github.com/pkg/errors@v0.9.1/...
  const mod = parts.indexOf("mod");
  if (mod !== -1 && parts[mod - 1] === "pkg" && mod + 1 < parts.length) {
    const rest = parts.slice(mod + 1).join("/");
    const match = /^([^@]+)@/u.exec(rest);
    if (match?.[1] !== undefined) return `go:${match[1]}`.toLowerCase();
  }

  // Anything else is the developer's own code, or a path we do not understand. Dropped —
  // "somewhere in the project" is exactly the private part.
  return null;
}

/**
 * Record that the agent read a file.
 *
 * Appends rather than rewrites, so concurrent tool calls cannot lose each other's entries.
 * Silent on every failure: this runs inside the agent's tool loop, and a retrieval hook that
 * prints an error has broken something far more important than a payout multiplier.
 */
export async function recordRead(path: string, location: RetrievalLocation = {}): Promise<void> {
  const packageId = packageOfPath(path);
  if (packageId === null) return;
  const queue = pathOf(location);

  try {
    await mkdir(dirname(queue), { recursive: true });
    const info = await stat(queue).catch(() => null);
    if (info !== null && info.size > MAX_FILE_BYTES) await unlink(queue).catch(() => null);
    await appendFile(queue, `${JSON.stringify({ p: packageId })}\n`, { mode: 0o600 });
  } catch {
    // Nothing. See above.
  }
}

/**
 * Read everything queued WITHOUT clearing it.
 *
 * The session request needs the same ids the beacon reports, for a different purpose: the
 * beacon weights a payout with them, the session lets them select an ad. If the session
 * drained the queue the beacon would find it empty and §14 Phase 6's retrieval multiplier
 * would quietly stop being applied — a revenue bug with no error attached to it.
 *
 * So exactly one caller consumes, and it is still the beacon. This one only looks.
 */
export async function peekRetrieval(location: RetrievalLocation = {}): Promise<string[]> {
  try {
    return parseQueue(await readFile(pathOf(location), "utf8"));
  } catch {
    return [];
  }
}

/**
 * Take everything queued, and clear it.
 *
 * By RENAMING the file first, then reading the renamed copy. Read-then-truncate had a window:
 * a hook appending between the read and the truncate lost its entry silently, and the hook
 * runs inside the agent's tool loop, exactly when files are being read. After the rename an
 * append lands in a fresh queue, which the next hook creates with the right permissions
 * (`recordRead` sets the mode). Two concurrent drains cannot both win the rename, so nothing
 * is reported twice either.
 */
export async function drainRetrieval(location: RetrievalLocation = {}): Promise<string[]> {
  const queue = pathOf(location);
  const taken = `${queue}.draining-${process.pid}-${Date.now()}`;
  try {
    await rename(queue, taken);
  } catch {
    // Nothing queued, or another render took it a moment ago.
    return [];
  }

  try {
    return parseQueue(await readFile(taken, "utf8"));
  } catch {
    return [];
  } finally {
    await unlink(taken).catch(() => null);
  }
}

/**
 * The queue file's contents as package ids.
 *
 * Shared by `peekRetrieval` and `drainRetrieval` so the two cannot disagree about what a
 * queued line means — one of them selects an ad and the other pays a maintainer, and a
 * divergence would be a silent mismatch between what was targeted and what was credited.
 */
function parseQueue(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    if (seen.size >= MAX_QUEUED) break;
    try {
      const parsed = JSON.parse(line) as { p?: unknown };
      if (typeof parsed.p === "string" && parsed.p.includes(":")) seen.add(parsed.p);
    } catch {
      // A truncated line from a concurrent append. Skipped.
    }
  }
  return [...seen].toSorted();
}
