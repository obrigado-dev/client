import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  AGENT_LIVE_MS,
  agentSessionLive,
  clearSessionBatches,
  isEditorAgent,
  writeSessionState,
} from "../src/session-state.ts";
import type { Agent } from "../src/version.ts";

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "obrigado-live-"));
}

/** A state file for `agent`, last RENDERED `ageMs` ago. */
async function seed(dir: string, agent: Agent, ageMs: number): Promise<void> {
  await mkdir(join(dir, agent), { recursive: true });
  await Bun.write(
    join(dir, agent, `${agent}-session.json`),
    JSON.stringify({
      batch: null,
      last_render_at: Date.now() - ageMs,
      updated_at: Date.now() - ageMs,
    }),
  );
}

describe("which hosts must prove an agent is running", () => {
  test("editor hosts do, agent hosts do not", () => {
    expect(isEditorAgent("vscode")).toBe(true);
    expect(isEditorAgent("cursor")).toBe(true);
    expect(isEditorAgent("claude-code")).toBe(false);
    expect(isEditorAgent("opencode")).toBe(false);
  });
});

describe("is an agent session live", () => {
  test("a recent agent render counts", async () => {
    const dir = await scratch();
    await seed(dir, "claude-code", 1000);
    expect(await agentSessionLive(Date.now(), { stateDir: dir })).toBe(true);
  });

  test("any agent host counts, not just Claude", async () => {
    const dir = await scratch();
    await seed(dir, "opencode", 1000);
    expect(await agentSessionLive(Date.now(), { stateDir: dir })).toBe(true);
  });

  test("a stale render does not", async () => {
    const dir = await scratch();
    await seed(dir, "codex", AGENT_LIVE_MS + 60_000);
    expect(await agentSessionLive(Date.now(), { stateDir: dir })).toBe(false);
  });

  test("an editor host cannot vouch for itself", async () => {
    // The failure that would make the whole gate meaningless: if an editor surface's own
    // state counted as evidence, its first render would qualify every render after it and
    // the question would answer itself forever.
    const dir = await scratch();
    await seed(dir, "vscode", 1000);
    await seed(dir, "cursor", 1000);
    expect(await agentSessionLive(Date.now(), { stateDir: dir })).toBe(false);
  });

  test("an editor host beside a live agent does count — via the agent", async () => {
    const dir = await scratch();
    await seed(dir, "vscode", 1000);
    await seed(dir, "claude-code", 1000);
    expect(await agentSessionLive(Date.now(), { stateDir: dir })).toBe(true);
  });

  test("no state at all is not live", async () => {
    expect(await agentSessionLive(Date.now(), { stateDir: await scratch() })).toBe(false);
  });

  test("unreadable state is not evidence", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "claude-code"), { recursive: true });
    await Bun.write(join(dir, "claude-code", "broken.json"), "{ not json");
    expect(await agentSessionLive(Date.now(), { stateDir: dir })).toBe(false);
  });

  test("state written through the real writer is seen", async () => {
    // Guards the coupling between where state is WRITTEN and where liveness READS it. A
    // change to the path layout that broke this would silently disable editor surfaces.
    const dir = await scratch();
    await writeSessionState(
      "claude-code",
      "a-session",
      { batch: null, last_render_at: Date.now(), updated_at: Date.now() },
      {
        stateDir: dir,
      },
    );
    expect(await agentSessionLive(Date.now(), { stateDir: dir })).toBe(true);
  });

  test("a write that is not a render does not count", async () => {
    // `updated_at` is stamped by every writer. Reading it made a file touched by a
    // maintenance write look like a running agent, and an editor surface then billed for
    // five minutes with nothing running.
    const dir = await scratch();
    await writeSessionState(
      "claude-code",
      "a-session",
      { batch: null, updated_at: Date.now() },
      { stateDir: dir },
    );
    expect(await agentSessionLive(Date.now(), { stateDir: dir })).toBe(false);
  });

  test("`obrigado refresh` clearing a dead session's batch does not revive it", async () => {
    const dir = await scratch();
    const stale = Date.now() - AGENT_LIVE_MS - 60_000;
    await writeSessionState(
      "claude-code",
      "old-session",
      {
        batch: {
          fp: "f".repeat(32),
          batch: [],
          serving: true,
          fetched_at: stale,
          expires_at: stale,
          cursor: 0,
          shown_at: stale,
          reported: [],
        },
        last_render_at: stale,
        updated_at: stale,
      },
      { stateDir: dir },
    );

    expect(await clearSessionBatches({ stateDir: dir })).toBe(1);
    expect(await agentSessionLive(Date.now(), { stateDir: dir })).toBe(false);
  });

  test("state written by an older client, with no render stamp, fails closed", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "claude-code"), { recursive: true });
    await Bun.write(
      join(dir, "claude-code", "legacy.json"),
      JSON.stringify({ batch: null, updated_at: Date.now() }),
    );
    expect(await agentSessionLive(Date.now(), { stateDir: dir })).toBe(false);
  });
});
