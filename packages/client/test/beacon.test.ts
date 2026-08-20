import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
