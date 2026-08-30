/**
 * Local creative rotation shared by every rendering surface.
 *
 * A fetched batch is delivery authority: each item carries the nonce that makes one rendered
 * impression count exactly once. Keeping the cache and cursor rules here means a status line
 * and the website cannot quietly disagree about expiry, exhaustion, or hold time.
 */
import { ROTATION_SECONDS } from "./contract.ts";
import type { BatchItem, SessionResponse } from "./contract.ts";

/** One creative holds long enough to be read and to satisfy an exposure threshold. */
export const ROTATE_AFTER_MS = ROTATION_SECONDS * 1000;

export interface CachedBatch {
  readonly fp: string;
  readonly batch: readonly BatchItem[];
  readonly serving: boolean;
  readonly fetched_at: number;
  readonly expires_at: number;
  cursor: number;
  /** When the current creative took the surface. Rotation is time-based. */
  shown_at: number;
  /** Impression ids already reported, so a re-render does not re-count. */
  reported: string[];
  /**
   * What the agent had been reading when this batch was chosen, as a stable digest.
   *
   * Activity targeting selects on recently-read packages, and a batch is rotated locally for
   * `BATCH_TTL_SECONDS` — so without this, an agent that opened the Postgres docs one minute
   * after fetching kept seeing the previous fifteen minutes' ads. The signal was live and the
   * inventory was not.
   *
   * Absent on a batch fetched with activity sharing off, where retrieval is not sent and
   * therefore cannot have influenced anything.
   */
  retrieval?: string | undefined;
}

/**
 * A stable digest of the packages an agent has been reading.
 *
 * Sorted and joined rather than hashed: the set is small, the comparison is for equality only,
 * and a readable value in `~/.obrigado/batch.json` is worth more than eight saved bytes to
 * somebody trying to work out why their line changed.
 */
export function retrievalDigest(packages: readonly string[] | undefined): string | undefined {
  return packages === undefined ? undefined : packages.toSorted().join(",");
}

export function cacheFromResponse(
  response: SessionResponse,
  now = Date.now(),
  retrieval?: string | undefined,
): CachedBatch {
  return {
    fp: response.fp,
    batch: response.batch,
    serving: response.serving,
    fetched_at: now,
    expires_at: now + response.ttl_seconds * 1000,
    cursor: 0,
    shown_at: now,
    reported: [],
    ...(retrieval === undefined ? {} : { retrieval }),
  };
}

/**
 * The shortest a batch may live before a changed activity signal can replace it.
 *
 * A status line renders many times a second while an agent works, and an agent reading files
 * changes the retrieval set constantly — so "refetch whenever it changed" is a request per
 * render. A minute bounds that to roughly one extra request per minute in the worst case,
 * while still making the signal live in any sense a developer would notice.
 */
export const ACTIVITY_REFETCH_FLOOR_MS = 60_000;

/**
 * Whether what the agent is reading has moved on from what this batch was chosen for.
 *
 * The other half of `isExpired` and `isExhausted`, and the reason activity targeting is worth
 * anything: those two ask whether the batch is old or used up, and this asks whether it is
 * still ABOUT the right thing. Without it the ads a developer sees describe what they were
 * doing up to fifteen minutes ago.
 *
 * Returns false when the batch carries no digest — a batch fetched with activity sharing off
 * was not selected on retrieval, so retrieval changing cannot make it wrong.
 */
export function activityMoved(
  batch: CachedBatch,
  retrieval: string | undefined,
  now = Date.now(),
): boolean {
  if (batch.retrieval === undefined || retrieval === undefined) return false;
  if (retrieval === batch.retrieval) return false;
  return now - batch.fetched_at >= ACTIVITY_REFETCH_FLOOR_MS;
}

export function isExpired(batch: CachedBatch, now = Date.now()): boolean {
  return now >= batch.expires_at;
}

/**
 * Whether every creative in the batch has already been reported.
 *
 * An exhausted batch could still render, but doing so would display paid inventory for free.
 * It is therefore a refetch trigger independent of the TTL.
 */
export function isExhausted(batch: CachedBatch): boolean {
  return batch.batch.length > 0 && batch.reported.length >= batch.batch.length;
}

export interface Rotation {
  readonly item: BatchItem;
  /** False when this nonce has already been reported as an impression. */
  readonly fresh: boolean;
}

/**
 * Select the current creative without claiming that it rendered.
 *
 * Persistent status lines call `nextCreative`, which selects and reports in one step. Browser
 * placements use this lower-level half so they can wait for actual viewability before marking
 * the nonce reported.
 */
export function selectCreative(batch: CachedBatch, now = Date.now()): Rotation | null {
  if (!batch.serving || batch.batch.length === 0 || isExpired(batch, now)) return null;

  const held = now - (batch.shown_at ?? 0);
  if (held >= ROTATE_AFTER_MS) {
    batch.cursor = (batch.cursor + 1) % batch.batch.length;
    batch.shown_at = now;
  }

  const item = batch.batch[batch.cursor % batch.batch.length];
  if (item === undefined) return null;
  return { item, fresh: !batch.reported.includes(item.impression_id) };
}

/** Mark one nonce reported, idempotently. */
export function markReported(batch: CachedBatch, impressionId: string): void {
  if (!batch.reported.includes(impressionId)) batch.reported.push(impressionId);
}

/** Select and immediately report a creative for a persistent host-owned surface. */
export function nextCreative(batch: CachedBatch, now = Date.now()): Rotation | null {
  const rotation = selectCreative(batch, now);
  if (rotation?.fresh === true) markReported(batch, rotation.item.impression_id);
  return rotation;
}

/**
 * Select one never-before-reported creative for an ephemeral surface.
 *
 * Each completed turn needs its own nonce even when turns finish inside the normal hold window.
 */
export function nextFreshCreative(batch: CachedBatch, now = Date.now()): Rotation | null {
  if (!batch.serving || batch.batch.length === 0 || isExpired(batch, now)) return null;

  for (let offset = 0; offset < batch.batch.length; offset += 1) {
    const cursor = (batch.cursor + offset) % batch.batch.length;
    const item = batch.batch[cursor];
    if (item !== undefined && !batch.reported.includes(item.impression_id)) {
      batch.cursor = cursor;
      batch.shown_at = now;
      markReported(batch, item.impression_id);
      return { item, fresh: true };
    }
  }
  return null;
}
