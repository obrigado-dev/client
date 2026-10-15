/**
 * The repository the CLI keeps for the JetBrains IDEs (A43): the release's zip, fetched through
 * obrigado.dev and held to the signed checksums like the `.vsix`, beside a feed that names it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { localRepositoryUrl, prepareRepository } from "../src/jetbrains-repository.ts";
import type { RepositoryDeps } from "../src/jetbrains-repository.ts";
import { ORIGIN, pluginZip, release } from "./jetbrains-release.ts";
import type { ReleaseOptions } from "./jetbrains-release.ts";

let dir: string;

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "obrigado-jetbrains-repository-")), "jetbrains");
});

afterEach(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true });
});

function deps(options: ReleaseOptions = {}): { deps: RepositoryDeps; fetched: string[] } {
  const world = release(options);
  return {
    deps: {
      fetch: world.fetch,
      keys: world.keys,
      current: "0.3.9",
      origin: ORIGIN,
      repositoryDir: dir,
    },
    fetched: world.fetched,
  };
}

describe("the repository on this machine", () => {
  test("holds the release's zip, fetched through obrigado.dev, and a feed naming it", async () => {
    const { deps: here, fetched } = deps();

    expect(await prepareRepository(here)).toEqual({
      ok: true,
      url: localRepositoryUrl(dir),
      version: "0.4.0",
      fresh: true,
    });
    expect(fetched).toContain(`${ORIGIN}/jetbrains/download/0.4.0?via=cli`);
    expect(await readFile(join(dir, "obrigado-jetbrains-0.4.0.zip"), "utf8")).toBe(
      new TextDecoder().decode(pluginZip("0.4.0")),
    );
    const feed = await readFile(join(dir, "updatePlugins.xml"), "utf8");
    const zipUrl = pathToFileURL(join(dir, "obrigado-jetbrains-0.4.0.zip")).href;
    expect(feed).toContain(`<plugin id="dev.obrigado" url="${zipUrl}" version="0.4.0">`);
    expect(feed).toContain('<idea-version since-build="251"/>');
  });

  test("is given to the IDE as a file: URL", () => {
    expect(localRepositoryUrl("/home/dev/.obrigado/jetbrains")).toBe(
      "file:///home/dev/.obrigado/jetbrains/updatePlugins.xml",
    );
  });

  test("downloads nothing when it already holds the latest release", async () => {
    await prepareRepository(deps().deps);
    const { deps: again, fetched } = deps();

    expect(await prepareRepository(again)).toMatchObject({ ok: true, fresh: false });
    expect(fetched.some((url) => url.includes(".zip") || url.includes("/download/"))).toBe(false);
  });

  test("takes the next release in, and lets the older zip go", async () => {
    await prepareRepository(deps().deps);

    expect(await prepareRepository(deps({ version: "0.4.1" }).deps)).toMatchObject({
      ok: true,
      version: "0.4.1",
      fresh: true,
    });
    expect((await readdir(dir)).toSorted()).toEqual([
      "obrigado-jetbrains-0.4.1.zip",
      "updatePlugins.xml",
    ]);
  });

  test("refuses bytes the signed checksums do not describe, and writes nothing", async () => {
    const tampered = deps({ zip: new TextEncoder().encode("something else") });

    expect(await prepareRepository(tampered.deps)).toEqual({
      ok: false,
      reason: "checksum mismatch for obrigado-jetbrains-0.4.0.zip: not installed",
    });
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  test("refuses a release signed by a key it does not know", async () => {
    const { deps: here } = deps();

    expect(await prepareRepository({ ...here, keys: [] })).toEqual({
      ok: false,
      reason: "v0.4.0 is not signed by a release key: not installed",
    });
  });

  test("falls back to GitHub when obrigado.dev cannot answer", async () => {
    const { deps: here, fetched } = deps({ countingDown: true });

    expect((await prepareRepository(here)).ok).toBe(true);
    expect(fetched).toContain(
      "https://github.com/obrigado-dev/client/releases/download/v0.4.0/obrigado-jetbrains-0.4.0.zip",
    );
  });
});
