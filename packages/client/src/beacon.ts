/**
 * Beacon queue (§12: "Client buffers offline and retries with exponential
 * backoff").
 *
 * The statusline command runs on every render and must never block on the
 * network — a spinner that stutters because an ad server is slow is a reason to
 * uninstall. So events are appended to a local JSONL queue, and flushing is
 * opportunistic: the next invocation ships whatever accumulated, with a short
 * timeout and a backoff that survives being offline.
 *
 * INVARIANT 5 makes this safe: beacons are nonce-bound and idempotent, so
 * re-sending a batch that may already have landed cannot double-count.
 *
 * ## Why a flush RENAMES the queue before reading it
 *
 * Several renders run at once as a matter of course — two agent panes, an editor poll beside
 * a terminal — and each one appends to the queue and flushes it. The first version read the
 * file, sent, and rewrote it in place, so an event another process appended between that read
 * and that rewrite was destroyed: a billable impression, silently, with no drop recorded
 * because nothing knew. Renaming the file first is what makes the two safe together. Appends
 * after the rename land in a fresh queue; the flushing process owns its renamed file alone;
 * and if it dies mid-send, the file it left behind is adopted by a later flush rather than
 * lost. Only one of two concurrent flushes wins the rename, and the other finds nothing to do.
 */
import { appendFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { API_VERSION, BEACON_MAX_EVENTS } from "@obrigado/shared";
import type { BeaconEvent } from "@obrigado/shared";

import { ensureDir, QUEUE_PATH } from "./config.ts";

/** Stop the queue growing without bound while offline for a long time. */
const MAX_QUEUED_EVENTS = 5_000;

/**
 * How long one flush may spend on the network.
 *
 * Strictly under the two seconds every host gives the renderer before it gives up on the
 * child (OpenCode, VS Code and Pi all read until the process exits). A flush that used the
 * full two seconds guaranteed the host timed out and drew nothing, for an impression that
 * was already queued — so the render budget is the ceiling here, with room to spare.
 */
const FLUSH_TIMEOUT_MS = 1_200;

/**
 * A flushing file older than this belongs to a process that died mid-send.
 *
 * A live flush takes at most `FLUSH_TIMEOUT_MS` per chunk; a minute is far past any honest
 * duration and short enough that an orphaned impression is retried before its nonce expires.
 */
const ORPHAN_AFTER_MS = 60_000;

/** The longest wait between attempts, in seconds. */
const MAX_BACKOFF_S = 300;

interface QueuedEvent {
  readonly event: BeaconEvent;
  readonly queued_at: number;
  readonly attempts: number;
  /** When the last attempt was made. Absent on an event that has never been sent. */
  readonly last_attempt_at?: number | undefined;
}

/**
 * Where the queue lives. Injectable rather than module-global so tests can point
 * at a temporary file — a module-level path resolved from `homedir()` at import
 * time cannot be redirected afterwards, and a test that tries writes to the
 * developer's real queue instead.
 */
export interface QueueLocation {
  readonly queuePath?: string | undefined;
}

const pathOf = (location: QueueLocation): string => location.queuePath ?? QUEUE_PATH;

export async function enqueue(event: BeaconEvent, location: QueueLocation = {}): Promise<void> {
  const path = pathOf(location);
  await ensureDir(dirname(path));
  const line: QueuedEvent = { event, queued_at: Date.now(), attempts: 0 };
  // 0600: the queue holds nonces, which are the bearer values that confirm a billable
  // impression. The mode applies when the file is created, which is the moment that matters.
  await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

function parseQueue(text: string): QueuedEvent[] {
  const events: QueuedEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as QueuedEvent);
    } catch {
      // A truncated final line (killed mid-append) is dropped rather than
      // failing the whole flush.
    }
  }
  return events;
}

async function readIfPresent(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "";
  return await file.text();
}

/** The name a flushing process gives the file it has taken. */
function claimName(path: string, now: number, ordinal: number): string {
  return `${path}.flushing-${process.pid}-${now}-${ordinal}`;
}

/**
 * Take ownership of everything queued: the live queue, and any flushing file another
 * process abandoned. Each is renamed to a name only this process uses, so ownership is
 * decided by the filesystem rather than by luck.
 */
async function claimQueue(
  path: string,
  now: number,
): Promise<{ claimed: string[]; events: QueuedEvent[] }> {
  const claimed: string[] = [];
  const prefix = `${basename(path)}.flushing-`;

  // No directory means nothing has ever been queued.
  const siblings = await readdir(dirname(path)).catch((): string[] => []);
  for (const name of siblings) {
    if (!name.startsWith(prefix)) continue;
    const orphan = join(dirname(path), name);
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each adoption is a rename that may lose to another process; the next candidate is independent
      const info = await stat(orphan);
      if (now - info.mtimeMs < ORPHAN_AFTER_MS) continue;
      const mine = claimName(path, now, claimed.length);
      // oxlint-disable-next-line eslint/no-await-in-loop -- see above
      await rename(orphan, mine);
      claimed.push(mine);
    } catch {
      // Another flush adopted it first, or it was just deleted. Either way, not ours.
    }
  }

  try {
    const mine = claimName(path, now, claimed.length);
    await rename(path, mine);
    claimed.push(mine);
  } catch {
    // Nothing queued, or a concurrent flush took it a moment ago. Both mean nothing to send.
  }

  const events: QueuedEvent[] = [];
  for (const file of claimed) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the files are read in the order they were claimed, oldest orphan first
    events.push(...parseQueue(await readIfPresent(file)));
  }
  return { claimed, events: events.slice(-MAX_QUEUED_EVENTS) };
}

/** Put events back on the live queue, behind anything appended since the claim. */
async function requeue(path: string, events: readonly QueuedEvent[]): Promise<void> {
  if (events.length === 0) return;
  await ensureDir(dirname(path));
  await appendFile(path, `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
    mode: 0o600,
  });
}

async function discard(files: readonly string[]): Promise<void> {
  await Promise.all(files.map((file) => unlink(file).catch(() => null)));
}

/**
 * Exponential backoff, capped, measured from the LAST attempt.
 *
 * Attempt n waits 2^n seconds, to five minutes. It used to be measured from when the event
 * was queued, which is not a backoff at all: once an event was five minutes old the wait
 * was satisfied forever, and every render on an offline machine made a full-timeout request.
 */
function isReady(event: QueuedEvent, now: number): boolean {
  if (event.attempts === 0) return true;
  const since = event.last_attempt_at ?? event.queued_at;
  const delayMs = Math.min(2 ** event.attempts, MAX_BACKOFF_S) * 1000;
  return now - since >= delayMs;
}

/**
 * A status the server will return again for the identical body.
 *
 * 408 (timeout) and 429 (rate limited) are the two 4xx that mean "try again"; everything
 * else in that range says the request itself is wrong, and the request will not change.
 */
function isPermanentRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export interface FlushResult {
  readonly sent: number;
  readonly kept: number;
  /** Events the server rejected permanently. Lost, and recorded so `doctor` can say so. */
  readonly dropped: number;
}

/** Where a permanent rejection is recorded, beside the queue it was dropped from. */
const dropLogPath = (queuePath: string): string => `${queuePath}.dropped`;

/** How many drop records are kept. The interesting thing is a pattern, not the history. */
const DROP_LOG_LINES = 200;

/**
 * Note a permanent rejection for `obrigado doctor` to report.
 *
 * Dropped impressions are lost revenue, so they must leave a trace somewhere a human will
 * look. Appended rather than overwritten, and capped, because the interesting case is a
 * pattern rather than the latest instance.
 */
async function recordDrop(queuePath: string, count: number, status: number): Promise<void> {
  try {
    const path = dropLogPath(queuePath);
    const line = JSON.stringify({ at: new Date().toISOString(), count, status });
    const existing = (await readIfPresent(path)).split("\n").filter((entry) => entry.length > 0);
    const kept = [...existing, line].slice(-DROP_LOG_LINES);
    await Bun.write(path, `${kept.join("\n")}\n`);
  } catch {
    // Best effort. Failing to record a drop must not fail the flush that caused it.
  }
}

/** What has been dropped, newest last, for `doctor`. */
export async function droppedEvents(
  location: QueueLocation = {},
): Promise<Array<{ at: string; count: number; status: number }>> {
  return (await readIfPresent(dropLogPath(pathOf(location))))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { at: string; count: number; status: number }];
      } catch {
        return [];
      }
    });
}

export interface FlushOptions extends QueueLocation {
  readonly apiOrigin: string;
  readonly installKey: string;
  /** Hook paths use a shorter budget than an interactive diagnostics command. */
  readonly timeoutMs?: number;
}

type SendOutcome = "sent" | "dropped" | "retry";

async function send(options: FlushOptions, events: readonly QueuedEvent[]): Promise<SendOutcome> {
  try {
    const response = await fetch(`${options.apiOrigin}/api/${API_VERSION}/beacon`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Obrigado-Key": options.installKey,
      },
      body: JSON.stringify({ events: events.map((entry) => entry.event) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? FLUSH_TIMEOUT_MS),
    });

    // A 4xx will never succeed on retry, and retrying it is not merely wasteful — the
    // beacon validates the WHOLE batch, so one permanently-invalid event 400s every event
    // sent alongside it. Keeping them means the queue never drains and no impression is ever
    // billed again. That happened: a session ran past the timing bound, twenty-five events
    // piled up, one had been retried 185 times, and the developer saw the status line rotate
    // while nothing was counted.
    //
    // So a permanent rejection drops the batch. Dropping loses those impressions; keeping
    // them loses those AND every impression after, forever. 408 and 429 are excluded because
    // they are the two 4xx that genuinely mean "try again".
    if (isPermanentRejection(response.status)) return "dropped";
    return response.ok ? "sent" : "retry";
  } catch {
    // Offline, timed out, or unreachable. Transient by assumption.
    return "retry";
  }
}

/**
 * Ship whatever is queued and ready.
 *
 * Never throws: a failed flush leaves the queue intact with attempt counts
 * bumped, and the caller (the statusline hot path) carries on regardless.
 *
 * Sent in chunks of `BEACON_MAX_EVENTS`, which is what the server accepts per request. A
 * queue that had grown past it — several agents, a long outage — used to go in one request,
 * be refused as a whole, and be DROPPED as a whole, because a 400 is a permanent rejection.
 * The first chunk that fails transiently ends the flush: the server is down, and the rest
 * would only hammer it.
 */
export async function flushQueue(options: FlushOptions): Promise<FlushResult> {
  const path = pathOf(options);
  const now = Date.now();
  const { claimed, events } = await claimQueue(path, now);

  if (events.length === 0) {
    await discard(claimed);
    return { sent: 0, kept: 0, dropped: 0 };
  }

  const ready = events.filter((event) => isReady(event, now));
  const kept: QueuedEvent[] = events.filter((event) => !isReady(event, now));
  let sent = 0;
  let dropped = 0;

  for (let start = 0; start < ready.length; start += BEACON_MAX_EVENTS) {
    const chunk = ready.slice(start, start + BEACON_MAX_EVENTS);
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks go one at a time so a dead server is hit once, not once per chunk
    const outcome = await send(options, chunk);

    if (outcome === "sent") {
      sent += chunk.length;
      continue;
    }
    if (outcome === "dropped") {
      dropped += chunk.length;
      // Reported, never printed. This runs on the statusline path, where anything on stderr
      // lands in the developer's terminal on every repaint — `obrigado doctor` is where a
      // human asks about queue health, and it is the caller's job to say so.
      // oxlint-disable-next-line eslint/no-await-in-loop -- see above
      await recordDrop(path, chunk.length, 400);
      continue;
    }

    // Transient. This chunk is retried later with a wider backoff; the chunks after it were
    // never attempted and keep their counts.
    for (const entry of chunk) {
      kept.push({ ...entry, attempts: entry.attempts + 1, last_attempt_at: now });
    }
    kept.push(...ready.slice(start + BEACON_MAX_EVENTS));
    break;
  }

  await requeue(path, kept);
  await discard(claimed);
  return { sent, kept: kept.length, dropped };
}

/** Everything queued, including what a flush in progress or a dead one is holding. */
export async function queueDepth(location: QueueLocation = {}): Promise<number> {
  const path = pathOf(location);
  let depth = parseQueue(await readIfPresent(path)).length;

  const prefix = `${basename(path)}.flushing-`;
  const siblings = await readdir(dirname(path)).catch((): string[] => []);
  for (const name of siblings) {
    if (!name.startsWith(prefix)) continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of files at most, read for a diagnostic count
    depth += parseQueue(await readIfPresent(join(dirname(path), name))).length;
  }
  return depth;
}
