/**
 * `obrigado update`: the self-update, on demand or from a render in the background (A38).
 *
 * A developer runs it to update now, whatever the day's check said; a render runs it with
 * `--background`, which prints nothing and always exits 0, because nobody is there to read it.
 * Either way it is the same `runUpdate`, behind the same lock.
 */
import { realpath } from "node:fs/promises";

import { readConfig } from "../config.ts";
import { releaseTarget, runUpdate, withUpdateLock } from "../self-update.ts";
import { CLIENT_VERSION } from "../version.ts";
import { refreshEditors } from "./install-editors.ts";

/** What a downloaded binary says it is, for `runUpdate` to check before swapping it in. */
async function reportedVersion(path: string): Promise<string> {
  const proc = Bun.spawn([path, "version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 15_000,
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

export async function update(argv: readonly string[]): Promise<number> {
  const background = argv.includes("--background");
  const target = releaseTarget();
  if (target === null) {
    if (!background) {
      console.log("This is not a release binary, so it does not update itself.");
      console.log(
        "A checkout updates with git; https://obrigado.dev/install.sh installs a release.",
      );
    }
    return background ? 0 : 1;
  }

  const outcome = await withUpdateLock(async () => {
    const updated = await runUpdate({
      fetch: (input, init) => fetch(input, init),
      target,
      current: CLIENT_VERSION,
      binary: await realpath(process.execPath),
      reportedVersion,
    });
    // A sideloaded extension does not update itself (A40): the newest release's goes in after the
    // binary, in each editor this install put it in, and is skipped where it is already current.
    await refreshEditors(await readConfig(), background ? () => {} : (line) => console.log(line));
    return updated;
  });
  if (background) return 0;

  if (outcome === null) {
    console.log("Another update is already running.");
    return 0;
  }
  switch (outcome.status) {
    case "current":
      console.log(`Already current: ${outcome.version}.`);
      return 0;
    case "updated":
      console.log(`Updated ${outcome.from} → ${outcome.to}.`);
      return 0;
    case "failed":
      console.error(`Not updated: ${outcome.reason}.`);
      return 1;
  }
}

/** `obrigado version`: the number, alone, which is what the self-update reads back. */
export function version(): Promise<number> {
  console.log(CLIENT_VERSION);
  return Promise.resolve(0);
}
