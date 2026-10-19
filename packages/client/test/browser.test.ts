import { describe, expect, test } from "bun:test";

import { BrowserClient } from "../src/browser.ts";
import type { BrowserStore } from "../src/browser.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const batch = (overrides = {}) => ({
  fp: "a".repeat(32),
  serving: true,
  ttl_seconds: 300,
  batch: [
    {
      impression_id: ID,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
      body: "A useful tool — example.com",
      click_url: "https://obrigado.dev/c/test",
      style: "default",
      effect: "none",
      spans: [],
      rev_micros: 3000,
      brand: null,
    },
  ],
  ...overrides,
});

function setup() {
  let saved: unknown;
  let now = 1_000_000;
  let offline = false;
  const calls: Array<{ url: string; body: unknown; key: string | null }> = [];
  const store: BrowserStore = {
    read: () => Promise.resolve(structuredClone(saved)),
    write: (value) => {
      saved = structuredClone(value);
      return Promise.resolve();
    },
  };
  const request = ((input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: JSON.parse(String(init?.body)),
      key: new Headers(init?.headers).get("X-Obrigado-Key"),
    });
    if (offline) return Promise.reject(new TypeError("offline"));
    return Promise.resolve(
      Response.json(url.endsWith("/session") ? batch() : { accepted: 1, rejected: 0 }),
    );
  }) as typeof fetch;
  const create = () => new BrowserClient(store, "0.1.0", request, () => now);
  return {
    client: create(),
    create,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    offline: (value: boolean) => {
      offline = value;
    },
  };
}

describe("browser client billing", () => {
  test("collects nothing until enabled; requests no page or provider information", async () => {
    const { client, calls } = setup();
    expect(await client.render()).toBeNull();
    expect(calls).toHaveLength(0);
    await client.configure(true);
    const line = await client.render();
    expect(line?.line.label).toBe("oss-sponsor");
    expect(calls[0]?.body).toEqual({ version: "0.1.0" });
    expect(calls[0]?.key?.length).toBeGreaterThan(16);
    expect(JSON.stringify(line)).not.toContain("nonce");
  });

  test("rendering alone sends no beacon, and only sufficient exposure confirms once", async () => {
    const { client, calls } = setup();
    await client.configure(true);
    await client.render();
    expect(await client.confirm(ID, 999, 0)).toBe(false);
    expect(await client.confirm(ID, 1000, 301)).toBe(false);
    await client.flush();
    expect(calls).toHaveLength(1);
    expect(await client.confirm(ID, 1000, 2)).toBe(true);
    expect(await client.confirm(ID, 1000, 2)).toBe(false);
    await client.flush();
    expect(calls[1]?.body).toMatchObject({
      events: [{ impression_id: ID, signals: { focused: true, input_age_s: 2 } }],
    });
    await client.flush();
    expect(calls).toHaveLength(2);
  });

  test("a confirmed last creative keeps its thirty-second hold", async () => {
    const { client, calls, advance } = setup();
    await client.configure(true);
    await client.render();
    await client.confirm(ID, 1000, 1);
    advance(2000);
    expect((await client.render())?.id).toBe(ID);
    expect(calls).toHaveLength(1);
    advance(28_000);
    await client.render();
    expect(calls).toHaveLength(2);
  });

  test("persists the queue across worker restarts and backs off while offline", async () => {
    const { client, create, calls, offline, advance } = setup();
    await client.configure(true);
    await client.render();
    await client.confirm(ID, 1000, 1);
    offline(true);
    await client.flush();
    const restarted = create();
    await restarted.flush();
    expect(calls).toHaveLength(2);
    offline(false);
    advance(2000);
    await restarted.flush();
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body).toEqual(calls[1]?.body);
    expect(await restarted.confirm(ID, 1000, 1)).toBe(false);
  });

  test("pausing drops queued beacons and prevents further requests", async () => {
    const { client, calls } = setup();
    await client.configure(true);
    await client.render();
    await client.confirm(ID, 1000, 1);
    await client.configure(false);
    await client.flush();
    expect(await client.render()).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
