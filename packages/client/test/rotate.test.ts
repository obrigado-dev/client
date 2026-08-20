import { describe, expect, test } from "bun:test";

import { BATCH_SIZE, BATCH_TTL_SECONDS, ROTATION_SECONDS } from "@obrigado/shared";
import type { BatchItem, SessionResponse } from "@obrigado/shared";

import {
  cacheFromResponse,
  isExhausted,
  isExpired,
  nextCreative,
  nextFreshCreative,
  ROTATE_AFTER_MS,
  selectCreative,
} from "@obrigado/shared/rotation";

const creative = (n: number): BatchItem =>
  ({
    impression_id: `0000000${n}-0000-0000-0000-000000000000`,
    nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
    body: `creative ${n}`,
    click_url: "https://obrigado.dev/c/t",
    style: "default",
    effect: "none",
    spans: [],
    brand: null,
    rev_micros: 3000,
  }) as BatchItem;

const response = (count: number): SessionResponse =>
  ({
    fp: "a".repeat(32),
    batch: Array.from({ length: count }, (_, i) => creative(i)),
    ttl_seconds: 900,
    serving: true,
  }) as SessionResponse;

const START = 1_000_000;

describe("rotation is time-based, not render-based", () => {
  test("repeated renders inside the hold window show the SAME creative", () => {
    // Claude Code repaints whenever session state changes — roughly every three
    // seconds during active work. Advancing per repaint made the ad flicker and
    // made dwell meaningless.
    const batch = cacheFromResponse(response(4), START);

    const bodies = [0, 1_000, 5_000, 20_000, 29_999].map(
      (offset) => nextCreative(batch, START + offset)?.item.body,
    );

    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe("creative 0");
  });

  test("advances once the hold window elapses", () => {
    const batch = cacheFromResponse(response(4), START);

    expect(nextCreative(batch, START)?.item.body).toBe("creative 0");
    expect(nextCreative(batch, START + ROTATE_AFTER_MS)?.item.body).toBe("creative 1");
    expect(nextCreative(batch, START + ROTATE_AFTER_MS * 2)?.item.body).toBe("creative 2");
  });

  test("a long gap advances exactly one step, not many", () => {
    // Otherwise returning to a terminal after ten idle minutes would burn most
    // of the batch in a single render, reporting impressions nobody saw.
    const batch = cacheFromResponse(response(4), START);
    nextCreative(batch, START);

    // Ten minutes — long, but inside the fifteen-minute batch TTL.
    expect(nextCreative(batch, START + 600_000)?.item.body).toBe("creative 1");
  });

  test("wraps around the batch", () => {
    const batch = cacheFromResponse(response(2), START);
    const seen = [0, 1, 2, 3].map(
      (n) => nextCreative(batch, START + ROTATE_AFTER_MS * n)?.item.body,
    );
    expect(seen).toEqual(["creative 0", "creative 1", "creative 0", "creative 1"]);
  });

  test("the hold window is long enough to clear a ten-second exposure bar", () => {
    // §5's reference implementation required ten continuous seconds of screen
    // time for a billable impression. A three-second rotation could not.
    expect(ROTATE_AFTER_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("impression reporting", () => {
  test("browser surfaces can select without reporting until viewability is confirmed", () => {
    const batch = cacheFromResponse(response(2), START);

    expect(selectCreative(batch, START)?.fresh).toBe(true);
    expect(batch.reported).toEqual([]);
  });

  test("ephemeral surfaces select a fresh nonce on every turn", () => {
    const batch = cacheFromResponse(response(3), START);
    expect(nextFreshCreative(batch, START)?.item.body).toBe("creative 0");
    expect(nextFreshCreative(batch, START + 1_000)?.item.body).toBe("creative 1");
    expect(nextFreshCreative(batch, START + 2_000)?.item.body).toBe("creative 2");
    expect(nextFreshCreative(batch, START + 3_000)).toBeNull();
  });

  test("a creative is reported fresh exactly once, however many repaints", () => {
    const batch = cacheFromResponse(response(3), START);

    expect(nextCreative(batch, START)?.fresh).toBe(true);
    expect(nextCreative(batch, START + 1_000)?.fresh).toBe(false);
    expect(nextCreative(batch, START + 29_000)?.fresh).toBe(false);
    // Next creative is fresh again.
    expect(nextCreative(batch, START + ROTATE_AFTER_MS)?.fresh).toBe(true);
  });

  test("returning to a creative after a full cycle does not re-report it", () => {
    // INVARIANT 5: nonce-bound and once-only. The server would reject a repeat
    // anyway; not sending it keeps the beacon queue honest.
    const batch = cacheFromResponse(response(2), START);
    nextCreative(batch, START);
    nextCreative(batch, START + ROTATE_AFTER_MS);
    expect(nextCreative(batch, START + ROTATE_AFTER_MS * 2)?.fresh).toBe(false);
  });
});

describe("nothing renders when nothing should", () => {
  test("an expired batch renders nothing", () => {
    const batch = cacheFromResponse(response(2), START);
    expect(isExpired(batch, START + 901_000)).toBe(true);
    expect(nextCreative(batch, START + 901_000)).toBeNull();
  });

  test("serving off renders nothing", () => {
    const batch = cacheFromResponse({ ...response(2), serving: false } as SessionResponse, START);
    expect(nextCreative(batch, START)).toBeNull();
  });

  test("an empty batch renders nothing", () => {
    const batch = cacheFromResponse(response(0), START);
    expect(nextCreative(batch, START)).toBeNull();
  });
});

describe("a batch must cover its own TTL", () => {
  test("rotation period x batch size covers the TTL", () => {
    // These three numbers are one system. When they disagreed — 12 creatives
    // rotating every 30s against a 900s TTL — the batch was exhausted after 360s
    // and the client displayed ads for the remaining 540s while recording
    // nothing. A 60% under-count that no test caught, because each constant was
    // individually reasonable.
    expect(ROTATION_SECONDS * BATCH_SIZE).toBeGreaterThanOrEqual(BATCH_TTL_SECONDS);
  });

  test("ROTATE_AFTER_MS is derived from the shared constant, not restated", () => {
    expect(ROTATE_AFTER_MS).toBe(ROTATION_SECONDS * 1000);
  });
});

describe("exhaustion is staleness", () => {
  test("a batch with every creative reported is exhausted", () => {
    // An exhausted batch still rotates, but nothing new is counted — so serving
    // from it means displaying advertisements for free.
    const batch = cacheFromResponse(response(3), START);
    expect(isExhausted(batch)).toBe(false);

    for (let n = 0; n < 3; n += 1) nextCreative(batch, START + ROTATE_AFTER_MS * n);

    expect(batch.reported).toHaveLength(3);
    expect(isExhausted(batch)).toBe(true);
  });

  test("an empty batch is not 'exhausted' — it is simply empty", () => {
    expect(isExhausted(cacheFromResponse(response(0), START))).toBe(false);
  });

  test("a partly-shown batch is not exhausted", () => {
    const batch = cacheFromResponse(response(4), START);
    nextCreative(batch, START);
    expect(isExhausted(batch)).toBe(false);
  });
});
