/**
 * A batch stops being right when the agent starts reading something else.
 *
 * Activity targeting selects on recently-read packages, and a batch is rotated locally for
 * `BATCH_TTL_SECONDS` — so the signal was live and the inventory was not: an agent that opened
 * the Postgres docs a minute after fetching kept seeing the previous quarter-hour's ads. This
 * is the third staleness reason, beside age and exhaustion, and the one that makes the
 * difference between "recent intent" and intent.
 */
import { describe, expect, test } from "bun:test";

import { ACTIVITY_REFETCH_FLOOR_MS, activityMoved, retrievalDigest } from "../src/rotation.ts";
import type { CachedBatch } from "../src/rotation.ts";

/** Activity sharing off: the batch carries no digest, or the client is sending no retrieval. */
const NOT_SHARED = undefined;

function batch(retrieval: string | undefined, fetchedAt = 0): CachedBatch {
  return {
    fp: "f".repeat(32),
    batch: [],
    serving: true,
    fetched_at: fetchedAt,
    expires_at: fetchedAt + 900_000,
    cursor: 0,
    shown_at: fetchedAt,
    reported: [],
    ...(retrieval === undefined ? {} : { retrieval }),
  };
}

describe("retrievalDigest", () => {
  test("order does not matter, because a set has none", () => {
    expect(retrievalDigest(["npm:pg", "npm:react"])).toBe(retrievalDigest(["npm:react", "npm:pg"]));
  });

  test("a different set is a different digest", () => {
    expect(retrievalDigest(["npm:pg"])).not.toBe(retrievalDigest(["npm:pg", "npm:react"]));
  });

  test("nothing shared is not the same as nothing read", () => {
    // undefined means activity is not shared and retrieval was never sent; an empty array
    // means it was sent and was empty. Collapsing them would make a batch fetched with
    // sharing off look stale the moment somebody read a file.
    expect(retrievalDigest(NOT_SHARED)).toBeUndefined();
    expect(retrievalDigest([])).toBe("");
  });
});

describe("activityMoved", () => {
  const now = ACTIVITY_REFETCH_FLOOR_MS * 2;

  test("a changed set past the floor is stale", () => {
    expect(activityMoved(batch("npm:react"), "npm:pg", now)).toBe(true);
  });

  test("an unchanged set is not", () => {
    expect(activityMoved(batch("npm:pg"), "npm:pg", now)).toBe(false);
  });

  test("a change inside the floor waits", () => {
    // A status line renders many times a second and an agent reading files changes this set
    // constantly, so "refetch whenever it changed" is a request per render. The floor bounds
    // it to roughly one a minute.
    expect(activityMoved(batch("npm:react"), "npm:pg", ACTIVITY_REFETCH_FLOOR_MS - 1)).toBe(false);
    expect(activityMoved(batch("npm:react"), "npm:pg", ACTIVITY_REFETCH_FLOOR_MS)).toBe(true);
  });

  test("a batch chosen without activity never goes stale for it", () => {
    // Sharing was off when this was fetched, so retrieval did not select it and retrieval
    // changing cannot make it wrong. Refetching here would spend a request to get the same
    // ads back.
    expect(activityMoved(batch(NOT_SHARED), "npm:pg", now)).toBe(false);
  });

  test("a reader who turned activity off does not thrash", () => {
    // The mirror case: the batch carries a digest, the client is no longer sending retrieval.
    // Treating that as movement would refetch on every render forever.
    expect(activityMoved(batch("npm:pg"), NOT_SHARED, now)).toBe(false);
  });
});
