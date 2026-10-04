/**
 * The timing the mod rebuilds for the classifier, in the status line's own fields.
 */
import { describe, expect, test } from "bun:test";

import { sessionTiming } from "../hooks/timing.ts";

describe("the session's timing", () => {
  test("is nothing before the session has started", () => {
    expect(sessionTiming().cost(1_000)).toBeUndefined();
  });

  test("counts the wall clock from the start and the time requests were in flight", () => {
    const timing = sessionTiming();
    timing.start(10_000);
    timing.request(11_000, 14_000);
    timing.request(20_000, 22_500);

    expect(timing.cost(40_000)).toEqual({
      total_duration_ms: 30_000,
      total_api_duration_ms: 5_500,
    });
  });

  test("counts overlapping requests twice, as the status line does", () => {
    // Two subagents in flight together: less time reads as a person's, never more.
    const timing = sessionTiming();
    timing.start(0);
    timing.request(1_000, 9_000);
    timing.request(2_000, 10_000);

    expect(timing.cost(10_000)?.total_api_duration_ms).toBe(16_000);
  });

  test("starts over when the session starts again", () => {
    const timing = sessionTiming();
    timing.start(0);
    timing.request(0, 5_000);
    timing.start(60_000);

    expect(timing.cost(61_000)).toEqual({ total_duration_ms: 1_000, total_api_duration_ms: 0 });
  });

  test("never goes negative on a clock that stepped back", () => {
    const timing = sessionTiming();
    timing.start(5_000);
    timing.request(3_000, 2_000);

    expect(timing.cost(4_000)).toEqual({ total_duration_ms: 0, total_api_duration_ms: 0 });
  });

  test("is spelled as the status line spells it", () => {
    // The renderer reads `cost` with the code it reads Claude Code's payload with, so these two
    // names are the whole interface: nothing on that side knows the figures came from a mod.
    const timing = sessionTiming();
    timing.start(0);

    expect(Object.keys(timing.cost(1_000) ?? {}).toSorted()).toEqual([
      "total_api_duration_ms",
      "total_duration_ms",
    ]);
  });
});
