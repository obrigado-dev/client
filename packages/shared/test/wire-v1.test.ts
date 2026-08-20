/**
 * The v1 wire contract, frozen.
 *
 * These fixtures are what a client in the wild sends. They are checked in, not generated, and
 * they exist to fail loudly when somebody tightens a schema — because once the backend
 * deploys separately from the extensions, tightening is the one change that cannot be taken
 * back. §3 forbids silent auto-update and releases are signed, so an old client keeps sending
 * the old shape for as long as the developer leaves it installed.
 *
 * The cost of getting that wrong is not theoretical. `session_s` had a 24-hour bound; a real
 * session passed it; the beacon rejected the whole batch because it validates the request
 * rather than each event; and the client's queue poisoned itself and stopped billing
 * entirely, while the status line kept rotating as if nothing were wrong. In a monorepo that
 * was a one-commit fix. Across a population of installs it would have been revenue quietly
 * falling with nothing to correlate against.
 *
 * ## Adding to a fixture is fine; changing one is the question
 *
 * A new OPTIONAL field is a widening — old clients omit it, and their requests still parse.
 * Adding it here is right. Editing an existing fixture to make a test pass is the thing to
 * stop and think about: the fixture describes bytes already on disk somewhere, and they will
 * not change to suit the schema.
 *
 * Pre-launch this is advisory — see the note in the repo memory about breaking changes being
 * free until there are users. It stops being advisory the day something real installs.
 */
import { describe, expect, test } from "bun:test";

import { BeaconRequest, MAX_DURATION_S, SessionRequest } from "../src/contract.ts";

/**
 * The oldest session request shape that has ever shipped.
 *
 * Deliberately minimal: no `client_version`, no `agent_version`, no container signals. That
 * is what the very first client sent, and the server must keep accepting it — an install that
 * predates a field is still an install.
 */
const V1_SESSION_MINIMAL = {
  deps: [{ p: "npm:react", d: 0 }],
  private_repo: false,
  signals: { agent: "claude-code", os: "darwin" },
};

/** The same request from a current client: every signal populated. */
const V1_SESSION_FULL = {
  deps: [
    { p: "npm:react", d: 0 },
    { p: "pypi:fastapi", d: 2 },
  ],
  private_repo: true,
  signals: {
    ci: false,
    tty: true,
    display: true,
    docker: false,
    container: false,
    agent: "claude-code",
    agent_version: "2.1.4",
    client_version: "0.0.0",
    os: "darwin",
  },
};

const V1_BEACON_MINIMAL = {
  events: [
    {
      type: "impression",
      impression_id: "3e77498e-b9d0-4578-97f0-a512e8262ed2",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
    },
  ],
};

const V1_BEACON_FULL = {
  events: [
    {
      type: "impression",
      impression_id: "3e77498e-b9d0-4578-97f0-a512e8262ed2",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
      shown_at: "2026-07-31T09:00:00.000Z",
      dwell_ms: 30_000,
      signals: {
        timing: { session_s: 45, api_s: 2 },
        retrieved: ["npm:react"],
        interaction: "user_prompt",
      },
    },
    {
      type: "click",
      impression_id: "3e77498e-b9d0-4578-97f0-a512e8262ed2",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA==",
    },
  ],
};

describe("a v1 client's session request still parses", () => {
  test("the minimal shape, from before the signals existed", () => {
    const parsed = SessionRequest.safeParse(V1_SESSION_MINIMAL);
    expect(parsed.error?.message ?? "ok").toBe("ok");
  });

  test("the full shape, from a current client", () => {
    const parsed = SessionRequest.safeParse(V1_SESSION_FULL);
    expect(parsed.error?.message ?? "ok").toBe("ok");
  });

  test("a signal the client has never heard of does not break it", () => {
    // Forward compatibility in the other direction: a server that adds an optional signal
    // must not require it, or every install stops working the moment it deploys.
    const parsed = SessionRequest.safeParse({
      ...V1_SESSION_MINIMAL,
      signals: { ...V1_SESSION_MINIMAL.signals, some_future_signal: true },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("a v1 client's beacon still parses", () => {
  test("the minimal shape", () => {
    const parsed = BeaconRequest.safeParse(V1_BEACON_MINIMAL);
    expect(parsed.error?.message ?? "ok").toBe("ok");
  });

  test("the full shape, impression and click together", () => {
    const parsed = BeaconRequest.safeParse(V1_BEACON_FULL);
    expect(parsed.error?.message ?? "ok").toBe("ok");
  });
});

describe("the bounds a client can actually hit", () => {
  test("a session longer than a day is accepted", () => {
    // The exact value that broke billing. A 24-hour bound is a working day, not an agent
    // session, and an agent session left open over a weekend passes it without being
    // remotely suspicious.
    const twoDays = 2 * 24 * 60 * 60;
    expect(twoDays).toBeLessThanOrEqual(MAX_DURATION_S);

    const parsed = BeaconRequest.safeParse({
      events: [
        {
          ...V1_BEACON_MINIMAL.events[0],
          signals: { timing: { session_s: twoDays, api_s: 400 } },
        },
      ],
    });
    expect(parsed.error?.message ?? "ok").toBe("ok");
  });

  test("the client cannot construct a value above the bound", async () => {
    // The clamp is what makes the bound safe to have at all: whatever it is, the client
    // never sends past it, so a mismatch cannot poison a batch again.
    const api = await Bun.file(new URL("../../client/src/api.ts", import.meta.url).pathname).text();
    expect(api).toMatch(/Math\.min\(Math\.floor\(milliseconds \/ 1000\), MAX_DURATION_S\)/u);
  });
});

describe("every install can be identified", () => {
  test("the client reports its own version, distinctly from the host's", () => {
    // `agent_version` is the HOST's. Without a separate field there is no way to ask what
    // Obrigado version is deployed — which is the question every incident starts with once
    // the backend ships separately from the extensions.
    const parsed = SessionRequest.parse(V1_SESSION_FULL);
    expect(parsed.signals.client_version).toBe("0.0.0");
    expect(parsed.signals.agent_version).toBe("2.1.4");
    expect(parsed.signals.client_version).not.toBe(parsed.signals.agent_version);
  });

  test("the agent is not hardcoded in the client", async () => {
    // It was `agent: "claude-code"` as a literal. The moment a Codex client exists that
    // field lies, and it is the field that tells the two populations apart.
    const api = await Bun.file(new URL("../../client/src/api.ts", import.meta.url).pathname).text();
    const code = api.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/[^\n]*/gu, "");

    expect(code).not.toMatch(/agent:\s*"claude-code"/u);
    expect(code).toMatch(/agent:\s*context\.agent/u);
  });
});
