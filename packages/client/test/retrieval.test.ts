/**
 * Retrieval capture (§14 Phase 6).
 *
 * The privacy boundary is the whole point of these tests. A file path like
 * `~/Code/acme-internal/billing/rates.ts` names a person, a company and a feature — strictly
 * more identifying than the dependency set §10.4 already treats as sensitive. So paths are
 * resolved to packages here, on the developer's machine, and a path that does not resolve to
 * a package is DROPPED rather than reported as "something in the project", because the
 * project is the private part.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drainRetrieval, MAX_QUEUED, packageOfPath, recordRead } from "../src/retrieval.ts";
import type { RetrievalLocation } from "../src/retrieval.ts";

/**
 * A temporary queue per test. These used to read and delete `RETRIEVAL_PATH` itself — the
 * developer's real queue under `~/.obrigado` — on every run of the suite.
 */
let dir: string;
let location: RetrievalLocation;
let queuePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "obrigado-retrieval-"));
  queuePath = join(dir, "retrieval.jsonl");
  location = { retrievalPath: queuePath };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("path resolution", () => {
  test("npm, plain", () => {
    expect(packageOfPath(join("proj", "node_modules", "react", "index.js"))).toBe("npm:react");
  });

  test("npm, scoped", () => {
    // Scoped names are a large fraction of npm, and the one the moderation checker's `\\b`
    // bug also missed.
    expect(packageOfPath(join("proj", "node_modules", "@types", "bun", "index.d.ts"))).toBe(
      "npm:@types/bun",
    );
  });

  test("npm, nested — the innermost package wins", () => {
    // A transitive dependency's own node_modules. The file belongs to the inner package.
    expect(
      packageOfPath(join("proj", "node_modules", "vite", "node_modules", "rollup", "dist.js")),
    ).toBe("npm:rollup");
  });

  test("cargo, with the version stripped", () => {
    expect(
      packageOfPath(join("home", ".cargo", "registry", "src", "index", "serde-1.0.203", "lib.rs")),
    ).toBe("cargo:serde");
  });

  test("cargo, a name containing digits survives", () => {
    // `base64-0.22.1` must not become `base` — only the trailing version group goes.
    expect(packageOfPath(join("registry", "src", "idx", "base64-0.22.1", "lib.rs"))).toBe(
      "cargo:base64",
    );
  });

  test("pypi, from site-packages", () => {
    expect(packageOfPath(join("venv", "lib", "site-packages", "requests", "api.py"))).toBe(
      "pypi:requests",
    );
  });

  test("pypi metadata directories are not packages", () => {
    // `requests-2.31.0.dist-info` is metadata about the package, not the package.
    expect(
      packageOfPath(join("venv", "lib", "site-packages", "requests-2.31.0.dist-info", "METADATA")),
    ).toBeNull();
  });

  test("go, from the module cache", () => {
    expect(
      packageOfPath(join("home", "go", "pkg", "mod", "github.com", "pkg", "errors@v0.9.1", "e.go")),
    ).toBe("go:github.com/pkg/errors");
  });

  test("everything is lowercased, so it matches a dependency set", () => {
    expect(packageOfPath(join("node_modules", "React", "index.js"))).toBe("npm:react");
  });
});

describe("the developer's own code is never reported", () => {
  test("a project source file resolves to nothing", () => {
    // The case that matters most. Reporting this as a package would report the private part
    // of their repository.
    expect(
      packageOfPath(join("Users", "amir", "Code", "acme-internal", "billing", "rates.ts")),
    ).toBeNull();
  });

  test("a path with no package marker resolves to nothing", () => {
    for (const path of ["", "/etc/passwd", "README.md", join("src", "index.ts"), "/"]) {
      expect(`${path} → ${packageOfPath(path)}`).toBe(`${path} → null`);
    }
  });

  test("a directory merely NAMED node_modules-ish is not a package root", () => {
    expect(packageOfPath(join("src", "node_modules_backup", "thing.ts"))).toBeNull();
  });

  test("an empty package segment resolves to nothing", () => {
    expect(packageOfPath(`${join("proj", "node_modules")}/`)).toBeNull();
  });
});

describe("the queue", () => {
  test("a read is recorded as a package id and nothing else", async () => {
    await recordRead(join("proj", "node_modules", "react", "index.js"), location);

    const text = await Bun.file(queuePath).text();
    expect(text.trim()).toBe(JSON.stringify({ p: "npm:react" }));
    // The path is nowhere in the file.
    expect(text).not.toContain("index.js");
    expect(text).not.toContain("proj");
  });

  test("an unresolvable path writes nothing at all", async () => {
    await recordRead(join("Users", "amir", "Code", "secret-project", "main.ts"), location);
    expect(await Bun.file(queuePath).exists()).toBe(false);
  });

  test("draining returns each package once, sorted", async () => {
    await recordRead(join("node_modules", "react", "a.js"), location);
    await recordRead(join("node_modules", "react", "b.js"), location);
    await recordRead(join("node_modules", "axios", "c.js"), location);

    expect(await drainRetrieval(location)).toEqual(["npm:axios", "npm:react"]);
  });

  test("draining clears the queue", async () => {
    // Otherwise the same reads would be reported against every subsequent impression,
    // inflating the multiplier for whatever the agent happened to open once.
    await recordRead(join("node_modules", "react", "a.js"), location);
    expect(await drainRetrieval(location)).toHaveLength(1);
    expect(await drainRetrieval(location)).toEqual([]);
  });

  test("draining an absent queue is empty rather than an error", async () => {
    expect(await drainRetrieval(location)).toEqual([]);
  });

  test("a truncated line from a concurrent append is skipped, not fatal", async () => {
    await recordRead(join("node_modules", "react", "a.js"), location);
    await Bun.write(queuePath, `${await Bun.file(queuePath).text()}{"p":"npm:half`);

    expect(await drainRetrieval(location)).toEqual(["npm:react"]);
  });

  test("a malformed entry without a namespace is rejected", async () => {
    await Bun.write(queuePath, `${JSON.stringify({ p: "not-a-package-id" })}\n`);
    expect(await drainRetrieval(location)).toEqual([]);
  });

  test("a pathological burst is capped rather than growing without limit", async () => {
    // The queue drains on every render, so this only bounds a burst between two renders — but
    // a file that grows without limit in ~/.obrigado is a bug a developer would rightly resent.
    const lines = Array.from({ length: MAX_QUEUED + 50 }, (_entry, index) =>
      JSON.stringify({ p: `npm:burst-${index}` }),
    ).join("\n");
    await Bun.write(queuePath, `${lines}\n`);

    expect((await drainRetrieval(location)).length).toBe(MAX_QUEUED);
  });

  test("an append that lands mid-drain is kept for the next drain", async () => {
    // The drain renames the file before reading it, so a hook appending at the same moment
    // writes into a fresh queue rather than into the one being consumed and truncated.
    await recordRead(join("node_modules", "react", "a.js"), location);
    const draining = drainRetrieval(location);
    await recordRead(join("node_modules", "axios", "c.js"), location);
    const first = await draining;
    const second = await drainRetrieval(location);
    expect([...first, ...second].toSorted()).toEqual(["npm:axios", "npm:react"]);
  });

  test("a queue nobody drains is reset rather than grown forever", async () => {
    const big = `${JSON.stringify({ p: "npm:filler" })}\n`.repeat(20_000);
    await Bun.write(queuePath, big);
    await recordRead(join("node_modules", "react", "a.js"), location);
    expect(await drainRetrieval(location)).toEqual(["npm:react"]);
  });
});
