/**
 * The self-update (A38), against real files and a network that is faked at `fetch`.
 *
 * The claims, each asserted rather than reasoned about: nothing is replaced unless the download
 * matches the release's checksum and says it is the version the release claims; a failure leaves
 * the binary exactly as it was; one check a day; and the update is announced, never silent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClientConfig } from "../src/config.ts";
import { noticeForRender } from "../src/notice.ts";
import {
  CHECK_EVERY_MS,
  checksumFor,
  isNewer,
  parseVersion,
  readUpdateState,
  refreshIntegrations,
  runUpdate,
  scheduleUpdate,
  updateNotice,
  updatesItself,
  withUpdateLock,
} from "../src/self-update.ts";
import type { UpdateDeps } from "../src/self-update.ts";
import { signSums } from "../src/release-signature.ts";
import { CLIENT_VERSION } from "../src/version.ts";

const CONFIG: ClientConfig = { install_key: "k", api_origin: "https://obrigado.dev" };
const NEW_BINARY = new TextEncoder().encode("#!/bin/sh\necho the new one\n");
const DIGEST = createHash("sha256").update(NEW_BINARY).digest("hex");
const SUMS = `${"0".repeat(64)}  obrigado-linux-x64\n${DIGEST}  obrigado-darwin-arm64\n`;

/** A release key for these tests alone, standing in for the one compiled into a release. */
function releaseKey(): { readonly pem: string; readonly key: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    pem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    key: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}
const RELEASE = releaseKey();
const STRANGER = releaseKey();
const sign = (sums: string, pem = RELEASE.pem): string =>
  signSums(new TextEncoder().encode(sums), pem);

let dir: string;
let binary: string;
let statePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "obrigado-update-"));
  binary = join(dir, "obrigado");
  statePath = join(dir, "update.json");
  await writeFile(binary, "the old one", { mode: 0o755 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A `Response` as far as the update reads one: status, final URL and body. */
function reply(body: string | Uint8Array, url: string, ok = true): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok,
    url,
    json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
  } as Response;
}

/** GitHub, as the update sees it: the latest release, its asset, checksums and signature. */
function github(
  tag: string,
  overrides: {
    readonly asset?: Uint8Array;
    readonly sums?: string;
    readonly signature?: string | null;
    readonly host?: string;
  } = {},
): UpdateDeps["fetch"] {
  return (input) => {
    if (input.endsWith("/releases/latest")) {
      return Promise.resolve(reply(JSON.stringify({ tag_name: tag }), input));
    }
    const at = `${overrides.host ?? "https://objects.githubusercontent.com"}/${input.split("/").at(-1)}`;
    if (input.endsWith("/SHA256SUMS.sig")) {
      const signature =
        overrides.signature === undefined ? sign(overrides.sums ?? SUMS) : overrides.signature;
      return Promise.resolve(
        signature === null ? reply("Not Found", at, false) : reply(signature, at),
      );
    }
    if (input.endsWith("/SHA256SUMS")) return Promise.resolve(reply(overrides.sums ?? SUMS, at));
    return Promise.resolve(reply(overrides.asset ?? NEW_BINARY, at));
  };
}

function deps(fetchImpl: UpdateDeps["fetch"], reported = "0.9.0"): UpdateDeps {
  return {
    fetch: fetchImpl,
    target: "darwin-arm64",
    current: "0.3.0",
    binary,
    reportedVersion: () => Promise.resolve(`${reported}\n`),
    now: () => 1_000,
    statePath,
    keys: [RELEASE.key],
  };
}

async function leftovers(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.includes("obrigado-update"));
}

/** A start that must not happen. */
function neverStart(): void {
  throw new Error("started");
}

/** A network that is not there. */
function offline(): Promise<Response> {
  return Promise.reject(new Error("offline"));
}

/** A refresh that must not happen. */
function neverRefresh(): Promise<void> {
  return Promise.reject(new Error("refreshed"));
}

describe("versions", () => {
  test("are three numbers, with or without the tag's v", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.10.0")).toEqual([0, 10, 0]);
    expect(parseVersion("1.2.3-beta.1")).toBeNull();
    expect(parseVersion("surface-v0.3.0")).toBeNull();
  });

  test("compare as numbers, not as text", () => {
    expect(isNewer("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("v0.3.0", "0.3.0")).toBe(false);
    expect(isNewer("v0.2.9", "0.3.0")).toBe(false);
    expect(isNewer("not-a-version", "0.3.0")).toBe(false);
  });
});

describe("the checksum file", () => {
  test("gives the digest for exactly the asset asked for", () => {
    expect(checksumFor(SUMS, "obrigado-darwin-arm64")).toBe(DIGEST);
    expect(checksumFor(`${DIGEST} *obrigado-darwin-arm64`, "obrigado-darwin-arm64")).toBe(DIGEST);
    expect(checksumFor(SUMS, "obrigado-darwin")).toBeNull();
    expect(checksumFor("garbage\n", "obrigado-darwin-arm64")).toBeNull();
  });
});

describe("who updates", () => {
  test("a release binary, installed, with updates not turned off", () => {
    expect(updatesItself(CONFIG, "darwin-arm64")).toBe(true);
    expect(updatesItself({ ...CONFIG, auto_update: false }, "darwin-arm64")).toBe(false);
    expect(updatesItself(null, "darwin-arm64")).toBe(false);
  });

  test("never a checkout, which has no release to be", () => {
    expect(updatesItself(CONFIG, null)).toBe(false);
  });
});

describe("the daily check", () => {
  test("starts once a day, and records the time before it starts", async () => {
    let started = 0;
    const start = (): void => {
      started += 1;
    };
    const options = { now: 5_000, target: "darwin-arm64", path: statePath, start };

    expect(await scheduleUpdate(CONFIG, options)).toBe(true);
    expect((await readUpdateState(statePath)).checked_at).toBe(5_000);
    expect(await scheduleUpdate(CONFIG, { ...options, now: 5_000 + CHECK_EVERY_MS - 1 })).toBe(
      false,
    );
    expect(await scheduleUpdate(CONFIG, { ...options, now: 5_000 + CHECK_EVERY_MS })).toBe(true);
    expect(started).toBe(2);
  });

  test("never starts where the install does not update itself", async () => {
    expect(await scheduleUpdate(CONFIG, { target: null, path: statePath, start: neverStart })).toBe(
      false,
    );
    expect(
      await scheduleUpdate(
        { ...CONFIG, auto_update: false },
        { target: "darwin-arm64", path: statePath, start: neverStart },
      ),
    ).toBe(false);
  });
});

describe("an update", () => {
  test("replaces the binary with a download that matches its checksum and its version", async () => {
    const outcome = await runUpdate(deps(github("v0.9.0")));

    expect(outcome).toEqual({ status: "updated", from: "0.3.0", to: "0.9.0" });
    expect(await readFile(binary)).toEqual(Buffer.from(NEW_BINARY));
    expect(await readUpdateState(statePath)).toMatchObject({
      updated_to: "0.9.0",
      updated_at: 1_000,
    });
    expect(await leftovers()).toEqual([]);
  });

  test("does nothing when the latest release is this one", async () => {
    expect(await runUpdate(deps(github("v0.3.0")))).toEqual({
      status: "current",
      version: "0.3.0",
    });
    expect(await readFile(binary, "utf8")).toBe("the old one");
  });

  test("refuses a download whose checksum does not match, and leaves the binary alone", async () => {
    const tampered = new TextEncoder().encode("#!/bin/sh\necho something else\n");
    const outcome = await runUpdate(deps(github("v0.9.0", { asset: tampered })));

    expect(outcome.status).toBe("failed");
    expect(await readFile(binary, "utf8")).toBe("the old one");
    expect(await leftovers()).toEqual([]);
  });

  test("refuses a release that is not signed", async () => {
    const outcome = await runUpdate(deps(github("v0.9.0", { signature: null })));

    expect(outcome.status).toBe("failed");
    expect(await readFile(binary, "utf8")).toBe("the old one");
  });

  test("refuses checksums signed by a key this binary does not trust", async () => {
    const outcome = await runUpdate(
      deps(github("v0.9.0", { signature: sign(SUMS, STRANGER.pem) })),
    );

    expect(outcome.status).toBe("failed");
    expect(await readFile(binary, "utf8")).toBe("the old one");
  });

  test("refuses checksums that are not the ones that were signed", async () => {
    // A release whose binary and checksums were both swapped, with the old signature left beside
    // them: the checksums match the binary, and the signature is genuine, but not over these.
    const tampered = new TextEncoder().encode("#!/bin/sh\necho something else\n");
    const forged = `${createHash("sha256").update(tampered).digest("hex")}  obrigado-darwin-arm64\n`;
    const outcome = await runUpdate(
      deps(github("v0.9.0", { asset: tampered, sums: forged, signature: sign(SUMS) })),
    );

    expect(outcome.status).toBe("failed");
    expect(await readFile(binary, "utf8")).toBe("the old one");
  });

  test("refuses a release that publishes no checksum for this asset", async () => {
    const outcome = await runUpdate(
      deps(github("v0.9.0", { sums: `${DIGEST}  obrigado-linux-x64\n` })),
    );

    expect(outcome.status).toBe("failed");
    expect(await readFile(binary, "utf8")).toBe("the old one");
  });

  test("refuses a download that is not the version the release says", async () => {
    const outcome = await runUpdate(deps(github("v0.9.0"), "0.3.0"));

    expect(outcome.status).toBe("failed");
    expect(await readFile(binary, "utf8")).toBe("the old one");
    expect(await leftovers()).toEqual([]);
  });

  test("refuses anything that arrived over plain http", async () => {
    const outcome = await runUpdate(deps(github("v0.9.0", { host: "http://example.com" })));

    expect(outcome.status).toBe("failed");
    expect(await readFile(binary, "utf8")).toBe("the old one");
  });

  test("fails quietly when GitHub cannot be reached", async () => {
    expect((await runUpdate(deps(offline))).status).toBe("failed");
    expect(await readFile(binary, "utf8")).toBe("the old one");
  });
});

describe("the lock", () => {
  test("lets one run through at a time", async () => {
    const lock = join(dir, "update.lock");
    const gate = Promise.withResolvers<string>();
    const first = withUpdateLock(() => gate.promise, lock);
    await Bun.sleep(5);

    expect(await withUpdateLock(() => Promise.resolve("second"), lock)).toBeNull();
    gate.resolve("first");
    expect(await first).toBe("first");
    expect(await withUpdateLock(() => Promise.resolve("third"), lock)).toBe("third");
  });

  test("takes over a lock left by a run that died", async () => {
    const lock = join(dir, "update.lock");
    await writeFile(lock, "");
    const later = Date.now() + 11 * 60 * 1000;

    expect(await withUpdateLock(() => Promise.resolve("ran"), lock, later)).toBe("ran");
  });
});

describe("the announcement", () => {
  test("says so for a day after an update, as Obrigado's own notice", () => {
    const state = { updated_to: CLIENT_VERSION, updated_at: 1_000 };
    const notice = updateNotice(state, 1_000 + 60_000);

    expect(notice?.body).toContain(CLIENT_VERSION);
    expect(notice?.body).toContain("obrigado config auto_update false");
    expect(notice?.url.startsWith("https://")).toBe(true);
    expect(notice?.id.length).toBeLessThanOrEqual(32);
    expect(updateNotice(state, 1_000 + CHECK_EVERY_MS)).toBeNull();
  });

  test("takes the slot before anything the server sent", async () => {
    const served = { id: "server-news", body: "From the server", url: "https://obrigado.dev" };
    const updates = { updated_to: CLIENT_VERSION, updated_at: 1_000 };
    const ledger = join(dir, "notice.json");

    expect((await noticeForRender(served, 2_000, ledger, updates))?.id).toBe(
      `updated-${CLIENT_VERSION}`,
    );
    expect((await noticeForRender(served, 2_000, join(dir, "other.json"), {}))?.id).toBe(
      "server-news",
    );
  });

  test("is about this version only", () => {
    expect(updateNotice({ updated_to: "0.0.1", updated_at: 1_000 }, 2_000)).toBeNull();
    expect(updateNotice({}, 2_000)).toBeNull();
  });
});

describe("the host files a release carries", () => {
  test("are rewritten once per version, for the hosts this install put them in", async () => {
    const refreshed: string[] = [];
    const refresh = (host: string): Promise<void> => {
      refreshed.push(host);
      return Promise.resolve();
    };
    const config: ClientConfig = {
      ...CONFIG,
      integrations: { pi: { installed: true }, "oh-my-pi": { installed: false } },
    };
    const options = { target: "darwin-arm64", path: statePath, refresh };

    expect(await refreshIntegrations(config, {}, options)).toBe(true);
    expect(refreshed).toEqual(["pi"]);
    expect(await refreshIntegrations(config, await readUpdateState(statePath), options)).toBe(
      false,
    );
    expect(refreshed).toEqual(["pi"]);
  });

  test("repair OpenCode's entry, only where this install put one", async () => {
    let repairs = 0;
    const repairOpenCode = (): Promise<void> => {
      repairs += 1;
      return Promise.resolve();
    };
    const options = {
      target: "darwin-arm64",
      path: statePath,
      refresh: neverRefresh,
      repairOpenCode,
    };

    const off: ClientConfig = { ...CONFIG, integrations: { opencode: { installed: false } } };
    await refreshIntegrations(off, {}, options);
    expect(repairs).toBe(0);

    const on: ClientConfig = { ...CONFIG, integrations: { opencode: { installed: true } } };
    expect(await refreshIntegrations(on, {}, options)).toBe(true);
    expect(repairs).toBe(1);
    expect(await refreshIntegrations(on, await readUpdateState(statePath), options)).toBe(false);
    expect(repairs).toBe(1);
  });

  test("never from a checkout", async () => {
    expect(
      await refreshIntegrations(
        CONFIG,
        {},
        { target: null, path: statePath, refresh: neverRefresh },
      ),
    ).toBe(false);
  });
});
