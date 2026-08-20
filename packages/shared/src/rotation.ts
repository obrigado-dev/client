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
}

export function cacheFromResponse(response: SessionResponse, now = Date.now()): CachedBatch {
  return {
    fp: response.fp,
    batch: response.batch,
    serving: response.serving,
    fetched_at: now,
    expires_at: now + response.ttl_seconds * 1000,
    cursor: 0,
    shown_at: now,
    reported: [],
  };
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
