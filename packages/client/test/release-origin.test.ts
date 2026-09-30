/**
 * Where a released binary reports, and where a checkout does.
 *
 * `obrigado install` saves the origin it resolves, so a release that defaulted to localhost would
 * register every real install against nothing — and one that defaulted to production from source
 * would send a developer's local experiments to the live service. Both directions are checked by
 * bundling the config module the way each is built, rather than by reading the source.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { RELEASE_DEFINES } from "../src/release.ts";

const CONFIG = join(import.meta.dir, "../src/config.ts");

async function bundledDefault(define: Record<string, string>): Promise<string> {
  const built = await Bun.build({ entrypoints: [CONFIG], target: "bun", define });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const code = (await built.outputs[0]?.text()) ?? "";
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  )) as { DEFAULT_API_ORIGIN: string };
  return module.DEFAULT_API_ORIGIN;
}

describe("the default API origin", () => {
  test("a release build reports to production", async () => {
    expect(await bundledDefault(RELEASE_DEFINES)).toBe("https://obrigado.dev");
  });

  test("a checkout reports to the local stack", async () => {
    expect(await bundledDefault({})).toBe("http://localhost:3000");
  });
});
