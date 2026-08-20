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
 */
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BeaconEvent } from "@obrigado/shared";

import { ensureDir, QUEUE_PATH } from "./config.ts";

/** Stop the queue growing without bound while offline for a long time. */
const MAX_QUEUED_EVENTS = 5_000;
const FLUSH_TIMEOUT_MS = 2_000;

interface QueuedEvent {
  readonly event: BeaconEvent;
  readonly queued_at: number;
  readonly attempts: number;
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
  await appendFile(path, `${JSON.stringify(line)}\n`);
}

async function readQueue(path: string): Promise<QueuedEvent[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];

  const text = await file.text();
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
  return events.slice(-MAX_QUEUED_EVENTS);
}

async function writeQueue(path: string, events: readonly QueuedEvent[]): Promise<void> {
  if (events.length === 0) {
    await Bun.write(path, "");
    return;
  }
  await Bun.write(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

/** Exponential backoff, capped. Attempt n waits 2^n seconds. */
function isReady(event: QueuedEvent, now: number): boolean {
  if (event.attempts === 0) return true;
  const delayMs = Math.min(2 ** event.attempts, 300) * 1000;
  return now - event.queued_at >= delayMs;
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

/**
 * Note a permanent rejection for `obrigado doctor` to report.
 *
 * Dropped impressions are lost revenue, so they must leave a trace somewhere a human will
 * look. Appended rather than overwritten, and capped, because the interesting case is a
 * pattern rather than the latest instance.
 */
async function recordDrop(queuePath: string, count: number, status: number): Promise<void> {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), count, status });
    await appendFile(dropLogPath(queuePath), `${line}\n`);
  } catch {
    // Best effort. Failing to record a drop must not fail the flush that caused it.
  }
}

/** What has been dropped, newest last, for `doctor`. */
export async function droppedEvents(
  location: QueueLocation = {},
): Promise<Array<{ at: string; count: number; status: number }>> {
  const file = Bun.file(dropLogPath(pathOf(location)));
  if (!(await file.exists())) return [];
  return (await file.text())
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

/**
 * Ship whatever is queued and ready.
 *
 * Never throws: a failed flush leaves the queue intact with attempt counts
 * bumped, and the caller (the statusline hot path) carries on regardless.
 */
export async function flushQueue(options: FlushOptions): Promise<FlushResult> {
  const path = pathOf(options);
  const queued = await readQueue(path);
  if (queued.length === 0) return { sent: 0, kept: 0, dropped: 0 };

  const now = Date.now();
  const ready = queued.filter((event) => isReady(event, now));
  const waiting = queued.filter((event) => !isReady(event, now));

  if (ready.length === 0) return { sent: 0, kept: queued.length, dropped: 0 };

  try {
    const response = await fetch(`${options.apiOrigin}/api/v1/beacon`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Obrigado-Key": options.installKey,
      },
      body: JSON.stringify({ events: ready.map((entry) => entry.event) }),
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
    if (isPermanentRejection(response.status)) {
      await writeQueue(path, waiting);
      // Reported, never printed. This runs on the statusline path, where anything on stderr
      // lands in the developer's terminal on every repaint — `obrigado doctor` is where a
      // human asks about queue health, and it is the caller's job to say so.
      await recordDrop(path, ready.length, response.status);
      return { sent: 0, kept: waiting.length, dropped: ready.length };
    }

    if (!response.ok) throw new Error(`beacon returned ${response.status}`);

    await writeQueue(path, waiting);
    return { sent: ready.length, kept: waiting.length, dropped: 0 };
  } catch {
    // Offline, timed out, or a 5xx. Transient by assumption: keep everything, bump attempts
    // so the backoff widens, and try again next render.
    const retried: QueuedEvent[] = ready.map((entry) => ({
      event: entry.event,
      queued_at: entry.queued_at,
      attempts: entry.attempts + 1,
    }));
    await writeQueue(path, [...waiting, ...retried]);
    return { sent: 0, kept: queued.length, dropped: 0 };
  }
}

export async function queueDepth(location: QueueLocation = {}): Promise<number> {
  return (await readQueue(pathOf(location))).length;
}
