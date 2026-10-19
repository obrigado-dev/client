/** The browser build of the client. No Node imports and no host DOM access. */
import { z } from "zod";
import {
  ATTENTION_WINDOW_S,
  BeaconRequestSchema,
  NONCE_TTL_SECONDS,
  SessionResponseSchema,
  WEBSITE_VIEWABLE_MS,
} from "@obrigado/shared";
import type { BeaconEvent } from "@obrigado/shared";
import {
  cacheFromResponse,
  isExhausted,
  isExpired,
  markReported,
  ROTATE_AFTER_MS,
  selectCreative,
} from "@obrigado/shared/rotation";
import type { CachedBatch } from "@obrigado/shared/rotation";

import { copyParts } from "./copy-parts.ts";
import { SPONSOR_LABEL } from "./disclosure.ts";
import { stripControlCharacters } from "./text.ts";

// MV3 forbids eval, including zod's optional JIT compiler.
z.config({ jitless: true });

export { ATTENTION_WINDOW_S, WEBSITE_VIEWABLE_MS };

export interface BrowserStore {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

interface QueuedEvent {
  readonly at: number;
  readonly event: BeaconEvent;
}

interface BrowserState {
  enabled: boolean;
  key: string;
  batch: CachedBatch | null;
  queue: QueuedEvent[];
  retryAfter: number;
  beaconAfter: number;
  failures: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function restore(value: unknown): BrowserState {
  const state: BrowserState = {
    enabled: false,
    key: crypto.randomUUID() + crypto.randomUUID(),
    batch: null,
    queue: [],
    retryAfter: 0,
    beaconAfter: 0,
    failures: 0,
  };
  if (!record(value)) return state;
  state.enabled = value["enabled"] === true;
  if (typeof value["key"] === "string" && value["key"].length >= 16) state.key = value["key"];
  for (const field of ["retryAfter", "beaconAfter", "failures"] as const) {
    const number = value[field];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) state[field] = number;
  }
  const raw = value["batch"];
  if (record(raw)) {
    const parsed = SessionResponseSchema.safeParse({ ...raw, ttl_seconds: 1 });
    const validTimes = ["fetched_at", "expires_at", "shown_at", "cursor"].every(
      (field) => typeof raw[field] === "number" && Number.isFinite(raw[field]) && raw[field] >= 0,
    );
    if (parsed.success && validTimes && Number.isInteger(raw["cursor"])) {
      state.batch = {
        ...cacheFromResponse(parsed.data),
        fetched_at: raw["fetched_at"] as number,
        expires_at: raw["expires_at"] as number,
        shown_at: raw["shown_at"] as number,
        cursor: raw["cursor"] as number,
        reported: Array.isArray(raw["reported"])
          ? raw["reported"].filter((id): id is string => typeof id === "string")
          : [],
      };
    }
  }
  if (Array.isArray(value["queue"])) {
    for (const queued of value["queue"].slice(-500)) {
      if (!record(queued) || typeof queued["at"] !== "number") continue;
      const parsed = BeaconRequestSchema.safeParse({ events: [queued["event"]] });
      const event = parsed.success ? parsed.data.events[0] : undefined;
      if (event !== undefined) state.queue.push({ at: queued["at"], event });
    }
  }
  return state;
}

/** Serialised in the worker; queue and reported nonces are persisted in one atomic value. */
export class BrowserClient {
  private state: BrowserState | undefined;
  private readonly store: BrowserStore;
  private readonly version: string;
  private readonly request: (url: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly origin: string;

  constructor(
    store: BrowserStore,
    version: string,
    request: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
      globalThis.fetch(url, init),
    now: () => number = Date.now,
    origin = "https://obrigado.dev",
  ) {
    this.store = store;
    this.version = version;
    this.request = request;
    this.now = now;
    this.origin = origin;
  }

  private async load(): Promise<BrowserState> {
    this.state ??= restore(await this.store.read());
    return this.state;
  }

  async enabled(): Promise<boolean> {
    return (await this.load()).enabled;
  }

  async configure(enabled: boolean): Promise<void> {
    const state = await this.load();
    state.enabled = enabled;
    if (!enabled) {
      state.batch = null;
      state.queue = [];
    }
    await this.store.write(state);
  }

  private post(path: string, state: BrowserState, body: unknown): Promise<Response> {
    return this.request(`${this.origin}/api/v1/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Obrigado-Key": state.key },
      body: JSON.stringify(body),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(4_000),
    });
  }

  async render() {
    const state = await this.load();
    if (!state.enabled) return null;
    const now = this.now();
    let changed = false;
    if (
      state.batch === null ||
      isExpired(state.batch, now) ||
      (isExhausted(state.batch) && now - state.batch.shown_at >= ROTATE_AFTER_MS)
    ) {
      if (now < state.retryAfter) return null;
      state.batch = null;
      // Persist the backoff before the network call, including across worker termination.
      state.retryAfter = now + 60_000;
      await this.store.write(state);
      try {
        const response = await this.post("browser/session", state, { version: this.version });
        const parsed = response.ok ? SessionResponseSchema.safeParse(await response.json()) : null;
        if (parsed?.success === true) {
          state.batch = cacheFromResponse(parsed.data, this.now());
          state.retryAfter = 0;
          changed = true;
        }
      } catch {
        // Offline: the host renders nothing and retries after the backoff.
      }
    }
    const before = state.batch?.shown_at;
    const rotation = state.batch === null ? null : selectCreative(state.batch, this.now());
    if (changed || before !== state.batch?.shown_at) await this.store.write(state);
    if (rotation === null || state.batch === null) return null;
    const item = rotation.item;
    let target: URL;
    try {
      target = new URL(item.click_url);
    } catch {
      return null;
    }
    if (target.origin !== this.origin || !target.pathname.startsWith("/c/")) return null;
    const parts = copyParts(item);
    return {
      id: item.impression_id,
      expiresAt: state.batch.expires_at,
      line: {
        label: SPONSOR_LABEL,
        copy: stripControlCharacters(item.body),
        url: target.href,
        ...parts,
      },
    };
  }

  async confirm(id: string, dwellMs: number, inputAgeS: number): Promise<boolean> {
    const state = await this.load();
    const now = this.now();
    if (
      !state.enabled ||
      !Number.isFinite(dwellMs) ||
      dwellMs < WEBSITE_VIEWABLE_MS ||
      !Number.isFinite(inputAgeS) ||
      inputAgeS < 0 ||
      inputAgeS > ATTENTION_WINDOW_S
    )
      return false;
    const batch = state.batch;
    if (batch === null || isExpired(batch, now) || batch.reported.includes(id)) return false;
    const item = batch.batch[batch.cursor % batch.batch.length];
    if (item?.impression_id !== id) return false;
    const event: BeaconEvent = {
      type: "impression",
      impression_id: id,
      nonce: item.nonce,
      dwell_ms: Math.min(86_400_000, Math.floor(dwellMs)),
      signals: { focused: true, input_age_s: Math.floor(inputAgeS) },
    };
    state.queue = [...state.queue, { at: now, event }].slice(-500);
    markReported(batch, id);
    await this.store.write(state);
    return true;
  }

  async flush(): Promise<void> {
    const state = await this.load();
    const now = this.now();
    if (!state.enabled || now < state.beaconAfter) return;
    state.queue = state.queue.filter((queued) => now - queued.at < NONCE_TTL_SECONDS * 1000);
    if (state.queue.length === 0) return;
    try {
      const response = await this.post("beacon", state, {
        events: state.queue.map((q) => q.event),
      });
      const permanent =
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429;
      if (response.ok || permanent) {
        state.queue = [];
        state.failures = 0;
        state.beaconAfter = 0;
      } else this.deferBeacon(state, now);
    } catch {
      this.deferBeacon(state, now);
    }
    await this.store.write(state);
  }

  private deferBeacon(state: BrowserState, now: number): void {
    state.failures = Math.min(state.failures + 1, 6);
    state.beaconAfter = now + Math.min(60_000, 1_000 * 2 ** state.failures);
  }
}
