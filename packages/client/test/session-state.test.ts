import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearSessionBatches,
  readSessionState,
  sessionStatePath,
  sessionStateSummary,
  writeSessionState,
} from "../src/session-state.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "obrigado-session-state-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("per-agent session state", () => {
  test("agent and session namespaces cannot consume one another", () => {
    const options = { stateDir: dir };
    expect(sessionStatePath("claude-code", "one", options)).not.toBe(
      sessionStatePath("codex", "one", options),
    );
    expect(sessionStatePath("codex", "one", options)).not.toBe(
      sessionStatePath("codex", "two", options),
    );
  });

  test("the local session id is hashed rather than exposed as a filename", () => {
    expect(sessionStatePath("codex", "private-session-name", { stateDir: dir })).not.toContain(
      "private-session-name",
    );
  });

  test("refresh clears batches but preserves pending confirmations", async () => {
    const pending = {
      item: {
        impression_id: "00000001-0000-4000-8000-000000000001",
        nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
        body: "copy",
        click_url: "https://obrigado.dev/c/token",
        style: "default" as const,
        effect: "none" as const,
        spans: [],
        brand: null,
        rev_micros: 3000,
      },
      shown_at: Date.now(),
      turn_id: "turn",
    };
    await writeSessionState(
      "codex",
      "one",
      {
        batch: {
          fp: "a".repeat(32),
          batch: [pending.item],
          serving: true,
          fetched_at: Date.now(),
          expires_at: Date.now() + 1000,
          cursor: 0,
          shown_at: Date.now(),
          reported: [pending.item.impression_id],
        },
        pending,
        updated_at: Date.now(),
      },
      { stateDir: dir },
    );

    expect(await clearSessionBatches({ stateDir: dir })).toBe(1);
    const state = await readSessionState("codex", "one", { stateDir: dir });
    expect(state.batch).toBeNull();
    expect(state.pending?.item.impression_id).toBe(pending.item.impression_id);
    expect(await sessionStateSummary({ stateDir: dir })).toEqual({
      sessions: 1,
      batches: 0,
      pending: 1,
    });
  });
});
