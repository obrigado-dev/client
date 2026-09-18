/**
 * `obrigado link github` (A31) — GitHub's device flow, driven from the terminal.
 *
 * As for email, what matters is the consent surface: the server's `publishes` sentence is printed
 * verbatim before anything is approved, `--no-list` really withholds consent, `--github` is
 * refused because the verified account IS the GitHub link, and every way the flow can end comes
 * out as a sentence with a next step. Since A33 an approved link also signs the install in, so
 * the session it hands over must be kept, shown, and removed with the link.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const BASE_CONFIG = { install_key: "test-key", api_origin: "http://api.test" };
let storedConfig: Record<string, unknown> = BASE_CONFIG;
let written: Array<Record<string, unknown>> = [];

const actualConfig = await import("../src/config.ts");
mock.module("../src/config.ts", () => ({
  ...actualConfig,
  readConfig: () => Promise.resolve(storedConfig),
  writeConfig: (config: Record<string, unknown>) => {
    written.push(config);
    return Promise.resolve();
  },
}));

const { link, unlink } = await import("../src/commands/link.ts");
const { linkGitHub } = await import("../src/commands/link-github.ts");
const { parseLinkArgs } = await import("../src/commands/link-args.ts");

type Responder = (path: string, body: Record<string, unknown>) => Response;

const FLOW = "a".repeat(43);
const PUBLISHES =
  "Your GitHub login and a link to its profile are listed on https://obrigado.dev/obrigado.";

let respond: Responder = () => new Response("{}", { status: 500 });
let requests: Array<{ path: string; body: Record<string, unknown> }> = [];
let lines: string[] = [];
let logSpy: ReturnType<typeof spyOn> | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  lines = [];
  storedConfig = BASE_CONFIG;
  written = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const path = String(input).replace("http://api.test/api/v1/link/", "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ path, body });
    return Promise.resolve(respond(path, body));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  logSpy?.mockRestore();
});

const output = (): string => lines.join("\n");
const noWait = { sleep: () => Promise.resolve() };
const flow = {
  config: { install_key: "test-key", api_origin: "http://api.test" },
  origin: "http://api.test",
  options: { apiOrigin: "http://api.test", installKey: "test-key" },
};

/** The server's answer to a start. A function: a Response body can only be read once. */
function started(): Response {
  return Response.json({
    status: "authorize",
    flow: FLOW,
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    expires_in_s: 900,
    interval_s: 5,
    publishes: PUBLISHES,
  });
}

const entry = {
  login: "ada",
  verified: true,
  listed: true,
  pending_review: false,
  qualified_this_period: false,
};

/** Answers start, then each poll in turn from `polls`. */
function server(polls: unknown[]): Responder {
  let index = 0;
  return (path) => {
    if (path === "github/start") return started();
    const next = polls[Math.min(index, polls.length - 1)];
    index += 1;
    return Response.json(next);
  };
}

describe("starting", () => {
  test("prints the server's sentence verbatim and where to type the code", async () => {
    respond = server([{ status: "linked", entry }]);

    const code = await linkGitHub(flow, parseLinkArgs([]), noWait);

    expect(code).toBe(0);
    expect(output()).toContain(`If you approve it: ${PUBLISHES}`);
    expect(output()).toContain("https://github.com/login/device");
    expect(output()).toContain("WDJB-MJHT");
    expect(requests[0]?.body).toEqual({ consent_listing: true });
  });

  test("--no-list withholds consent and says so instead of promising a listing", async () => {
    respond = server([{ status: "linked", entry: { ...entry, listed: false } }]);

    await linkGitHub(flow, parseLinkArgs(["--no-list"]), noWait);

    expect(requests[0]?.body).toEqual({ consent_listing: false });
    expect(output()).not.toContain(PUBLISHES);
  });

  test("the extras travel for review", async () => {
    respond = server([{ status: "linked", entry: { ...entry, pending_review: true } }]);

    await linkGitHub(flow, parseLinkArgs(["--name", "Ada L", "--x", "ada_l"]), noWait);

    expect(requests[0]?.body).toEqual({
      consent_listing: true,
      display_name: "Ada L",
      socials: { x: "ada_l" },
    });
    expect(output()).toContain("awaiting review");
  });

  test("--github is refused: the account signed in with is the GitHub link", async () => {
    const code = await link(["github", "--github", "someone-else"]);

    expect(code).toBe(1);
    expect(requests).toEqual([]);
    expect(output()).toContain("the account you sign in with is the GitHub link");
  });
});

describe("waiting", () => {
  test("keeps polling while pending, at the interval the server last gave", async () => {
    const slept: number[] = [];
    respond = server([
      { status: "pending", interval_s: 5 },
      { status: "pending", interval_s: 10 },
      { status: "linked", entry },
    ]);

    const code = await linkGitHub(flow, parseLinkArgs([]), {
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    expect(code).toBe(0);
    expect(slept).toEqual([5000, 5000, 10_000]);
    expect(requests.filter((request) => request.path === "github/poll")).toHaveLength(3);
    expect(requests.at(-1)?.body).toEqual({ flow: FLOW });
    expect(output()).toContain("@ada linked.");
  });

  test("a cancel on GitHub and an expired code each say what happened", async () => {
    respond = server([{ status: "denied" }]);
    expect(await linkGitHub(flow, parseLinkArgs([]), noWait)).toBe(1);
    expect(output()).toContain("Cancelled on GitHub");

    lines = [];
    respond = server([{ status: "expired" }]);
    expect(await linkGitHub(flow, parseLinkArgs([]), noWait)).toBe(1);
    expect(output()).toContain("Run `obrigado link github` again");
  });

  test("a server that cannot reach GitHub becomes a sentence, not a stack trace", async () => {
    respond = () => Response.json({ error: "github_unavailable" }, { status: 503 });

    expect(await linkGitHub(flow, parseLinkArgs([]), noWait)).toBe(1);
    expect(output()).toContain("GitHub linking isn't available right now");
  });
});

const SESSION = { token: "s".repeat(32), expires_at: "2027-09-17T12:00:00.000Z" };

describe("signing in (A33)", () => {
  test("an approved link keeps the session it was handed, and says so", async () => {
    // Read again before writing: a setting changed while the link waited must survive.
    storedConfig = { ...BASE_CONFIG, sharing: { region: true } };
    respond = server([{ status: "linked", entry, session: SESSION }]);

    expect(await linkGitHub(flow, parseLinkArgs([]), noWait)).toBe(0);
    expect(written).toEqual([
      {
        ...BASE_CONFIG,
        sharing: { region: true },
        developer_session: { token: SESSION.token, login: "ada", expires_at: SESSION.expires_at },
      },
    ]);
    expect(output()).toContain("signed in as @ada until 2027-09-17");
  });

  test("a server from before sign-in links without a session, and nothing is written", async () => {
    respond = server([{ status: "linked", entry }]);

    expect(await linkGitHub(flow, parseLinkArgs([]), noWait)).toBe(0);
    expect(written).toEqual([]);
  });

  test("unlinking the signed-in account removes its session from this install", async () => {
    storedConfig = {
      ...BASE_CONFIG,
      developer_session: { token: SESSION.token, login: "Ada", expires_at: SESSION.expires_at },
    };
    respond = () => Response.json({ unlinked: true });

    expect(await unlink(["github", "ada"])).toBe(0);
    expect(written).toEqual([BASE_CONFIG]);
  });

  test("unlinking another account leaves the session alone", async () => {
    storedConfig = {
      ...BASE_CONFIG,
      developer_session: { token: SESSION.token, login: "ada", expires_at: SESSION.expires_at },
    };
    respond = () => Response.json({ unlinked: true });

    expect(await unlink(["github", "ada-work"])).toBe(0);
    expect(written).toEqual([]);
  });

  test("the status table marks the account this install is signed in as", async () => {
    storedConfig = {
      ...BASE_CONFIG,
      developer_session: { token: SESSION.token, login: "ada", expires_at: SESSION.expires_at },
    };
    respond = () => status([entry, { ...entry, login: "ada-work" }]);

    expect(await link([])).toBe(0);
    expect(output()).toMatch(/@ada\s+github .*\(signed in here\)/u);
    expect(output()).not.toMatch(/@ada-work.*signed in here/u);
  });
});

/** The status endpoint's answer, with these GitHub accounts and no emails. */
function status(github: unknown[]): Response {
  return Response.json({ period: "2026-09-01", emails: [], github });
}

describe("unlinking", () => {
  test("with one account linked, no login is needed", async () => {
    respond = (path) => (path === "status" ? status([entry]) : Response.json({ unlinked: true }));

    expect(await unlink(["github"])).toBe(0);
    expect(requests.at(-1)).toEqual({ path: "github/unlink", body: { login: "ada" } });
  });

  test("with several, it asks which rather than guessing", async () => {
    respond = () => status([entry, { ...entry, login: "ada-work" }]);

    expect(await unlink(["github"])).toBe(1);
    expect(output()).toContain("@ada, @ada-work");
    expect(requests.some((request) => request.path === "github/unlink")).toBe(false);
  });

  test("a named login is taken as given, with or without its @", async () => {
    respond = () => Response.json({ unlinked: true });

    expect(await unlink(["github", "@ada-work"])).toBe(0);
    expect(requests).toEqual([{ path: "github/unlink", body: { login: "ada-work" } }]);
  });
});
