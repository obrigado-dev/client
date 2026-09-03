import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BEACON_MAX_EVENTS } from "@obrigado/shared";

import { droppedEvents, enqueue, flushQueue, queueDepth } from "../src/beacon.ts";

/**
 * The beacon queue, against a real HTTP server.
 *
 * These exist because of a bug no amount of type checking would have found: the
 * flush was fire-and-forget before `process.exit()`, so beacons sat in the queue
 * with `attempts: 0` forever — never sent, and never retried either, because a
 * retry only records itself when an attempt FAILS and no attempt ever completed.
 * The client reported no impressions at all, so nothing was billed.
 *
 * The queue path is injected rather than taken from `HOME`, which is also a
 * lesson learned: an earlier version of this file set `process.env.HOME` and
 * imported the module, but the path is resolved from `homedir()` at import time,
 * so the tests wrote into the developer's real queue.
 */

let queuePath: string;
let dir: string;
let server: ReturnType<typeof Bun.serve>;
let received: Array<{ events: unknown[] }>;
let respondWith = 200;
let lastInstallKey: string | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "obrigado-beacon-"));
  queuePath = join(dir, "queue.jsonl");
  received = [];
  respondWith = 200;
  lastInstallKey = null;

  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      lastInstallKey = request.headers.get("X-Obrigado-Key");
      received.push((await request.json()) as { events: unknown[] });
      return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: respondWith });
    },
  });
});

afterEach(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const origin = (): string => `http://localhost:${server.port}`;
const impression = (n: number) =>
  ({
    type: "impression" as const,
    impression_id: `${n}${n}${n}${n}${n}${n}${n}${n}-1111-1111-1111-111111111111`,
    nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
  }) as const;

describe("flushQueue", () => {
  test("sends queued events and empties the queue", async () => {
    await enqueue(impression(1), { queuePath });
    expect(await queueDepth({ queuePath })).toBe(1);

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(result.sent).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.events).toHaveLength(1);
    // Emptied, so the next render does not re-send what already landed.
    expect(await queueDepth({ queuePath })).toBe(0);
  });

  test("sends the install key so the server can attribute the impression", async () => {
    await enqueue(impression(2), { queuePath });
    await flushQueue({ apiOrigin: origin(), installKey: "abcdefghijklmnop", queuePath });

    expect(lastInstallKey).toBe("abcdefghijklmnop");
  });

  test("KEEPS events and records an attempt when the server rejects", async () => {
    // The bug this guards: an attempt that never completes leaves `attempts` at
    // 0 and the event un-retried forever.
    respondWith = 500;
    await enqueue(impression(3), { queuePath });

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(result.sent).toBe(0);
    expect(await queueDepth({ queuePath })).toBe(1);
    expect(JSON.parse((await readFile(queuePath, "utf8")).trim()).attempts).toBe(1);
  });

  test("keeps events when the server is unreachable", async () => {
    await enqueue(impression(4), { queuePath });

    // A port nothing is listening on.
    const result = await flushQueue({
      apiOrigin: "http://127.0.0.1:1",
      installKey: "k".repeat(32),
      queuePath,
    });

    expect(result.sent).toBe(0);
    expect(await queueDepth({ queuePath })).toBe(1);
  });

  test("never throws, whatever the origin is", async () => {
    // The statusline path must never print to a developer's terminal.
    await enqueue(impression(5), { queuePath });
    await expect(
      flushQueue({ apiOrigin: "not-a-url", installKey: "k".repeat(32), queuePath }),
    ).resolves.toEqual({ sent: 0, kept: 1, dropped: 0 });
  });

  test("an empty queue is a no-op that makes no request", async () => {
    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(result).toEqual({ sent: 0, kept: 0, dropped: 0 });
    expect(received).toHaveLength(0);
  });

  test("batches everything ready into ONE request", async () => {
    for (let n = 0; n < 5; n += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- appends must land in order
      await enqueue(impression(n), { queuePath });
    }

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(result.sent).toBe(5);
    expect(received).toHaveLength(1);
    expect(received[0]?.events).toHaveLength(5);
  });

  test("a truncated final line is dropped rather than failing the flush", async () => {
    // The queue is appended to by a process that can be killed mid-write.
    await enqueue(impression(6), { queuePath });
    await Bun.write(queuePath, `${await readFile(queuePath, "utf8")}{"event":{"type":"impr`);

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });
    expect(result.sent).toBe(1);
  });
});

describe("a batch the server will never accept", () => {
  /**
   * The bug this pins cost every impression after it.
   *
   * The beacon validates the WHOLE request, so a single malformed event 400s the entire
   * batch — including the valid events sent alongside it. The client used to keep everything
   * and retry, so the queue never drained and nothing was ever billed again. Observed on a
   * real install: 25 events queued, one retried 185 times, one impression recorded all day
   * while the status line rotated normally.
   *
   * The trigger was mundane — a session ran past the timing bound and `session_s` failed its
   * range check — which is the point. Any future validation mismatch would do it.
   */
  test("a 400 drops the batch instead of blocking the queue forever", async () => {
    respondWith = 400;
    for (let n = 0; n < 3; n += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- appends must land in order
      await enqueue(impression(n), { queuePath });
    }

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(result).toEqual({ sent: 0, kept: 0, dropped: 3 });
    expect(await queueDepth({ queuePath })).toBe(0);
  });

  test("so a later valid impression still gets through", async () => {
    respondWith = 400;
    await enqueue(impression(1), { queuePath });
    await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    // The whole point: the poison is gone, so the next one is not stuck behind it.
    respondWith = 200;
    await enqueue(impression(2), { queuePath });
    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(result.sent).toBe(1);
    expect(await queueDepth({ queuePath })).toBe(0);
  });

  test("the drop is recorded, because dropped impressions are lost money", async () => {
    respondWith = 400;
    await enqueue(impression(1), { queuePath });
    await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    const dropped = await droppedEvents({ queuePath });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ count: 1, status: 400 });
  });

  test("nothing is written to stderr, which would reach the developer's terminal", async () => {
    // The statusline path calls this on every repaint. A console.error here would print into
    // the terminal each time — which is why the drop is recorded to a file for `status` and
    // `doctor` to report instead.
    const source = await Bun.file(new URL("../src/beacon.ts", import.meta.url).pathname).text();
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/[^\n]*/gu, "");

    expect(code).not.toMatch(/console\.(error|warn|log)/u);
  });

  test("429 and 408 are retried, not dropped — they mean try again", async () => {
    for (const status of [429, 408]) {
      respondWith = status;
      // oxlint-disable-next-line eslint/no-await-in-loop -- one status at a time, and each asserts before the next
      await enqueue(impression(status), { queuePath });
      // oxlint-disable-next-line eslint/no-await-in-loop -- see above
      const result = await flushQueue({
        apiOrigin: origin(),
        installKey: "k".repeat(32),
        queuePath,
      });
      expect(result.dropped).toBe(0);
      expect(result.kept).toBeGreaterThan(0);
      // oxlint-disable-next-line eslint/no-await-in-loop -- see above
      await Bun.write(queuePath, "");
    }
  });

  test("a 5xx is retried, not dropped", async () => {
    respondWith = 503;
    await enqueue(impression(9), { queuePath });

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(result).toEqual({ sent: 0, kept: 1, dropped: 0 });
  });
});

describe("a queue larger than one request", () => {
  test("is sent in chunks the server accepts, not refused as a whole", async () => {
    // The server validates the whole request and caps it at BEACON_MAX_EVENTS. A queue past
    // that used to go in one piece, be 400'd, and — because a 400 is permanent — be dropped
    // in full. Every impression of a long outage, lost at the moment connectivity returned.
    const lines = Array.from({ length: BEACON_MAX_EVENTS + 1 }, (_, n) =>
      JSON.stringify({ event: impression(n % 10), queued_at: Date.now(), attempts: 0 }),
    );
    await Bun.write(queuePath, `${lines.join("\n")}\n`);

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(result).toEqual({ sent: BEACON_MAX_EVENTS + 1, kept: 0, dropped: 0 });
    expect(received).toHaveLength(2);
    expect(received[0]?.events).toHaveLength(BEACON_MAX_EVENTS);
    expect(received[1]?.events).toHaveLength(1);
  });

  test("stops at the first transient failure rather than hammering a dead server", async () => {
    respondWith = 503;
    const lines = Array.from({ length: BEACON_MAX_EVENTS + 1 }, (_, n) =>
      JSON.stringify({ event: impression(n % 10), queued_at: Date.now(), attempts: 0 }),
    );
    await Bun.write(queuePath, `${lines.join("\n")}\n`);

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(received).toHaveLength(1);
    expect(result).toEqual({ sent: 0, kept: BEACON_MAX_EVENTS + 1, dropped: 0 });
  });
});

describe("backoff", () => {
  test("is measured from the last attempt, so a failed event is not retried on the next render", async () => {
    // It used to be measured from when the event was queued. Once an event was five minutes
    // old the wait was satisfied forever, and an offline laptop made a full-timeout request on
    // every repaint of the status line.
    respondWith = 503;
    await enqueue(impression(1), { queuePath });
    await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });
    expect(received).toHaveLength(1);

    respondWith = 200;
    const again = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    // Not ready yet: one attempt means a two-second wait, and no time has passed.
    expect(again).toEqual({ sent: 0, kept: 1, dropped: 0 });
    expect(received).toHaveLength(1);
  });

  test("widens with each attempt", async () => {
    // An event queued long ago that has already failed several times must still wait.
    const line = JSON.stringify({
      event: impression(2),
      queued_at: Date.now() - 60 * 60 * 1000,
      attempts: 6,
      last_attempt_at: Date.now() - 30 * 1000,
    });
    await Bun.write(queuePath, `${line}\n`);

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    // 2^6 = 64 seconds since the last attempt, and only 30 have passed.
    expect(result).toEqual({ sent: 0, kept: 1, dropped: 0 });
    expect(received).toHaveLength(0);
  });
});

describe("two renders flushing at once", () => {
  test("an event appended during another process's flush is not lost", async () => {
    // The lost-write race: a flush read the queue, sent, and rewrote the file in place, so
    // an append that landed between the read and the rewrite was destroyed. Renaming the
    // queue before reading it means the append lands in a fresh file instead.
    await enqueue(impression(1), { queuePath });

    // A server that holds the request open long enough for a second process to append.
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push((await request.json()) as { events: unknown[] });
        await held;
        return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 200 });
      },
    });

    const flushing = flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });
    // Give the flush time to claim the queue and start its request.
    await Bun.sleep(50);
    await enqueue(impression(2), { queuePath });
    release();
    const result = await flushing;

    expect(result.sent).toBe(1);
    // The second event is still queued for the next flush, in the fresh file.
    expect(await queueDepth({ queuePath })).toBe(1);
  });

  test("a flushing file left by a dead process is adopted, not orphaned", async () => {
    const orphan = `${queuePath}.flushing-99999-1-0`;
    await Bun.write(
      orphan,
      `${JSON.stringify({ event: impression(3), queued_at: Date.now(), attempts: 0 })}\n`,
    );
    // Old enough to be considered abandoned.
    const { utimes } = await import("node:fs/promises");
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(orphan, old, old);

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(result.sent).toBe(1);
    expect(await Bun.file(orphan).exists()).toBe(false);
  });

  test("a flushing file another process is still using is left alone", async () => {
    const live = `${queuePath}.flushing-99998-1-0`;
    await Bun.write(
      live,
      `${JSON.stringify({ event: impression(4), queued_at: Date.now(), attempts: 0 })}\n`,
    );

    const result = await flushQueue({ apiOrigin: origin(), installKey: "k".repeat(32), queuePath });

    expect(result.sent).toBe(0);
    expect(await Bun.file(live).exists()).toBe(true);
    // Still counted, because it has not been sent by anyone yet.
    expect(await queueDepth({ queuePath })).toBe(1);
  });
});
