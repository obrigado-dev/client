/**
 * `obrigado link` — the command through which the wall's one identity is created.
 *
 * What these pin down is the consent surface, not the transport: the server's
 * `publishes` sentence is printed VERBATIM before a code is entered, `--no-list`
 * really sends `consent_listing: false`, and every failure the server can
 * report comes out as a sentence with a next step rather than a bare error code.
 *
 * Config is mocked at the module boundary (`config.ts` resolves `~/.obrigado`
 * from `homedir()` at import time — see beacon.test.ts for the scar), and fetch
 * is routed by URL so each test states the server's answer inline.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

let storedConfig: Record<string, unknown> | null = {
  install_key: "test-key",
  api_origin: "http://api.test",
};
const writes: Array<Record<string, unknown>> = [];

// Everything except the two functions under test keeps its real behaviour —
// `commands/shared.ts` and `statusline.ts` import paths from this module too.
const actualConfig = await import("../src/config.ts");
mock.module("../src/config.ts", () => ({
  ...actualConfig,
  readConfig: () => Promise.resolve(storedConfig),
  writeConfig: (next: Record<string, unknown>) => {
    writes.push(next);
    storedConfig = next;
    return Promise.resolve();
  },
}));

const { link, unlink } = await import("../src/commands/link.ts");

type Responder = (path: string, body: Record<string, unknown>) => Response;

let respond: Responder = () => new Response("{}", { status: 500 });
let requests: Array<{ path: string; body: Record<string, unknown> }> = [];

const realFetch = globalThis.fetch;
let lines: string[] = [];
let logSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  storedConfig = { install_key: "test-key", api_origin: "http://api.test" };
  writes.length = 0;
  requests = [];
  lines = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  // Typed off `fetch` itself rather than naming `RequestInfo`, which is a DOM lib type this
  // package does not pull in — the client runs in Bun, not a browser.
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const path = url.replace("http://api.test/api/v1/link/", "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ path, body });
    return Promise.resolve(respond(path, body));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  logSpy?.mockRestore();
});

function output(): string {
  return lines.join("\n");
}

const CODE_SENT = {
  status: "code_sent",
  entity_kind: "company",
  publishes: "acme.com appears on this month's page.",
  expires_in_s: 600,
};

describe("requesting a code", () => {
  test("prints the server's publishes sentence verbatim and stashes the email", async () => {
    respond = () => Response.json(CODE_SENT);

    const exit = await link(["dev@acme.com"]);

    expect(exit).toBe(0);
    // The one promise the CLI must not paraphrase is what gets published.
    expect(output()).toContain("acme.com appears on this month's page.");
    expect(requests[0]?.body["consent_listing"]).toBe(true);
    expect(writes[0]?.["pending_link_email"]).toBe("dev@acme.com");
  });

  test("--no-list sends consent_listing false and says the email is never published", async () => {
    respond = () => Response.json(CODE_SENT);

    await link(["dev@acme.com", "--no-list"]);

    expect(requests[0]?.body["consent_listing"]).toBe(false);
    expect(output()).toContain("never published");
    expect(output()).not.toContain("appears on this month's page");
  });

  test("--name and --url ride along for an individual", async () => {
    respond = () => Response.json({ ...CODE_SENT, entity_kind: "individual" });

    await link(["ada@gmail.com", "--name", "Ada L", "--url", "https://ada.dev"]);

    expect(requests[0]?.body["display_name"]).toBe("Ada L");
    expect(requests[0]?.body["url"]).toBe("https://ada.dev");
  });

  test("a feature-flagged-off server produces a sentence, not a mystery", async () => {
    respond = () => Response.json({ error: "feature_disabled" }, { status: 404 });

    const exit = await link(["dev@acme.com"]);

    expect(exit).toBe(1);
    expect(output()).toContain("doesn't have email linking enabled yet");
  });

  test("offline degrades to could-not-reach", async () => {
    respond = () => {
      throw new Error("ECONNREFUSED");
    };

    const exit = await link(["dev@acme.com"]);

    expect(exit).toBe(1);
    expect(output()).toContain("Could not reach http://api.test");
  });
});

describe("confirming", () => {
  const CONFIRMED = {
    linked: true,
    entry: {
      email: "dev@acme.com",
      entity_kind: "company",
      verified: true,
      listed: true,
      pending_review: false,
      qualified_this_period: false,
    },
  };

  test("uses the stashed pending email and clears it on success", async () => {
    storedConfig = { ...storedConfig, pending_link_email: "dev@acme.com" };
    respond = () => Response.json(CONFIRMED);

    const exit = await link(["--code", "123456"]);

    expect(exit).toBe(0);
    expect(requests[0]?.body["email"]).toBe("dev@acme.com");
    expect(writes.at(-1)).not.toContainKey("pending_link_email");
  });

  test("without a stash it asks which email rather than guessing", async () => {
    const exit = await link(["--code", "123456"]);

    expect(exit).toBe(1);
    expect(requests).toHaveLength(0);
    expect(output()).toContain("Which email?");
  });

  test("an expired code names its next step", async () => {
    storedConfig = { ...storedConfig, pending_link_email: "dev@acme.com" };
    respond = () => Response.json({ error: "code_expired" }, { status: 400 });

    const exit = await link(["--code", "123456"]);

    expect(exit).toBe(1);
    expect(output()).toContain("Request a new one");
  });

  test("a malformed code is refused locally, before any request", async () => {
    const exit = await link(["--code", "12345"]);

    expect(exit).toBe(1);
    expect(requests).toHaveLength(0);
  });
});

describe("unlink and argument problems", () => {
  test("unlink requires a plausible email", async () => {
    const exit = await unlink(["not-an-email"]);

    expect(exit).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("unlink reports the removal promise", async () => {
    respond = () => Response.json({ unlinked: true });

    const exit = await unlink(["dev@acme.com"]);

    expect(exit).toBe(0);
    expect(output()).toContain("Unlinked");
  });

  test("an unknown flag fails with usage instead of being silently ignored", async () => {
    const exit = await link(["dev@acme.com", "--nolist"]);

    expect(exit).toBe(1);
    expect(requests).toHaveLength(0);
    expect(output()).toContain("unknown flag --nolist");
  });
});
