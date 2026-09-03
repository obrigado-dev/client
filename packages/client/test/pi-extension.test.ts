import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  installPiExtension,
  piExtensionTargets,
  sourceForHost,
  uninstallPiExtension,
} from "../src/pi-extension.ts";
import { rendererCommand } from "../src/renderer-command.ts";

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "obrigado-pi-"));
}

async function target(): Promise<{ dir: string; path: string; backups: string }> {
  const dir = await scratch();
  return { dir, path: join(dir, "extensions", "obrigado.ts"), backups: join(dir, "backups") };
}

describe("writing the extension", () => {
  test("creates the extensions directory and writes the file", async () => {
    const { path, backups } = await target();

    const outcome = await installPiExtension("pi", path, backups);

    expect(outcome.status).toBe("installed");
    expect(await readFile(path, "utf8")).toContain("Obrigado's Pi surface");
  });

  /*
   * The whole reason oh-my-pi is a separate install target: same code, different `--agent`, so
   * the impression attributes to the host that actually drew the line. A copy that shipped with
   * Pi's id would quietly bill oh-my-pi's inventory as Pi's.
   */
  test("rewrites the agent id for oh-my-pi and nothing else", async () => {
    const { path: piPath, backups: piBackups } = await target();
    const { path: ompPath, backups: ompBackups } = await target();

    await installPiExtension("pi", piPath, piBackups);
    await installPiExtension("oh-my-pi", ompPath, ompBackups);
    const pi = await readFile(piPath, "utf8");
    const omp = await readFile(ompPath, "utf8");

    expect(pi).toContain('const AGENT = "pi";');
    expect(omp).toContain('const AGENT = "oh-my-pi";');
    expect(omp.replace('const AGENT = "oh-my-pi";', 'const AGENT = "pi";')).toBe(pi);
  });

  /*
   * An extension that spawns a command the shell cannot find fails the quiet way — no line, no
   * error. A source checkout has no `obrigado` binary, so the installer bakes in the absolute
   * invocation, exactly as Claude Code's installer writes one into `settings.json`.
   */
  test("bakes in a runnable command when obrigado is not on PATH", async () => {
    const { path, backups } = await target();

    await installPiExtension("pi", path, backups);
    const written = await readFile(path, "utf8");

    expect(written).toContain(`const COMMAND = ${JSON.stringify(rendererCommand())};`);
    const command = rendererCommand().split(" ")[0] ?? "";
    expect(command === "obrigado" || (await Bun.file(command).exists())).toBe(true);
  });

  test("refuses a source whose agent marker is missing", () => {
    expect(() => sourceForHost('const AGENT = "something-else";', "oh-my-pi")).toThrow(
      /exactly once/u,
    );
  });

  /* A re-run of `obrigado install` should not deposit a backup of our own file every time. */
  test("is a no-op when the file is already ours and current", async () => {
    const { path, backups } = await target();
    await installPiExtension("pi", path, backups);

    const second = await installPiExtension("pi", path, backups);

    expect(second.status).toBe("already-installed");
    expect(await readdir(backups).catch(() => [])).toEqual([]);
  });

  test("backs up a file it replaces", async () => {
    const { path, backups } = await target();
    await installPiExtension("pi", path, backups);
    await writeFile(path, "// edited by the developer\n");

    const outcome = await installPiExtension("pi", path, backups);

    expect(outcome.status).toBe("installed");
    expect((await readdir(backups)).length).toBe(1);
  });
});

describe("removing the extension", () => {
  test("removes only a file it recognises as ours", async () => {
    const { path, backups } = await target();
    await installPiExtension("pi", path, backups);

    expect(await uninstallPiExtension("pi", path, backups)).toBe("removed");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  /*
   * A developer who replaced our copy with their own `obrigado.ts` keeps it. Deleting it would
   * be destroying their work to tidy up after ourselves, so "not installed" is the honest
   * report rather than a failure.
   */
  test("leaves a stranger's file of the same name alone", async () => {
    const { path, backups } = await target();
    await installPiExtension("pi", path, backups);
    await writeFile(path, "export default function () {}\n");

    expect(await uninstallPiExtension("pi", path, backups)).toBe("not-installed");
    expect(await Bun.file(path).exists()).toBe(true);
  });

  test("reports not-installed when there is nothing there", async () => {
    const { path, backups } = await target();

    expect(await uninstallPiExtension("pi", path, backups)).toBe("not-installed");
  });
});

/*
 * Both hosts read the SAME `PI_CODING_AGENT_DIR`, verified in oh-my-pi's shipped binary. When
 * it is set they resolve to one directory, and writing both would leave whichever ran last
 * billing for both.
 */
describe("when the shared override collapses both hosts into one directory", () => {
  test("keeps both when their directories differ", () => {
    expect(piExtensionTargets(["pi", "oh-my-pi"])).toEqual(["pi", "oh-my-pi"]);
  });

  test("keeps the host the developer named", () => {
    const previous = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = "/tmp/obrigado-pi-shared";
    try {
      expect(piExtensionTargets(["pi", "oh-my-pi"], "oh-my-pi")).toEqual(["oh-my-pi"]);
      expect(piExtensionTargets(["pi", "oh-my-pi"], "pi")).toEqual(["pi"]);
      expect(piExtensionTargets(["pi", "oh-my-pi"])).toEqual(["pi"]);
    } finally {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = previous;
    }
  });
});
